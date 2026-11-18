import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { detectAiPolicyText } from "../src/brief/aipolicy.js";
import { analyzeRepo } from "../src/brief/analyze.js";
import { extractRules } from "../src/brief/rules.js";
import { runRepoChecks } from "../src/flow/ci.js";
import { diffLineCount } from "../src/flow/workspace.js";
import { isDependencyBump } from "../src/tasks/issues.js";
import { tmpLedger } from "./helpers.js";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "contribot-audit-"));
}

describe("audit: AI policy negations", () => {
  const file = (text: string) => [{ path: "CONTRIBUTING.md", text }];

  it("negated positives classify as banned", () => {
    for (const line of [
      "AI tools are not permitted in this repository.",
      "AI is not welcome here.",
      "LLM use is not acceptable for contributions.",
    ]) {
      expect(detectAiPolicyText(file(line)).verdict, line).toBe("banned");
    }
  });

  it("double negatives do not classify as banned", () => {
    for (const line of [
      "We're not against AI-assisted PRs.",
      "We do not prohibit AI tooling.",
      "There are no restrictions on AI usage.",
    ]) {
      const v = detectAiPolicyText(file(line)).verdict;
      expect(v, line).not.toBe("banned");
    }
  });

  it("plural LLMs detected; explicit welcome is welcomed", () => {
    expect(detectAiPolicyText(file("LLMs are welcome for drafting PRs.")).verdict).toBe("welcomed");
  });

  it("plain ban still banned", () => {
    expect(detectAiPolicyText(file("We do not accept AI-generated contributions.")).verdict).toBe("banned");
  });
});

describe("audit: rules parser", () => {
  it("does not mark testsRequired on 'require' without a test context", async () => {
    const root = tmpRoot();
    writeFileSync(
      join(root, "CONTRIBUTING.md"),
      [
        "# Contributing",
        "We require contributors to be respectful and patient.",
        "An issue is not required for small fixes.",
        "No CLA is required.",
        "You do not need to sign the CLA.",
        "Never commit secrets or credentials.",
      ].join("\n"),
    );
    const map = await analyzeRepo(root);
    const rules = extractRules(root, map);
    expect(rules.testsRequired).toBe(false);
    expect(rules.requiresCLA).toBe(false);
    expect(rules.issueRequired).toBe(false);
  });

  it("still detects a real test requirement", async () => {
    const root = tmpRoot();
    writeFileSync(join(root, "CONTRIBUTING.md"), "All pull requests must include tests.\n");
    const rules = extractRules(root, await analyzeRepo(root));
    expect(rules.testsRequired).toBe(true);
  });
});

describe("audit: analyzeRepo robustness", () => {
  it("survives malformed package.json", async () => {
    const root = tmpRoot();
    writeFileSync(join(root, "package.json"), "{ not json !!!");
    const map = await analyzeRepo(root);
    expect(map.languages).toBeDefined();
  });

  it("survives BOM-prefixed package.json", async () => {
    const root = tmpRoot();
    writeFileSync(join(root, "package.json"), '﻿{"name":"bom","devDependencies":{"vitest":"*"},"scripts":{"test":"vitest"}}');
    const map = await analyzeRepo(root);
    expect(map.testSetup.runner).toBe("vitest");
  });
});

describe("audit: ledger open-PR accounting", () => {
  it("pr_outcome resolves the opened ref", () => {
    const { ledger } = tmpLedger();
    ledger.record("pr_opened", "acme/widgets", "#7", {});
    expect(ledger.openPrCount("acme/widgets")).toBe(1);
    expect(ledger.unresolvedOpenedRefs("acme/widgets")).toEqual(["#7"]);
    ledger.record("pr_outcome", "acme/widgets", "#7", { outcome: "closed" });
    expect(ledger.openPrCount("acme/widgets")).toBe(0);
    expect(ledger.unresolvedOpenedRefs("acme/widgets")).toEqual([]);
    expect(ledger.lastOutcome("acme/widgets")?.detail).toContain("closed");
  });
});

describe("audit: diff counting includes untracked files", () => {
  it("new file added by patch counts toward the cap", async () => {
    const root = tmpRoot();
    const git = simpleGit(root);
    await git.init();
    await git.addConfig("user.email", "t@t");
    await git.addConfig("user.name", "t");
    writeFileSync(join(root, "a.txt"), "one\n");
    await git.add("-A").commit("init");
    writeFileSync(join(root, "b-new-file.txt"), "x\n".repeat(500));
    writeFileSync(join(root, "a.txt"), "one\ntwo\n");
    const lines = await diffLineCount(root);
    expect(lines).toBeGreaterThanOrEqual(501);
  });
});

describe("audit: dependency-bump detection", () => {
  it("catches version bumps without a dependencies label", () => {
    expect(isDependencyBump({ ...mk("Bump actions/checkout from 3 to 4"), labels: [] })).toBe(true);
    expect(isDependencyBump({ ...mk("upgrade vite to 5"), labels: [] })).toBe(true);
    expect(isDependencyBump({ ...mk("Improve README wording"), labels: [] })).toBe(false);
  });
});

function mk(title: string) {
  return {
    number: 1,
    title,
    body: null,
    html_url: "x",
    created_at: new Date().toISOString(),
    labels: [] as { name: string }[],
    user: { login: "u" },
  };
}

describe("audit: repo checks", () => {
  it("skips install when node_modules exists and reports pass", async () => {
    const root = tmpRoot();
    mkdirSync(join(root, "node_modules"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "x", scripts: { test: "exit 0" } }));
    const run = await runRepoChecks(root, null);
    expect(run.passed).toBe(true);
    expect(run.commands.map((c) => c.cmd)).toEqual(["npm test"]);
  });

  it("failing test marks the run failed", async () => {
    const root = tmpRoot();
    mkdirSync(join(root, "node_modules"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "x", scripts: { test: "exit 1" } }));
    const run = await runRepoChecks(root, null);
    expect(run.passed).toBe(false);
  });
});

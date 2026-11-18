import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { analyzeRepo } from "../src/brief/analyze.js";
import { detectAiPolicy } from "../src/brief/aipolicy.js";
import { extractRules } from "../src/brief/rules.js";
import { renderBrief, type Brief } from "../src/brief/render.js";
import { FIXTURES, REF } from "./helpers.js";

describe("T-C1: scout brief on repo with CONTRIBUTING.md", () => {
  it("extracts rules, detects test runner and AI-policy verdict", async () => {
    const root = join(FIXTURES, "friendly");
    const map = await analyzeRepo(root);
    const rules = extractRules(root, map);
    const aiPolicy = detectAiPolicy(root, map);

    expect(map.testSetup.runner).toBe("vitest");
    expect(map.testSetup.command).toContain("npm test");
    expect(map.files.contributing).toBe("CONTRIBUTING.md");
    expect(map.files.prTemplate).toBe(".github/pull_request_template.md");
    expect(map.ciChecks.length).toBe(1);
    expect(map.ciChecks[0].commands).toContain("npm test");

    expect(rules.items.length).toBeGreaterThan(3);
    expect(rules.requiresDCO).toBe(true);
    expect(rules.conventionalCommits).toBe(true);
    expect(rules.testsRequired).toBe(true);
    expect(rules.issueRequired).toBe(true);

    expect(aiPolicy.verdict).toBe("unmentioned");

    const brief: Brief = {
      ref: REF,
      generatedAt: "t",
      map,
      rules,
      aiPolicy,
      signals: {
        sampledClosedPrs: 0,
        mergeRate: null,
        medianHoursToFirstReply: null,
        externalPrsAnswered: null,
        goodFirstIssueCount: 4,
        helpWantedCount: 2,
        notes: [],
      },
    };
    const md = renderBrief(brief);
    expect(md).toContain("## Contribution rules");
    expect(md).toContain("## AI policy");
    expect(md).toContain("UNMENTIONED");
    expect(md).toContain("vitest");
    expect(md).toContain("npm test");
  });
});

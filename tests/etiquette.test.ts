import { describe, expect, it } from "vitest";
import { runChecks } from "../src/checks/engine.js";
import { ctx, makeIssue, issueTask, tmpLedger, AI_BANNED, AI_UNMENTIONED } from "./helpers.js";

describe("T-C2: etiquette engine refuses a second PR when one is open", () => {
  it("blocks with named rules when ledger has an open PR", () => {
    const { ledger } = tmpLedger();
    ledger.record("pr_opened", "acme/widgets", "#7", { url: "x" });
    ledger.record("pr_opened", "other/repo", "#8", { url: "y" });
    const res = runChecks(ctx({ task: issueTask(makeIssue(9, { labels: ["bug"] })) }, ledger));
    expect(res.status).toBe("block");
    const names = res.results.filter((r) => r.status === "block").map((r) => r.rule);
    expect(names).toContain("max-open-prs-per-repo");
    expect(names).toContain("max-prs-per-day");
  });

  it("force flag downgrades the block to warn and marks it overridden", () => {
    const { ledger } = tmpLedger();
    ledger.record("pr_opened", "acme/widgets", "#7", {});
    const res = runChecks(ctx({ task: issueTask(makeIssue(9, { labels: ["bug"] })) }, ledger), ["--force-open-prs"]);
    const rule = res.results.find((r) => r.rule === "max-open-prs-per-repo")!;
    expect(rule.status).toBe("warn");
    expect(rule.overridden).toBe(true);
    expect(res.overrides).toContain("max-open-prs-per-repo");
  });

  it("cooldown blocks within 14d of a rejected PR", () => {
    const { ledger } = tmpLedger();
    ledger.record("pr_outcome", "acme/widgets", "#7", { outcome: "rejected" });
    const res = runChecks(ctx({ task: issueTask(makeIssue(9, { labels: ["bug"] })) }, ledger));
    const rule = res.results.find((r) => r.rule === "repo-cooldown")!;
    expect(rule.status).toBe("block");
  });
});

describe("T-C3: CONTRIBUTING that bans AI → hard stop, no override", () => {
  it("blocks and exposes no override flag", () => {
    const { ledger } = tmpLedger();
    const res = runChecks(
      ctx({ task: issueTask(makeIssue(1, { labels: ["good first issue"] })), aiPolicy: AI_BANNED }, ledger),
      ["--force-open-prs", "--force-no-issue"],
    );
    expect(res.status).toBe("block");
    const rule = res.results.find((r) => r.rule === "ai-policy")!;
    expect(rule.status).toBe("block");
    expect(rule.overrideFlag).toBeUndefined();
    expect(res.overrides).toHaveLength(0);
  });
});

describe("other checks", () => {
  it("passes clean when an issue task is legit and nothing is open", () => {
    const { ledger } = tmpLedger();
    const res = runChecks(
      ctx(
        {
          task: issueTask(makeIssue(3, { labels: ["good first issue"] })),
          aiPolicy: AI_UNMENTIONED,
          diffLines: 120,
          ciRan: true,
          ciPassed: true,
        },
        ledger,
      ),
    );
    expect(res.status).toBe("pass");
  });

  it("blocks diff over cap without --allow-large", () => {
    const { ledger } = tmpLedger();
    const res = runChecks(ctx({ task: issueTask(makeIssue(3, { labels: ["bug"] })), diffLines: 900 }, ledger));
    expect(res.results.find((r) => r.rule === "diff-size-cap")!.status).toBe("block");
    const res2 = runChecks(
      ctx({ task: issueTask(makeIssue(3, { labels: ["bug"] })), diffLines: 900, allowLarge: true }, ledger),
    );
    expect(res2.results.find((r) => r.rule === "diff-size-cap")!.status).toBe("warn");
  });

  it("blocks PR body missing the disclosure line", () => {
    const { ledger } = tmpLedger();
    const res = runChecks(
      ctx({ task: issueTask(makeIssue(3, { labels: ["bug"] })), prBody: "no disclosure here" }, ledger),
    );
    expect(res.results.find((r) => r.rule === "disclosure")!.status).toBe("block");
  });

  it("blocks pushing to upstream", () => {
    const { ledger } = tmpLedger();
    const res = runChecks(
      ctx({ task: issueTask(makeIssue(3, { labels: ["bug"] })), remoteIsUpstream: true }, ledger),
    );
    expect(res.results.find((r) => r.rule === "fork-safety")!.status).toBe("block");
  });
});

describe("unsafe limits", () => {
  it("relaxed daily cap passes but stays loudly marked", () => {
    const { ledger } = tmpLedger();
    ledger.record("pr_opened", "a/x", "#1", {});
    ledger.record("pr_opened", "b/y", "#2", {});
    ledger.record("pr_opened", "c/z", "#3", {});
    const c = ctx(
      { task: issueTask(makeIssue(4, { labels: ["bug"] })), relaxedLimits: ["maxPrsPerDay"] },
      ledger,
    );
    c.limits.maxPrsPerDay = 10;
    const res = runChecks(c);
    const rule = res.results.find((r) => r.rule === "max-prs-per-day")!;
    expect(rule.status).toBe("pass");
    expect(rule.reason).toContain("relaxed above default");
  });
});

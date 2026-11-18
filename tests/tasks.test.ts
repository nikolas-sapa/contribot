import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { analyzeRepo } from "../src/brief/analyze.js";
import { evaluateIssueList, isDependencyBump, pickIssue, scoreIssue } from "../src/tasks/index.js";
import { FIXTURES, makeIssue } from "./helpers.js";

describe("T-C4: dependabot present + dependency-only issue → rejected", () => {
  it("rejects the bump outright", async () => {
    const depBot = await analyzeRepo(join(FIXTURES, "depbot"));
    expect(depBot.files.dependabot).toBe(true);
    const issue = makeIssue(12, { title: "bump lodash from 4.17.20 to 4.17.21", labels: ["dependencies"] });
    expect(isDependencyBump(issue)).toBe(true);
    const s = scoreIssue(issue, { depBotPresent: depBot.files.dependabot });
    expect(s.rejected).toMatch(/dependabot|renovate/);
    expect(pickIssue([s])).toBeNull();
  });
});

describe("T-C6: no qualifying issues → no task", () => {
  it("returns null for unlabeled, fresh, unmaintained issues", () => {
    const issues = [
      makeIssue(1, { title: "weird crash sometimes" }),
      makeIssue(2, { title: "question about api" }),
    ];
    const scored = evaluateIssueList(issues, false);
    expect(pickIssue(scored)).toBeNull();
  });

  it("maintainer-filed issue qualifies on its own (they want it fixed)", () => {
    const maint = makeIssue(7, { title: "we need this", authorAssociation: "MEMBER" });
    const outsider = makeIssue(8, { title: "please add x", authorAssociation: "NONE" });
    const scored = evaluateIssueList([outsider, maint], false);
    const best = pickIssue(scored);
    expect(best?.issue.number).toBe(7);
    expect(best?.maintainerFiled).toBe(true);
  });

  it("picks the maintainer-requested issue first", () => {
    const stale = makeIssue(5, {
      title: "old bug",
      labels: ["bug"],
      createdAt: new Date(Date.now() - 200 * 86.4e6).toISOString(),
    });
    const gfi = makeIssue(6, { title: "starter task", labels: ["good first issue"] });
    const scored = evaluateIssueList([stale, gfi], false);
    const best = pickIssue(scored);
    expect(best?.issue.number).toBe(6);
  });
});

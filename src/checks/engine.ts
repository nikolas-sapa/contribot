import type { CheckContext, CheckResult } from "./types.js";
import { DISCLOSURE_LINE } from "./types.js";

type Rule = (ctx: CheckContext) => CheckResult;

const ok = (rule: string, reason: string, overrideFlag?: string): CheckResult => ({
  rule,
  status: "pass",
  reason,
  overrideFlag,
});
const warn = (rule: string, reason: string, overrideFlag?: string): CheckResult => ({
  rule,
  status: "warn",
  reason,
  overrideFlag,
});
const block = (rule: string, reason: string, overrideFlag?: string): CheckResult => ({
  rule,
  status: "block",
  reason,
  overrideFlag,
});

export const RULES: Rule[] = [
  function maxOpenPrsPerRepo(ctx) {
    const name = "max-open-prs-per-repo";
    const ledgerOpen = ctx.ledger.openPrCount(ctx.ref.full);
    const apiOpen = ctx.openPrsInRepo ?? 0;
    const open = Math.max(ledgerOpen, apiOpen);
    if (open >= ctx.limits.maxOpenPrsPerRepo) {
      return block(name, `you already have ${open} open PR(s) on ${ctx.ref.full} (limit ${ctx.limits.maxOpenPrsPerRepo}) — land or close it first`, "--force-open-prs");
    }
    return ok(name, `${open} open PR(s) on ${ctx.ref.full}`);
  },

  function maxPrsPerDay(ctx) {
    const name = "max-prs-per-day";
    const since = new Date(Date.now() - 24 * 3.6e6).toISOString();
    const today = ctx.ledger.prsOpenedSince(since);
    if (today >= ctx.limits.maxPrsPerDay) {
      return block(name, `${today} PR(s) opened in the last 24h (limit ${ctx.limits.maxPrsPerDay}) — slow down`, "--force-daily-cap");
    }
    return ok(name, `${today} PR(s) in last 24h`);
  },

  function repoCooldown(ctx) {
    const name = "repo-cooldown";
    const last = ctx.ledger.lastOutcome(ctx.ref.full);
    if (!last) return ok(name, "no prior closed/rejected PR on this repo");
    const elapsedDays = (Date.now() - new Date(last.ts).getTime()) / 86.4e6;
    if (elapsedDays < ctx.limits.cooldownDays) {
      const left = Math.ceil(ctx.limits.cooldownDays - elapsedDays);
      return block(name, `last PR on ${ctx.ref.full} was closed/rejected ${Math.floor(elapsedDays)}d ago — cooldown ${left}d remaining`, "--force-cooldown");
    }
    return ok(name, `cooldown satisfied (${Math.floor(elapsedDays)}d since last close)`);
  },

  function aiPolicy(ctx) {
    const name = "ai-policy";
    if (!ctx.aiPolicy) return warn(name, "AI policy not checked (no brief) — disclosure line still enforced");
    if (ctx.aiPolicy.verdict === "banned") {
      return block(name, `${ctx.ref.full} bans AI contributions per its docs — hard stop, no override`, undefined);
    }
    if (ctx.aiPolicy.verdict === "ambiguous") {
      return warn(name, "ambiguous AI policy detected — proceed carefully, disclosure enforced");
    }
    return ok(name, `AI policy: ${ctx.aiPolicy.verdict}`);
  },

  function linkedIssue(ctx) {
    const name = "linked-issue";
    if (!ctx.limits.requireLinkedIssue) return ok(name, "linked-issue requirement relaxed by config");
    if (!ctx.task) return block(name, "no contribution target selected");
    if (ctx.task.kind === "issue" && ctx.task.issue) return ok(name, `linked to issue #${ctx.task.issue.number}`);
    if (ctx.task.kind === "trivial") return ok(name, "marked trivial/typo-class via --trivial");
    if (ctx.task.kind === "defect" && ctx.task.defectEvidence) {
      return warn(name, `defect without an issue — evidence: ${ctx.task.defectEvidence}`, "--force-no-issue");
    }
    return block(name, "PRs must reference an open issue (or pass --trivial for typo-class fixes)", "--force-no-issue");
  },

  function diffSize(ctx) {
    const name = "diff-size-cap";
    if (ctx.diffLines === null) return ok(name, "diff size not yet known (checked again before PR)");
    if (ctx.diffLines > ctx.limits.diffSizeCap && !ctx.allowLarge) {
      return block(name, `diff is ${ctx.diffLines} lines (cap ${ctx.limits.diffSizeCap}) — split it or pass --allow-large`, "--allow-large");
    }
    if (ctx.diffLines > ctx.limits.diffSizeCap) {
      return warn(name, `diff is ${ctx.diffLines} lines — over cap but --allow-large given`);
    }
    return ok(name, `diff ${ctx.diffLines} lines ≤ ${ctx.limits.diffSizeCap}`);
  },

  function issueLegitimacy(ctx) {
    const name = "issue-legitimacy";
    if (ctx.task?.kind !== "issue" || !ctx.task.issue) return ok(name, "n/a (not an issue task)");
    const issue = ctx.task.issue;
    const labels = issue.labels.map((l) => l.name.toLowerCase());
    const legit = ["good first issue", "help wanted", "bug", "docs", "documentation", "tests", "good-first-issue"];
    if (labels.some((l) => legit.includes(l))) {
      return ok(name, `issue #${issue.number} labeled ${labels.filter((l) => legit.includes(l)).join(", ")}`);
    }
    if (ctx.task.maintainerFiled) {
      return ok(name, `issue #${issue.number} was filed by a maintainer`);
    }
    if (ctx.task.maintainerRequested) {
      return ok(name, `issue #${issue.number} has a maintainer comment requesting help`);
    }
    const ageDays = (Date.now() - new Date(issue.created_at).getTime()) / 86.4e6;
    if (ageDays > ctx.limits.issueAgeDays) {
      return warn(name, `issue #${issue.number} is ${Math.floor(ageDays)}d old with no qualifying label — double-check it isn't claimed`);
    }
    const reason = `issue #${issue.number} has no qualifying label and is ${Math.floor(ageDays)}d old — likely not up for grabs`;
    return ctx.limits.issueLegitimacy === "block" ? block(name, reason, "--force-legitimacy") : warn(name, reason);
  },

  function maintainerRequested(ctx) {
    const name = "maintainer-requested";
    if (ctx.task?.maintainerRequested) {
      return ok(name, "maintainer explicitly requested help — this contribution ranks first");
    }
    return ok(name, "no maintainer request signal");
  },

  function ciParity(ctx) {
    const name = "ci-parity";
    if (!ctx.limits.ciParity) return ok(name, "ci-parity relaxed by config");
    if (ctx.ciRan === null) return warn(name, "repo checks not run yet — `pr` will run them and block on failure");
    if (ctx.ciRan && ctx.ciPassed === false) {
      return block(name, "repo's own lint/test FAILED locally — do not open this PR");
    }
    if (ctx.ciRan && ctx.ciPassed) return ok(name, "repo lint/test passed locally");
    return ok(name, "no runnable checks detected in repo");
  },

  function disclosure(ctx) {
    const name = "disclosure";
    if (!ctx.prBody) return ok(name, "disclosure line will be appended to PR body at creation (non-removable)");
    if (ctx.prBody.includes(DISCLOSURE_LINE)) return ok(name, "AI-assistance disclosure present in PR body");
    return block(name, "PR body is missing the mandatory AI-assistance disclosure line", undefined);
  },

  function forkSafety(ctx) {
    const name = "fork-safety";
    if (ctx.remoteIsUpstream) {
      return block(name, "refusing to push to the upstream repo — contribot only pushes to your fork, never force-pushes, never touches others' branches", undefined);
    }
    return ok(name, "push target is your fork; no force-push; own branch only");
  },
];

export type EngineResult = {
  status: "pass" | "warn" | "block";
  results: CheckResult[];
};

const OVERRIDE_TO_RULE: Record<string, string> = {
  "--force-open-prs": "max-open-prs-per-repo",
  "--force-daily-cap": "max-prs-per-day",
  "--force-cooldown": "repo-cooldown",
  "--force-no-issue": "linked-issue",
  "--allow-large": "diff-size-cap",
  "--force-legitimacy": "issue-legitimacy",
};

export function runChecks(ctx: CheckContext, forceFlags: string[] = []): EngineResult & { overrides: string[] } {
  const results = RULES.map((r) => r(ctx));
  const overrides: string[] = [];
  for (const res of results) {
    if (res.status !== "block" || !res.overrideFlag) continue;
    const flag = res.overrideFlag;
    const matches = forceFlags.includes(flag) || forceFlags.includes(OVERRIDE_TO_RULE[flag] ?? "");
    if (matches) {
      res.status = "warn";
      res.overridden = true;
      res.reason += ` [OVERRIDDEN via ${flag} — logged to ledger]`;
      overrides.push(res.rule);
    }
  }
  const status = results.some((r) => r.status === "block")
    ? "block"
    : results.some((r) => r.status === "warn")
      ? "warn"
      : "pass";
  return { status, results, overrides };
}

import type { GhComment, GhIssue } from "../github.js";
import type { TaskCandidate } from "../checks/types.js";

const GOOD_LABELS = ["good first issue", "help wanted", "good-first-issue"];
const MID_LABELS = ["bug", "docs", "documentation", "tests", "test", "help"];
const DEP_RE = /\b(bump|update|upgrade|migrate)\b.{0,30}\b(dependenc|dep\b|deps\b|package|npm|version|from \d|to \d)/i;
const MAINTAINER = ["MEMBER", "OWNER", "COLLABORATOR"];

export function isMaintainerFiled(issue: GhIssue): boolean {
  return MAINTAINER.includes(issue.author_association ?? "");
}

export type ScoredIssue = {
  issue: GhIssue;
  score: number;
  reasons: string[];
  maintainerRequested: boolean;
  maintainerFiled: boolean;
  dependencyLike: boolean;
  rejected?: string;
};

export function isDependencyBump(issue: GhIssue): boolean {
  const labels = issue.labels.map((l) => l.name.toLowerCase());
  if (labels.includes("dependencies") || labels.includes("dependency")) return true;
  return DEP_RE.test(issue.title) || (issue.body ? DEP_RE.test(issue.body.slice(0, 500)) : false);
}

export function maintainerRequestedHelp(comments: GhComment[]): boolean {
  return comments.some(
    (c) =>
      ["MEMBER", "OWNER", "COLLABORATOR"].includes(c.author_association) &&
      /\b(pr welcome|pull request welcome|want to (fix|work|take)|feel free to (fix|submit|open)|contributions? welcome|help welcome|up for grabs|happy to (review|accept)|would (accept|take|review) a (pr|fix|patch))\b/i.test(
        c.body,
      ),
  );
}

export function scoreIssue(
  issue: GhIssue,
  opts: { comments?: GhComment[]; depBotPresent: boolean },
): ScoredIssue {
  const labels = issue.labels.map((l) => l.name.toLowerCase());
  const reasons: string[] = [];
  let score = 0;
  const mr = opts.comments ? maintainerRequestedHelp(opts.comments) : false;
  const mf = isMaintainerFiled(issue);
  const depLike = isDependencyBump(issue);

  if (depLike && opts.depBotPresent) {
    return {
      issue,
      score: -Infinity,
      reasons: [],
      maintainerRequested: mr,
      maintainerFiled: mf,
      dependencyLike: true,
      rejected: "dependency-only issue and repo already has dependabot/renovate — a bot owns this",
    };
  }
  if (depLike) {
    score -= 50;
    reasons.push("looks like a dependency bump");
  }
  if (mf) {
    score += 60;
    reasons.push("filed by a maintainer — they want it fixed");
  }
  if (labels.some((l) => GOOD_LABELS.includes(l))) {
    score += 100;
    reasons.push(`labeled ${labels.filter((l) => GOOD_LABELS.includes(l)).join(", ")}`);
  }
  if (labels.some((l) => MID_LABELS.includes(l))) {
    score += 50;
    reasons.push(`labeled ${labels.filter((l) => MID_LABELS.includes(l)).join(", ")}`);
  }
  if (mr) {
    score += 80;
    reasons.push("maintainer requested help in comments");
  }
  const ageDays = (Date.now() - new Date(issue.created_at).getTime()) / 86.4e6;
  if (ageDays > 30) {
    score += 10;
    reasons.push(`open ${Math.floor(ageDays)}d`);
  }
  return { issue, score, reasons, maintainerRequested: mr, maintainerFiled: mf, dependencyLike: depLike };
}

export function pickIssue(scored: ScoredIssue[]): ScoredIssue | null {
  const viable = scored.filter((s) => !s.rejected && s.score >= 50);
  viable.sort((a, b) => b.score - a.score);
  return viable[0] ?? null;
}

export function scoredToTask(s: ScoredIssue): TaskCandidate {
  return {
    kind: "issue",
    issue: s.issue,
    maintainerRequested: s.maintainerRequested,
    maintainerFiled: s.maintainerFiled,
  };
}

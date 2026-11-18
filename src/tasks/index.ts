import { issueComments, listOpenIssues, type GhIssue } from "../github.js";
import type { RepoRef } from "../types.js";
import type { TaskCandidate } from "../checks/types.js";
import { depBotPresentApi, type Defect } from "./defects.js";
import { pickIssue, scoreIssue, scoredToTask, type ScoredIssue } from "./issues.js";

export type PickResult = {
  task: TaskCandidate | null;
  scored: ScoredIssue[];
  defects: Defect[];
  reason: string;
};

export async function pickTask(
  ref: RepoRef,
  opts: { issue?: number; deepComments?: boolean } = {},
): Promise<PickResult> {
  const depBot = await depBotPresentApi(ref).catch(() => false);

  if (opts.issue !== undefined) {
    const { getIssue } = await import("../github.js");
    const issue = await getIssue(ref, opts.issue);
    const comments = await issueComments(ref, opts.issue).catch(() => []);
    const scored = scoreIssue(issue, { comments, depBotPresent: depBot });
    if (scored.rejected) {
      return { task: null, scored: [scored], defects: [], reason: scored.rejected };
    }
    return {
      task: scoredToTask(scored),
      scored: [scored],
      defects: [],
      reason: scored.reasons.join("; ") || `issue #${issue.number}`,
    };
  }

  const issues = await listOpenIssues(ref, 60);
  const scored = evaluateIssueList(issues, depBot);
  const best = pickIssue(scored);
  if (best && opts.deepComments !== false) {
    const comments = await issueComments(ref, best.issue.number).catch(() => []);
    const rescored = scoreIssue(best.issue, { comments, depBotPresent: depBot });
    if (rescored.maintainerRequested) {
      return {
        task: scoredToTask(rescored),
        scored: scored.map((s) => (s.issue.number === best.issue.number ? rescored : s)),
        defects: [],
        reason: rescored.reasons.join("; "),
      };
    }
  }
  if (best) {
    return { task: scoredToTask(best), scored, defects: [], reason: best.reasons.join("; ") };
  }
  return {
    task: null,
    scored,
    defects: [],
    reason: "no suitable task: no open issue carries a qualifying label (good first issue / help wanted / bug / docs / tests) or maintainer request",
  };
}

export function evaluateIssueList(issues: GhIssue[], depBotPresent: boolean): ScoredIssue[] {
  return issues.map((i) => scoreIssue(i, { depBotPresent }));
}

export { depBotPresentApi, findDeadDocLinks } from "./defects.js";
export { isDependencyBump, isMaintainerFiled, maintainerRequestedHelp, scoreIssue, pickIssue } from "./issues.js";
export type { ScoredIssue } from "./issues.js";
export type { Defect } from "./defects.js";

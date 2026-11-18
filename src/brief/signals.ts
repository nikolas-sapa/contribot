import {
  ghSearchCount,
  issueComments,
  listRecentClosedPrs,
} from "../github.js";
import type { RepoRef } from "../types.js";

export type MaintainerSignals = {
  sampledClosedPrs: number;
  mergeRate: number | null;
  medianHoursToFirstReply: number | null;
  externalPrsAnswered: boolean | null;
  goodFirstIssueCount: number | null;
  helpWantedCount: number | null;
  notes: string[];
};

function median(nums: number[]): number | null {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export async function gatherSignals(ref: RepoRef): Promise<MaintainerSignals> {
  const notes: string[] = [];
  const out: MaintainerSignals = {
    sampledClosedPrs: 0,
    mergeRate: null,
    medianHoursToFirstReply: null,
    externalPrsAnswered: null,
    goodFirstIssueCount: null,
    helpWantedCount: null,
    notes,
  };

  try {
    const closed = (await listRecentClosedPrs(ref, 30)).filter(
      (p) => !p.draft && !p.user.login.endsWith("[bot]") && p.author_association !== "BOT",
    );
    out.sampledClosedPrs = closed.length;
    if (closed.length) {
      const merged = closed.filter((p) => p.merged_at).length;
      out.mergeRate = merged / closed.length;
      const external = closed.filter(
        (p) => !["MEMBER", "OWNER", "COLLABORATOR"].includes(p.author_association),
      );
      out.externalPrsAnswered = external.length > 0 ? external.some((p) => p.merged_at) : null;

      const replyHours: number[] = [];
      for (const pr of external.slice(0, 8)) {
        try {
          const comments = await issueComments(ref, pr.number);
          const maintainer = comments.find((c) =>
            ["MEMBER", "OWNER", "COLLABORATOR"].includes(c.author_association),
          );
          if (maintainer) {
            const dt =
              (new Date(maintainer.created_at).getTime() - new Date(pr.created_at).getTime()) / 3.6e6;
            if (dt >= 0) replyHours.push(dt);
          }
        } catch {
          /* rate limit — skip */
        }
      }
      out.medianHoursToFirstReply = replyHours.length ? Math.round(median(replyHours)! * 10) / 10 : null;
      if (!replyHours.length && external.length) notes.push("no maintainer replies found on sampled external PRs");
    }
  } catch {
    notes.push("PR sampling failed (API unavailable or rate-limited)");
  }

  try {
    out.goodFirstIssueCount = await ghSearchCount(
      `repo:${ref.full} is:issue is:open label:"good first issue"`,
    );
    out.helpWantedCount = await ghSearchCount(`repo:${ref.full} is:issue is:open label:"help wanted"`);
  } catch {
    notes.push("label counts unavailable (search API rate-limited)");
  }
  return out;
}

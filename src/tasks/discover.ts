import { ghJson, ghSearchCount, getFileText } from "../github.js";
import { gatherSignals, type MaintainerSignals } from "../brief/signals.js";
import { detectAiPolicyText } from "../brief/aipolicy.js";
import type { RepoRef } from "../types.js";

export type RepoCandidate = {
  ref: RepoRef;
  stars: number;
  language: string | null;
  description: string | null;
  goodFirstIssues: number;
  helpWanted: number;
  signals: MaintainerSignals;
  aiPolicy: "banned" | "welcomed" | "unmentioned" | "ambiguous" | null;
  score: number;
  reasons: string[];
};

type SearchRepo = {
  full_name: string;
  stargazers_count: number;
  language: string | null;
  description: string | null;
  pushed_at: string;
  archived: boolean;
  fork: boolean;
};

const AI_QUICK_FILES = ["CONTRIBUTING.md", "Contributing.md", ".github/CONTRIBUTING.md"];

async function quickAiVerdict(ref: RepoRef): Promise<RepoCandidate["aiPolicy"]> {
  const files: { path: string; text: string }[] = [];
  for (const p of AI_QUICK_FILES) {
    const text = await getFileText(ref, p).catch(() => null);
    if (text) files.push({ path: p, text });
  }
  return detectAiPolicyText(files).verdict;
}

export function scoreCandidate(c: Omit<RepoCandidate, "score" | "reasons">): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  const s = c.signals;

  score += Math.min(Math.log10(Math.max(c.stars, 1)) * 6, 36);
  if (c.stars >= 5000) reasons.push(`high-value project (${c.stars.toLocaleString()}★)`);
  else reasons.push(`${c.stars.toLocaleString()}★`);

  if (s.mergeRate !== null) {
    const pts = Math.round(s.mergeRate * 40);
    score += pts;
    reasons.push(`external-PR merge rate ${Math.round(s.mergeRate * 100)}%`);
  }
  if (s.externalPrsAnswered === true) {
    score += 15;
    reasons.push("maintainers merge external PRs");
  } else if (s.externalPrsAnswered === false) {
    score -= 15;
    reasons.push("no evidence maintainers merge external PRs");
  }
  if (s.medianHoursToFirstReply !== null) {
    if (s.medianHoursToFirstReply <= 72) {
      score += 10;
      reasons.push(`maintainers reply in ~${Math.round(s.medianHoursToFirstReply)}h`);
    } else {
      score += 3;
      reasons.push(`slow first reply (~${Math.round(s.medianHoursToFirstReply)}h)`);
    }
  }
  score += Math.min(c.goodFirstIssues, 10) * 2 + Math.min(c.helpWanted, 10) * 1.5;
  if (c.goodFirstIssues) reasons.push(`${c.goodFirstIssues} good-first-issues open`);
  if (c.helpWanted) reasons.push(`${c.helpWanted} help-wanted open`);

  if (c.aiPolicy === "banned") {
    score = -1000;
    reasons.length = 0;
    reasons.push("AI contributions BANNED — do not contribute");
  } else if (c.aiPolicy === "welcomed") {
    score += 10;
    reasons.push("AI contributions explicitly allowed");
  }
  return { score: Math.round(score * 10) / 10, reasons };
}

export async function discoverRepos(opts: {
  language?: string;
  minStars?: number;
  limit?: number;
  extraQuery?: string;
  checkAi?: boolean;
}): Promise<RepoCandidate[]> {
  const minStars = opts.minStars ?? 500;
  const limit = opts.limit ?? 8;
  const pushedAfter = new Date(Date.now() - 90 * 86.4e6).toISOString().slice(0, 10);
  const q = [
    `good-first-issues:>1`,
    `stars:>${minStars}`,
    `pushed:>${pushedAfter}`,
    "archived:false",
    opts.language ? `language:${opts.language}` : "",
    opts.extraQuery ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  const res = (await ghJson(
    `/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=${Math.min(limit + 6, 30)}`,
  )) as { items: SearchRepo[] };

  const out: RepoCandidate[] = [];
  for (const r of res.items) {
    if (out.length >= limit) break;
    if (r.fork || r.archived) continue;
    const [owner, repo] = r.full_name.split("/");
    const ref: RepoRef = { owner, repo, full: r.full_name };
    const [signals, gfi, hw, aiPolicy] = await Promise.all([
      gatherSignals(ref).catch(() => null),
      ghSearchCount(`repo:${r.full_name} is:issue is:open label:"good first issue"`).catch(() => 0),
      ghSearchCount(`repo:${r.full_name} is:issue is:open label:"help wanted"`).catch(() => 0),
      opts.checkAi === false ? Promise.resolve(null) : quickAiVerdict(ref).catch(() => null),
    ]);
    const base = {
      ref,
      stars: r.stargazers_count,
      language: r.language,
      description: r.description,
      goodFirstIssues: gfi,
      helpWanted: hw,
      signals: signals ?? {
        sampledClosedPrs: 0,
        mergeRate: null,
        medianHoursToFirstReply: null,
        externalPrsAnswered: null,
        goodFirstIssueCount: gfi,
        helpWantedCount: hw,
        notes: [],
      },
      aiPolicy,
    };
    const { score, reasons } = scoreCandidate(base);
    out.push({ ...base, score, reasons });
  }
  return out.sort((a, b) => b.score - a.score);
}

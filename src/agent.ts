import { join } from "node:path";
import { simpleGit } from "simple-git";
import { analyzeRepo } from "./brief/analyze.js";
import type { AiPolicy } from "./brief/aipolicy.js";
import { extractRules } from "./brief/rules.js";
import { generateBrief, type Brief } from "./brief/index.js";
import { runChecks, type CheckContext, type TaskCandidate } from "./checks/index.js";
import { contribotDir, loadConfig, type LoadedConfig } from "./config.js";
import { ghJson, ghUser, openPrsByUser } from "./github.js";
import { Ledger, ledgerPath } from "./ledger/db.js";
import { pickTask, type PickResult } from "./tasks/index.js";
import { ensureFork } from "./flow/fork.js";
import { runRepoChecks, type CiRun } from "./flow/ci.js";
import { buildPrBody, openDraftPr } from "./flow/pr.js";
import { applyPatch, branchName, commitAll, diffLineCount, prepareWorkspace } from "./flow/workspace.js";
import type { RepoRef } from "./types.js";
import { parseRepo } from "./types.js";

export function createAgent(opts: { baseDir?: string } = {}): {
  cfg: LoadedConfig;
  ledger: Ledger;
  scout: (repo: string, o?: { out?: string; skipSignals?: boolean }) => Promise<{ brief: Brief; markdown: string }>;
  plan: (repo: string, o?: { issue?: number }) => Promise<PlanResult>;
  pr: (repo: string, o?: PrOptions) => Promise<PrResult>;
  close: () => void;
} {
  const baseDir = opts.baseDir ?? contribotDir(process.env.CONTRIBOT_HOME);
  const cfg = loadConfig(baseDir);
  const ledger = new Ledger(ledgerPath(baseDir));

  async function scout(repo: string, o: { out?: string; skipSignals?: boolean } = {}) {
    const ref = parseRepo(repo);
    const { brief, markdown } = await generateBrief(ref, { baseDir, skipSignals: o.skipSignals });
    ledger.record("scout", ref.full, null, { out: o.out ?? null });
    if (o.out) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(o.out, markdown);
    }
    return { brief, markdown };
  }

  async function reconcileLedger(ref: RepoRef): Promise<void> {
    for (const prRef of ledger.unresolvedOpenedRefs(ref.full)) {
      const n = parseInt(prRef.replace(/\D/g, ""), 10);
      if (!Number.isFinite(n)) continue;
      try {
        const pr = (await ghJson(`/repos/${ref.full}/pulls/${n}`)) as {
          state: string;
          merged_at: string | null;
        };
        if (pr.state === "closed") {
          ledger.record("pr_outcome", ref.full, prRef, { outcome: pr.merged_at ? "merged" : "closed" });
        }
      } catch {
        /* unreachable API — leave unresolved */
      }
    }
  }

  function logUnsafe(ref: RepoRef, phase: string): void {
    if (cfg.relaxed.length) {
      ledger.record("override", ref.full, null, { rule: "unsafe-limits", relaxed: cfg.relaxed, phase });
    }
  }

  async function plan(repo: string, o: { issue?: number } = {}): Promise<PlanResult> {
    const ref = parseRepo(repo);
    await reconcileLedger(ref);
    const pick = await pickTask(ref, { issue: o.issue });
    const login = await ghUser();
    const openPrs = login ? (await openPrsByUser(ref, login).catch(() => [])).length : null;
    const aiPolicy = await quickAiPolicy(ref);
    const ctx = baseCtx(ref, ledger, cfg, pick.task, aiPolicy, openPrs);
    const check = runChecks(ctx);
    ledger.record("plan", ref.full, pick.task?.issue ? `#${pick.task.issue.number}` : null, {
      task: pick.reason,
      verdict: check.status,
    });
    logUnsafe(ref, "plan");
    if (check.status === "block") {
      ledger.record("refusal", ref.full, null, { phase: "plan", rules: check.results.filter((r) => r.status === "block").map((r) => r.rule) });
    }
    return { ref, pick, check };
  }

  async function pr(repo: string, o: PrOptions = {}): Promise<PrResult> {
    const ref = parseRepo(repo);
    await reconcileLedger(ref);
    const pick = await pickTask(ref, { issue: o.issue });
    if (!pick.task && !o.trivial) {
      ledger.record("refusal", ref.full, null, { phase: "pr", reason: pick.reason });
      return { ref, stage: "no-task", pick, reason: pick.reason };
    }
    const task: TaskCandidate | null = o.trivial ? { kind: "trivial" } : pick.task;
    const login = await ghUser();
    const openPrs = login ? (await openPrsByUser(ref, login).catch(() => [])).length : null;
    const aiPolicy = await quickAiPolicy(ref);
    const ctx = baseCtx(ref, ledger, cfg, task, aiPolicy, openPrs);
    ctx.allowLarge = o.allowLarge ?? false;
    const check = runChecks(ctx, o.force ?? []);
    logUnsafe(ref, "pr-preflight");
    const loggedOverrides = new Set<string>();
    const logOverrides = (rules: string[], ref2: string | null) => {
      for (const rule of rules) {
        if (loggedOverrides.has(rule)) continue;
        loggedOverrides.add(rule);
        ledger.record("override", ref.full, ref2, { rule, phase: "pr" });
      }
    };
    logOverrides(check.overrides, null);
    if (check.status === "block") {
      ledger.record("refusal", ref.full, null, { phase: "pr-preflight", rules: check.results.filter((r) => r.status === "block").map((r) => r.rule) });
      return { ref, stage: "blocked", pick, check };
    }

    if (!o.patch) {
      return { ref, stage: "need-patch", pick, check, hint: "preflight passed — supply --patch <diff-file> to apply your change, then contribot runs the repo's own checks and opens a DRAFT PR" };
    }

    try {
      const fork = await ensureFork(ref);
      const issueN = task?.issue?.number ?? null;
      const branch = branchName(issueN, o.branchSlug ?? task?.issue?.title ?? "fix");
      const ws = await prepareWorkspace(fork, ref, branch, join(baseDir, "work"));
      await applyPatch(ws.dir, o.patch);
      const lines = await diffLineCount(ws.dir);
      ctx.diffLines = lines;
      if (o.allowLarge && lines > ctx.limits.diffSizeCap) {
        ledger.record("override", ref.full, null, { rule: "diff-size-cap", via: "--allow-large", lines });
        loggedOverrides.add("diff-size-cap");
      }
      const sizeCheck = runChecks(ctx, o.force ?? []);
      logOverrides(sizeCheck.overrides, null);
      if (sizeCheck.status === "block") {
        ledger.record("refusal", ref.full, null, { phase: "pr-diff", rules: sizeCheck.results.filter((r) => r.status === "block").map((r) => r.rule), lines });
        return { ref, stage: "blocked", pick, check: sizeCheck, workspace: ws.dir };
      }

      const map = await analyzeRepo(ws.dir);
      const message = o.message ?? defaultCommitMessage(task, map.conventions.conventionalCommitRatio);
      const signoff = extractRules(ws.dir, map).requiresDCO;
      await commitAll(ws.dir, message, { signoff });

      const ci = await runRepoChecks(ws.dir, map);
      ctx.ciRan = ci.ran;
      ctx.ciPassed = ci.passed;
      ctx.remoteIsUpstream = await originIsUpstream(ws.dir, ref);
      const ciCheck = runChecks(ctx, o.force ?? []);
      logOverrides(ciCheck.overrides, null);
      if (ciCheck.status === "block") {
        ledger.record("refusal", ref.full, null, { phase: "pr-ci", ci });
        return { ref, stage: "ci-failed", pick, check: ciCheck, ci, workspace: ws.dir };
      }

      const git = simpleGit(ws.dir);
      await git.push(["-u", "origin", branch, "--no-force"]);

      const body = buildPrBody(task, o.summary ?? "", ci);
      const base = await defaultBranch(ref);
      let prRes: { url: string; number: number };
      try {
        prRes = await openDraftPr(ref, { base, branch, title: message.split("\n")[0], body, login: login! });
      } catch (e) {
        const existing = await findExistingPr(ref, login, branch).catch(() => null);
        if (existing) {
          ledger.record("pr_opened", ref.full, `#${existing.number}`, { url: existing.url, branch, issue: issueN, note: "pre-existing PR" });
          return { ref, stage: "opened", pick, check: ciCheck, ci, prUrl: existing.url, prNumber: existing.number, workspace: ws.dir };
        }
        throw e;
      }
      ledger.record("pr_opened", ref.full, `#${prRes.number}`, { url: prRes.url, branch, issue: issueN, diffLines: lines, ci: ci.passed });
      return { ref, stage: "opened", pick, check: ciCheck, ci, prUrl: prRes.url, prNumber: prRes.number, workspace: ws.dir };
    } catch (e) {
      ledger.record("refusal", ref.full, null, { phase: "pr-error", error: (e as Error).message.slice(0, 300) });
      return { ref, stage: "error", pick, reason: (e as Error).message.split("\n")[0] };
    }
  }

  return { cfg, ledger, scout, plan, pr, close: () => ledger.close() };
}

const AI_POLICY_CANDIDATES = [
  "CONTRIBUTING.md", "Contributing.md", "contributing.md", ".github/CONTRIBUTING.md",
  "docs/CONTRIBUTING.md", "CODE_OF_CONDUCT.md", ".github/CODE_OF_CONDUCT.md",
  "README.md", "readme.md", "Readme.md", "README.txt",
];

async function quickAiPolicy(ref: RepoRef): Promise<AiPolicy | null> {
  try {
    const { getFileText } = await import("./github.js");
    const { detectAiPolicyText } = await import("./brief/aipolicy.js");
    const files: { path: string; text: string }[] = [];
    for (const p of AI_POLICY_CANDIDATES) {
      const text = await getFileText(ref, p);
      if (text) files.push({ path: p, text });
    }
    return detectAiPolicyText(files);
  } catch {
    return null;
  }
}

async function originIsUpstream(dir: string, ref: RepoRef): Promise<boolean> {
  const git = simpleGit(dir);
  const remotes = await git.getRemotes(true);
  const origin = remotes.find((r) => r.name === "origin");
  const url = origin?.refs.push ?? "";
  const m = url.match(/[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!m) return false;
  return m[1].toLowerCase() === ref.owner.toLowerCase() && m[2].toLowerCase() === ref.repo.toLowerCase();
}

async function findExistingPr(ref: RepoRef, login: string | null, branch: string): Promise<{ url: string; number: number } | null> {
  if (!login) return null;
  const prs = (await ghJson(`/repos/${ref.full}/pulls?state=open&head=${encodeURIComponent(`${login}:${branch}`)}`)) as {
    html_url: string;
    number: number;
  }[];
  const pr = prs[0];
  return pr ? { url: pr.html_url, number: pr.number } : null;
}

function baseCtx(
  ref: RepoRef,
  ledger: Ledger,
  cfg: LoadedConfig,
  task: TaskCandidate | null,
  aiPolicy: AiPolicy | null,
  openPrsInRepo: number | null,
): CheckContext {
  return {
    ref,
    ledger,
    limits: cfg.limits,
    task,
    aiPolicy,
    openPrsInRepo,
    diffLines: null,
    ciRan: null,
    ciPassed: null,
    prBody: null,
    remoteIsUpstream: false,
    allowLarge: false,
    relaxedLimits: cfg.relaxed,
  };
}

async function defaultBranch(ref: RepoRef): Promise<string> {
  const r = (await ghJson(`/repos/${ref.full}`)) as { default_branch: string };
  return r.default_branch;
}

function defaultCommitMessage(task: TaskCandidate | null, conventionalRatio: number | null): string {
  const prefix = conventionalRatio !== null && conventionalRatio > 0.5 ? "fix: " : "";
  if (task?.kind === "issue" && task.issue) return `${prefix}${task.issue.title} (closes #${task.issue.number})`;
  if (task?.kind === "defect") return `${prefix}${task.defectEvidence}`;
  return `${prefix}minor fix`;
}

export type PlanResult = {
  ref: RepoRef;
  pick: PickResult;
  check: ReturnType<typeof runChecks>;
};

export type PrOptions = {
  issue?: number;
  patch?: string;
  message?: string;
  summary?: string;
  branchSlug?: string;
  trivial?: boolean;
  allowLarge?: boolean;
  force?: string[];
};

export type PrResult = {
  ref: RepoRef;
  stage: "no-task" | "blocked" | "need-patch" | "ci-failed" | "opened" | "error";
  pick: PickResult;
  check?: ReturnType<typeof runChecks>;
  ci?: CiRun;
  prUrl?: string;
  prNumber?: number;
  workspace?: string;
  reason?: string;
  hint?: string;
};

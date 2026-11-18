import { join } from "node:path";
import { simpleGit } from "simple-git";
import { analyzeRepo } from "./brief/analyze.js";
import type { AiPolicy } from "./brief/aipolicy.js";
import { extractRules } from "./brief/rules.js";
import { generateBrief, type Brief } from "./brief/index.js";
import { runChecks, type CheckContext, type TaskCandidate } from "./checks/index.js";
import { contribotDir, loadConfig, type LoadedConfig } from "./config.js";
import { ghUser, openPrsByUser } from "./github.js";
import { Ledger, ledgerPath } from "./ledger/db.js";
import { pickTask, type PickResult } from "./tasks/index.js";
import { ensureFork } from "./flow/fork.js";
import { runRepoChecks, type CiRun } from "./flow/ci.js";
import { buildPrBody, openDraftPr } from "./flow/pr.js";
import { applyPatch, branchName, commitAll, diffLineCount, prepareWorkspace } from "./flow/workspace.js";
import type { RepoRef } from "./types.js";
import { parseRepo } from "./types.js";

export type AgentDeps = {
  cfg: LoadedConfig;
  ledger: Ledger;
};

export function createAgent(opts: { baseDir?: string } = {}): AgentDeps & {
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

  async function plan(repo: string, o: { issue?: number } = {}): Promise<PlanResult> {
    const ref = parseRepo(repo);
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
    if (check.status === "block") {
      ledger.record("refusal", ref.full, null, { phase: "plan", rules: check.results.filter((r) => r.status === "block").map((r) => r.rule) });
    }
    return { ref, pick, check };
  }

  async function pr(repo: string, o: PrOptions = {}): Promise<PrResult> {
    const ref = parseRepo(repo);
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
    for (const rule of check.overrides) {
      ledger.record("override", ref.full, null, { rule, phase: "pr-preflight" });
    }
    if (check.status === "block") {
      ledger.record("refusal", ref.full, null, { phase: "pr-preflight", rules: check.results.filter((r) => r.status === "block").map((r) => r.rule) });
      return { ref, stage: "blocked", pick, check };
    }

    if (!o.patch) {
      return { ref, stage: "need-patch", pick, check, hint: "preflight passed — supply --patch <diff-file> to apply your change, then contribot runs the repo's own checks and opens a DRAFT PR" };
    }

    const fork = await ensureFork(ref);
    const issueN = task?.issue?.number ?? null;
    const branch = branchName(issueN, o.branchSlug ?? task?.issue?.title ?? "fix");
    const ws = await prepareWorkspace(fork, ref, branch, join(baseDir, "work"));
    await applyPatch(ws.dir, o.patch);
    const lines = await diffLineCount(ws.dir);
    ctx.diffLines = lines;
    const sizeCheck = runChecks(ctx, o.force ?? []);
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
    const ciCheck = runChecks(ctx, o.force ?? []);
    if (ciCheck.status === "block") {
      ledger.record("refusal", ref.full, null, { phase: "pr-ci", ci });
      return { ref, stage: "ci-failed", pick, check: ciCheck, ci, workspace: ws.dir };
    }

    const git = simpleGit(ws.dir);
    const remotes = await git.getRemotes(true);
    const origin = remotes.find((r) => r.name === "origin");
    if (origin?.refs.push.includes(`${ref.owner}/${ref.repo}`)) {
      ledger.record("refusal", ref.full, null, { phase: "pr-push", reason: "origin is upstream — fork-safety block" });
      return { ref, stage: "blocked", pick, check: ciCheck, reason: "push target resolved to upstream — refused" };
    }
    await git.push(["-u", "origin", branch, "--no-force"]);

    const body = buildPrBody(task, o.summary ?? "", ci);
    const base = await defaultBranch(ref);
    const prRes = await openDraftPr(ref, { head: base, branch, title: message.split("\n")[0], body });
    ledger.record("pr_opened", ref.full, `#${prRes.number}`, { url: prRes.url, branch, issue: issueN, diffLines: lines, ci: ci.passed });
    for (const rule of check.overrides.concat(sizeCheck.overrides, ciCheck.overrides)) {
      ledger.record("override", ref.full, `#${prRes.number}`, { rule, phase: "pr" });
    }
    return { ref, stage: "opened", pick, check: ciCheck, ci, prUrl: prRes.url, prNumber: prRes.number, workspace: ws.dir };
  }

  return { cfg, ledger, scout, plan, pr, close: () => ledger.close() };
}

const AI_POLICY_CANDIDATES = [
  "CONTRIBUTING.md", "Contributing.md", "contributing.md", ".github/CONTRIBUTING.md",
  "docs/CONTRIBUTING.md", "CODE_OF_CONDUCT.md", ".github/CODE_OF_CONDUCT.md",
  "README.md", "readme.md", "Readme.md",
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
  };
}

async function defaultBranch(ref: RepoRef): Promise<string> {
  const { ghJson } = await import("./github.js");
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
  stage: "no-task" | "blocked" | "need-patch" | "ci-failed" | "opened";
  pick: PickResult;
  check?: ReturnType<typeof runChecks>;
  ci?: CiRun;
  prUrl?: string;
  prNumber?: number;
  workspace?: string;
  reason?: string;
  hint?: string;
};

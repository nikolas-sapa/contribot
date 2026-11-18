import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ledger } from "../src/ledger/db.js";
import { DEFAULT_LIMITS } from "../src/config.js";
import type { CheckContext, TaskCandidate } from "../src/checks/types.js";
import type { AiPolicy } from "../src/brief/aipolicy.js";
import type { GhIssue } from "../src/github.js";
import type { RepoRef } from "../src/types.js";

export const FIXTURES = join(fileURLToPath(new URL(".", import.meta.url)), "fixtures");

export function tmpLedger(): { ledger: Ledger; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "contribot-test-"));
  return { ledger: new Ledger(join(dir, "ledger.db")), dir };
}

export const REF: RepoRef = { owner: "acme", repo: "widgets", full: "acme/widgets" };

export function ctx(overrides: Partial<CheckContext> = {}, ledger?: Ledger): CheckContext {
  return {
    ref: REF,
    ledger: ledger ?? tmpLedger().ledger,
    limits: { ...DEFAULT_LIMITS },
    task: null,
    aiPolicy: null,
    openPrsInRepo: 0,
    diffLines: null,
    ciRan: null,
    ciPassed: null,
    prBody: null,
    remoteIsUpstream: false,
    allowLarge: false,
    ...overrides,
  };
}

export function makeIssue(n: number, opts: { labels?: string[]; title?: string; body?: string; createdAt?: string } = {}): GhIssue {
  return {
    number: n,
    title: opts.title ?? `issue ${n}`,
    body: opts.body ?? null,
    html_url: `https://github.com/acme/widgets/issues/${n}`,
    created_at: opts.createdAt ?? new Date().toISOString(),
    labels: (opts.labels ?? []).map((name) => ({ name })),
    user: { login: "reporter" },
  };
}

export const AI_UNMENTIONED: AiPolicy = { verdict: "unmentioned", evidence: [] };
export const AI_BANNED: AiPolicy = { verdict: "banned", evidence: ["CONTRIBUTING.md: We do not accept AI-generated contributions"] };

export function issueTask(issue: GhIssue, maintainerRequested = false): TaskCandidate {
  return { kind: "issue", issue, maintainerRequested };
}

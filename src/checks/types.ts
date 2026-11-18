import type { Limits } from "../config.js";
import type { GhIssue } from "../github.js";
import type { AiPolicy } from "../brief/aipolicy.js";
import type { Ledger } from "../ledger/db.js";
import type { RepoRef } from "../types.js";

export type CheckStatus = "pass" | "warn" | "block";

export type CheckResult = {
  rule: string;
  status: CheckStatus;
  reason: string;
  overrideFlag?: string;
  overridden?: boolean;
};

export type TaskCandidate = {
  kind: "issue" | "defect" | "trivial";
  issue?: GhIssue;
  defectEvidence?: string;
  maintainerRequested?: boolean;
  maintainerFiled?: boolean;
};

export type CheckContext = {
  ref: RepoRef;
  ledger: Ledger;
  limits: Limits;
  task: TaskCandidate | null;
  aiPolicy: AiPolicy | null;
  openPrsInRepo: number | null;
  diffLines: number | null;
  ciRan: boolean | null;
  ciPassed: boolean | null;
  prBody: string | null;
  remoteIsUpstream: boolean;
  allowLarge: boolean;
  relaxedLimits?: string[];
};

export const DISCLOSURE_LINE =
  "This contribution was prepared with AI assistance (contribot) and reviewed by a human.";

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Limits = {
  maxOpenPrsPerRepo: number;
  maxPrsPerDay: number;
  cooldownDays: number;
  diffSizeCap: number;
  requireLinkedIssue: boolean;
  ciParity: boolean;
  disclosure: boolean;
  issueLegitimacy: "warn" | "block";
  issueAgeDays: number;
};

export const DEFAULT_LIMITS: Limits = {
  maxOpenPrsPerRepo: 1,
  maxPrsPerDay: 2,
  cooldownDays: 14,
  diffSizeCap: 400,
  requireLinkedIssue: true,
  ciParity: true,
  disclosure: true,
  issueLegitimacy: "warn",
  issueAgeDays: 30,
};

export type LoadedConfig = {
  dir: string;
  limits: Limits;
  overridden: string[];
  relaxed: string[];
  unsafe: boolean;
};

export function contribotDir(base?: string): string {
  const dir = base ?? join(homedir(), ".contribot");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function loadConfig(base?: string): LoadedConfig {
  const dir = contribotDir(base);
  const path = join(dir, "config.json");
  const limits = { ...DEFAULT_LIMITS };
  const overridden: string[] = [];
  const relaxed: string[] = [];
  let unsafe = false;
  if (existsSync(path)) {
    let raw: Partial<Limits> & { allowUnsafeLimits?: boolean };
    try {
      raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Limits> & { allowUnsafeLimits?: boolean };
    } catch (e) {
      throw new Error(`malformed config at ${path}: ${(e as Error).message}`);
    }
    unsafe = raw.allowUnsafeLimits === true;
    for (const k of ["maxOpenPrsPerRepo", "maxPrsPerDay", "cooldownDays", "diffSizeCap", "issueAgeDays"] as const) {
      const v = raw[k];
      if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) continue;
      if (v < limits[k]) {
        limits[k] = v;
        overridden.push(k);
      } else if (v > limits[k] && unsafe) {
        limits[k] = v;
        relaxed.push(k);
      }
    }
    if (raw.issueLegitimacy === "block") {
      limits.issueLegitimacy = "block";
      overridden.push("issueLegitimacy");
    }
  }
  return { dir, limits, overridden, relaxed, unsafe };
}

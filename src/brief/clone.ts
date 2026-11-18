import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import type { RepoRef } from "../types.js";

export function repoCachePath(ref: RepoRef, cacheDir: string): string {
  return join(cacheDir, `${ref.owner}__${ref.repo}`);
}

export async function ensureClone(ref: RepoRef, cacheDir: string): Promise<string> {
  mkdirSync(cacheDir, { recursive: true });
  const dir = repoCachePath(ref, cacheDir);
  const url = `https://github.com/${ref.full}.git`;
  if (existsSync(join(dir, ".git"))) {
    const git = simpleGit(dir);
    const branches = await git.branchLocal();
    const branch = branches.current || (await git.raw(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    await git.fetch(["--depth", "1", "origin", branch]);
    await git.reset(["--hard", `origin/${branch}`]);
    return dir;
  }
  await simpleGit().clone(url, dir, ["--depth", "1"]);
  return dir;
}

export async function recentSubjects(dir: string, n = 60): Promise<string[]> {
  const git = simpleGit(dir);
  try {
    const out = await git.raw(["log", `-${n}`, "--format=%s%n%b%x1e"]);
    return out.split("\x1e").map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

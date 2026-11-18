import { existsSync, mkdirSync, renameSync } from "node:fs";
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
    try {
      const git = simpleGit(dir);
      const remoteHead = (await git.raw(["rev-parse", "--abbrev-ref", "origin/HEAD"]).catch(() => "")).trim();
      const branch =
        remoteHead.replace(/^origin\//, "") ||
        (await git.raw(["ls-remote", "--symref", "origin", "HEAD"])).match(/ref: refs\/heads\/(\S+)\s+HEAD/)?.[1] ||
        (await git.branchLocal()).current ||
        "main";
      await git.fetch(["--depth", "1", "origin", branch]);
      await git.reset(["--hard", `origin/${branch}`]);
      return dir;
    } catch {
      /* stale/broken cache — move it aside and re-clone fresh */
      renameSync(dir, `${dir}.stale-${Date.now()}`);
    }
  }
  await simpleGit().clone(url, dir, ["--depth", "1"]);
  return dir;
}

export async function recentSubjects(dir: string, n = 60): Promise<string[]> {
  if (!existsSync(join(dir, ".git"))) return [];
  const git = simpleGit(dir);
  try {
    const top = (await git.raw(["rev-parse", "--show-toplevel"])).trim();
    if (top !== dir) return [];
    const out = await git.raw(["log", `-${n}`, "--format=%s%n%b%x1e"]);
    return out.split("\x1e").map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

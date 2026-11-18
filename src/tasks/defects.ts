import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileExistsOnGitHub } from "../github.js";
import type { RepoRef } from "../types.js";

export type Defect = {
  kind: "dead-doc-link" | "failing-pattern";
  file: string;
  evidence: string;
  detail: string;
};

export async function depBotPresentLocal(root: string): Promise<boolean> {
  return (
    existsSync(join(root, ".github/dependabot.yml")) ||
    existsSync(join(root, ".github/dependabot.yaml")) ||
    existsSync(join(root, "renovate.json")) ||
    existsSync(join(root, ".github/renovate.json")) ||
    existsSync(join(root, ".renovaterc")) ||
    existsSync(join(root, ".renovaterc.json"))
  );
}

export async function depBotPresentApi(ref: RepoRef): Promise<boolean> {
  for (const p of [".github/dependabot.yml", ".github/dependabot.yaml", "renovate.json", ".renovaterc.json"]) {
    if (await fileExistsOnGitHub(ref, p)) return true;
  }
  return false;
}

function* docFiles(root: string, depth = 0): Generator<string> {
  if (depth > 2) return;
  let entries;
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name.startsWith(".git") || name === "node_modules") continue;
    const p = join(root, name);
    const st = statSync(p);
    if (st.isDirectory() && (depth === 0 || /^(docs?|wiki|\.github)$/i.test(name))) {
      yield* docFiles(p, depth + 1);
    } else if (st.isFile() && /\.(md|mdx|rst)$/i.test(name)) {
      yield p;
    }
  }
}

export async function findDeadDocLinks(root: string, maxChecks = 15): Promise<Defect[]> {
  const defects: Defect[] = [];
  let checked = 0;
  for (const file of docFiles(root)) {
    if (checked >= maxChecks) break;
    const text = readFileSync(file, "utf8");
    const links = [...text.matchAll(/\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g)].map((m) => m[1]);
    for (const url of links.slice(0, 5)) {
      if (checked >= maxChecks) break;
      checked++;
      try {
        const res = await fetch(url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(8000) });
        if (res.status === 404 || res.status === 410) {
          defects.push({
            kind: "dead-doc-link",
            file: file.slice(root.length + 1),
            evidence: `HTTP ${res.status} for ${url}`,
            detail: `dead link in ${file.slice(root.length + 1)}: ${url}`,
          });
        }
      } catch {
        /* network failure ≠ dead link */
      }
    }
  }
  return defects;
}

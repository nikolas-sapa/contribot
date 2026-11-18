import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const API = "https://api.github.com";

let cachedToken: string | null | undefined;

export class GitHubError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(`GitHub API ${status}: ${message}`);
  }
}

export async function ghToken(): Promise<string | null> {
  if (cachedToken !== undefined) return cachedToken;
  cachedToken = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? null;
  if (!cachedToken) {
    try {
      const { stdout } = await execFileP("gh", ["auth", "token"]);
      cachedToken = stdout.trim() || null;
    } catch {
      cachedToken = null;
    }
  }
  return cachedToken;
}

export async function ghUser(): Promise<string | null> {
  const token = await ghToken();
  if (!token) return null;
  try {
    const me = (await ghJson("/user")) as { login: string };
    return me.login;
  } catch {
    return null;
  }
}

export async function ghJson(path: string, init: RequestInit = {}): Promise<unknown> {
  const token = await ghToken();
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(init.headers as Record<string, string>),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const url = path.startsWith("http") ? path : `${API}${path}`;
  const res = await fetch(url, { ...init, headers });
  if (res.status === 204) return null;
  const body = await res.text();
  if (!res.ok) throw new GitHubError(res.status, body.slice(0, 300));
  return body ? JSON.parse(body) : null;
}

export async function ghSearchCount(q: string): Promise<number> {
  const res = (await ghJson(`/search/issues?q=${encodeURIComponent(q)}&per_page=1`)) as {
    total_count: number;
  };
  return res.total_count;
}

export type GhIssue = {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  created_at: string;
  pull_request?: unknown;
  labels: { name: string }[];
  user: { login: string } | null;
};

export type GhComment = {
  body: string;
  author_association: string;
  user: { login: string };
  created_at: string;
};

export type GhPr = {
  number: number;
  title: string;
  merged_at: string | null;
  created_at: string;
  closed_at: string | null;
  user: { login: string };
  author_association: string;
  html_url: string;
  draft: boolean;
};

export async function listOpenIssues(ref: { owner: string; repo: string }, perPage = 60): Promise<GhIssue[]> {
  const issues = (await ghJson(
    `/repos/${ref.owner}/${ref.repo}/issues?state=open&per_page=${perPage}&sort=created&direction=asc`,
  )) as GhIssue[];
  return issues.filter((i) => !i.pull_request);
}

export async function getIssue(ref: { owner: string; repo: string }, n: number): Promise<GhIssue> {
  return (await ghJson(`/repos/${ref.owner}/${ref.repo}/issues/${n}`)) as GhIssue;
}

export async function issueComments(
  ref: { owner: string; repo: string },
  n: number,
): Promise<GhComment[]> {
  return (await ghJson(`/repos/${ref.owner}/${ref.repo}/issues/${n}/comments?per_page=100`)) as GhComment[];
}

export async function listRecentClosedPrs(
  ref: { owner: string; repo: string },
  perPage = 30,
): Promise<GhPr[]> {
  return (await ghJson(
    `/repos/${ref.owner}/${ref.repo}/pulls?state=closed&per_page=${perPage}&sort=updated&direction=desc`,
  )) as GhPr[];
}

export async function getFileText(
  ref: { owner: string; repo: string },
  path: string,
): Promise<string | null> {
  try {
    const res = (await ghJson(
      `/repos/${ref.owner}/${ref.repo}/contents/${encodeURIComponent(path).replaceAll("%2F", "/")}`,
    )) as { content?: string; encoding?: string };
    if (res.encoding === "base64" && res.content) {
      return Buffer.from(res.content.replace(/\n/g, ""), "base64").toString("utf8");
    }
    return null;
  } catch (e) {
    if (e instanceof GitHubError && e.status === 404) return null;
    throw e;
  }
}

export async function fileExistsOnGitHub(
  ref: { owner: string; repo: string },
  path: string,
): Promise<boolean> {
  try {
    await ghJson(`/repos/${ref.owner}/${ref.repo}/contents/${encodeURIComponent(path).replaceAll("%2F", "/")}`);
    return true;
  } catch (e) {
    if (e instanceof GitHubError && e.status === 404) return false;
    throw e;
  }
}

export async function openPrsByUser(
  ref: { owner: string; repo: string },
  login: string,
): Promise<GhIssue[]> {
  const items = (await ghJson(
    `/search/issues?q=${encodeURIComponent(`repo:${ref.owner}/${ref.repo} type:pr state:open author:${login}`)}`,
  )) as { items: GhIssue[] };
  return items.items;
}

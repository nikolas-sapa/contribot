import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { recentSubjects } from "./clone.js";

const LANG_BY_EXT: Record<string, string> = {
  ".ts": "TypeScript", ".tsx": "TypeScript", ".mts": "TypeScript", ".cts": "TypeScript",
  ".js": "JavaScript", ".jsx": "JavaScript", ".mjs": "JavaScript", ".cjs": "JavaScript",
  ".py": "Python", ".go": "Go", ".rs": "Rust", ".rb": "Ruby", ".java": "Java",
  ".c": "C", ".h": "C/C++", ".cpp": "C++", ".hpp": "C++", ".cs": "C#",
  ".swift": "Swift", ".kt": "Kotlin", ".php": "PHP", ".ex": "Elixir", ".exs": "Elixir",
  ".scala": "Scala", ".lua": "Lua", ".zig": "Zig", ".hs": "Haskell",
};

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", "coverage", "vendor",
  "__pycache__", ".next", ".nuxt", "target", "venv", ".venv", "bin", "obj",
]);

const LINT_FILES = [
  ".eslintrc", ".eslintrc.json", ".eslintrc.js", ".eslintrc.yml", "eslint.config.js",
  "eslint.config.mjs", "eslint.config.ts", "biome.json", ".prettierrc", ".prettierrc.json",
  ".prettierrc.js", "prettier.config.js", "ruff.toml", ".flake8", "pyproject.toml",
  ".rubocop.yml", ".golangci.yml", "clippy.toml", ".clang-format",
];

export type CiCheck = { file: string; name: string; jobs: string[]; commands: string[] };

export type RepoMap = {
  languages: { name: string; pct: number }[];
  topLevel: string[];
  entryPoints: string[];
  testSetup: { runner: string | null; command: string | null; files: string[] };
  ciChecks: CiCheck[];
  lintConfigs: string[];
  files: {
    contributing: string | null;
    codeOfConduct: string | null;
    prTemplate: string | null;
    issueTemplates: string[];
    license: string | null;
    cla: string | null;
    dependabot: boolean;
    renovate: boolean;
  };
  conventions: {
    conventionalCommitRatio: number | null;
    signoffRatio: number;
    sampleSubjects: string[];
  };
};

function walk(dir: string, depth: number, acc: string[] = []): string[] {
  if (depth > 4) return acc;
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name) || name.startsWith(".git")) continue;
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(p, depth + 1, acc);
    else acc.push(p);
  }
  return acc;
}

function findFirst(root: string, candidates: string[]): string | null {
  for (const c of candidates) {
    if (existsSync(join(root, c))) return c;
    const dir = join(root, c.split("/").slice(0, -1).join("/"));
    const base = c.split("/").at(-1)!.toLowerCase();
    try {
      const hit = readdirSync(dir).find((f) => f.toLowerCase() === base);
      if (hit) return c.split("/").slice(0, -1).concat(hit).join("/");
    } catch {
      /* dir missing */
    }
  }
  return null;
}

function parseCiFile(root: string, rel: string): CiCheck {
  const file = join(".github/workflows", rel);
  const check: CiCheck = { file, name: rel.replace(/\.ya?ml$/, ""), jobs: [], commands: [] };
  try {
    const doc = parseYaml(readFileSync(join(root, file), "utf8")) as Record<string, unknown>;
    if (doc && typeof doc === "object") {
      if (typeof doc.name === "string") check.name = doc.name;
      const jobs = (doc.jobs ?? {}) as Record<string, { name?: string; steps?: { run?: string; name?: string }[] }>;
      for (const [jobId, job] of Object.entries(jobs)) {
        check.jobs.push(job.name ?? jobId);
        for (const step of job.steps ?? []) {
          if (step.run) {
            for (const line of step.run.split("\n")) {
              const t = line.trim();
              if (t && !t.startsWith("#")) check.commands.push(t);
            }
          }
        }
      }
    }
  } catch {
    check.jobs.push("(unparsed)");
  }
  return check;
}

export async function analyzeRepo(root: string): Promise<RepoMap> {
  const files = walk(root, 0);
  const byExt = new Map<string, number>();
  let total = 0;
  for (const f of files) {
    const ext = extname(f).toLowerCase();
    const lang = LANG_BY_EXT[ext];
    if (!lang) continue;
    byExt.set(lang, (byExt.get(lang) ?? 0) + 1);
    total++;
  }
  const languages = [...byExt.entries()]
    .map(([name, count]) => ({ name, pct: Math.round((count / Math.max(total, 1)) * 100) }))
    .sort((a, b) => b.pct - a.pct)
    .slice(0, 6);

  const topLevel = readdirSync(root, { withFileTypes: true })
    .filter((e) => !e.name.startsWith(".git") && !SKIP_DIRS.has(e.name))
    .map((e) => e.name + (e.isDirectory() ? "/" : ""))
    .slice(0, 30);

  const entryPoints: string[] = [];
  const pkgPath = join(root, "package.json");
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
    for (const k of ["main", "module", "bin", "exports"]) {
      if (pkg[k]) entryPoints.push(`package.json:${k} → ${JSON.stringify(pkg[k])}`);
    }
    if (pkg.scripts) {
      const s = pkg.scripts as Record<string, string>;
      for (const k of ["build", "start", "dev", "test", "lint"]) {
        if (s[k]) entryPoints.push(`script:${k} → ${s[k]}`);
      }
    }
  }
  for (const c of ["src/index.ts", "src/index.js", "index.ts", "index.js", "src/main.ts", "src/main.rs", "main.go", "cmd", "pyproject.toml", "setup.py", "Cargo.toml", "go.mod"]) {
    if (existsSync(join(root, c))) entryPoints.push(c);
  }

  const testFiles = files
    .map((f) => f.slice(root.length + 1))
    .filter((f) => /(vitest|jest|mocha|ava|playwright|cypress)\.config\.|pytest\.ini|tox\.ini|\.bats$/i.test(basename(f)))
    .slice(0, 10);
  let testRunner: string | null = null;
  let testCommand: string | null = null;
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string>; devDependencies?: Record<string, string>; dependencies?: Record<string, string> };
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const r of ["vitest", "jest", "mocha", "ava", "tap", "node:test"]) {
      if (deps[r] || Object.keys(deps).some((d) => d.includes(r))) {
        testRunner = r;
        break;
      }
    }
    if (pkg.scripts?.test) testCommand = `npm test (${pkg.scripts.test})`;
    else if (pkg.scripts?.["test:unit"]) testCommand = `npm run test:unit (${pkg.scripts["test:unit"]})`;
  }
  if (!testRunner) {
    if (existsSync(join(root, "pytest.ini")) || testFiles.some((f) => f === "pytest.ini") || existsSync(join(root, "pyproject.toml"))) {
      testRunner = "pytest";
      testCommand = "pytest";
    } else if (existsSync(join(root, "go.mod"))) {
      testRunner = "go test";
      testCommand = "go test ./...";
    } else if (existsSync(join(root, "Cargo.toml"))) {
      testRunner = "cargo test";
      testCommand = "cargo test";
    } else if (existsSync(join(root, "Makefile"))) {
      const mk = readFileSync(join(root, "Makefile"), "utf8");
      if (/^test:/m.test(mk)) {
        testRunner = "make test";
        testCommand = "make test";
      }
    }
  }

  const workflowsDir = join(root, ".github/workflows");
  const ciChecks: CiCheck[] = existsSync(workflowsDir)
    ? readdirSync(workflowsDir)
        .filter((f) => /\.ya?ml$/.test(f))
        .map((f) => parseCiFile(root, f))
    : [];

  const lintConfigs = LINT_FILES.filter((f) => existsSync(join(root, f)));

  const contributing = findFirst(root, [
    "CONTRIBUTING.md", "contributing.md", "CONTRIBUTING", ".github/CONTRIBUTING.md",
    "docs/CONTRIBUTING.md", "docs/contributing.md",
  ]);
  const codeOfConduct = findFirst(root, [
    "CODE_OF_CONDUCT.md", ".github/CODE_OF_CONDUCT.md", "code-of-conduct.md", "CODE_OF_CONDUCT",
  ]);
  let prTemplate = findFirst(root, [
    ".github/pull_request_template.md", ".github/PULL_REQUEST_TEMPLATE.md",
    "pull_request_template.md", "docs/pull_request_template.md",
  ]);
  if (!prTemplate) {
    const prDir = join(root, ".github/PULL_REQUEST_TEMPLATE");
    if (existsSync(prDir)) prTemplate = ".github/PULL_REQUEST_TEMPLATE/";
  }
  const issueTemplates: string[] = [];
  for (const d of [".github/ISSUE_TEMPLATE", ".github/ISSUE_TEMPLATES"]) {
    const p = join(root, d);
    if (existsSync(p)) {
      for (const f of readdirSync(p)) issueTemplates.push(`${d}/${f}`);
    }
  }
  const license = findFirst(root, ["LICENSE", "LICENSE.md", "LICENSE.txt", "LICENCE", "COPYING"]);
  const cla = findFirst(root, ["CLA.md", ".github/CLA.md", "DCO", "DCO.txt", ".github/DCO.md"]);

  const dependabot = existsSync(join(root, ".github/dependabot.yml")) || existsSync(join(root, ".github/dependabot.yaml"));
  const renovate =
    existsSync(join(root, "renovate.json")) ||
    existsSync(join(root, ".github/renovate.json")) ||
    existsSync(join(root, ".renovaterc")) ||
    existsSync(join(root, ".renovaterc.json"));

  const subjects = await recentSubjects(root, 60);
  let conventional = 0;
  let signoff = 0;
  const sampleSubjects: string[] = [];
  for (const msg of subjects) {
    const first = msg.split("\n")[0];
    if (sampleSubjects.length < 8) sampleSubjects.push(first);
    if (/^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\(.+?\))?(!)?:/.test(first)) conventional++;
    if (/^Signed-off-by:/m.test(msg)) signoff++;
  }

  return {
    languages,
    topLevel,
    entryPoints,
    testSetup: { runner: testRunner, command: testCommand, files: testFiles },
    ciChecks,
    lintConfigs,
    files: {
      contributing,
      codeOfConduct,
      prTemplate,
      issueTemplates,
      license,
      cla,
      dependabot,
      renovate,
    },
    conventions: {
      conventionalCommitRatio: subjects.length ? conventional / subjects.length : null,
      signoffRatio: subjects.length ? signoff / subjects.length : 0,
      sampleSubjects,
    },
  };
}

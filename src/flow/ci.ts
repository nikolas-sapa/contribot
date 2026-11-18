import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { RepoMap } from "../brief/analyze.js";

const execFileP = promisify(execFile);

export type CiRun = {
  ran: boolean;
  passed: boolean | null;
  commands: { cmd: string; ok: boolean; tail: string }[];
  installOk: boolean | null;
  skippedReason?: string;
};

type PkgManager = { name: string; install: string[] };

function detectPkgManager(root: string, pkg: Record<string, unknown> | null): PkgManager {
  const pmField = typeof pkg?.packageManager === "string" ? pkg.packageManager : "";
  if (pmField.startsWith("pnpm") || existsSync(join(root, "pnpm-lock.yaml"))) {
    return { name: "pnpm", install: ["pnpm", "install", "--frozen-lockfile"] };
  }
  if (pmField.startsWith("yarn") || existsSync(join(root, "yarn.lock"))) {
    const immutable = pmField.startsWith("yarn@") && !pmField.startsWith("yarn@1") || existsSync(join(root, ".yarnrc.yml"));
    return { name: "yarn", install: immutable ? ["yarn", "install", "--immutable"] : ["yarn", "install", "--frozen-lockfile"] };
  }
  if (pmField.startsWith("bun") || existsSync(join(root, "bun.lockb"))) {
    return { name: "bun", install: ["bun", "install", "--frozen-lockfile"] };
  }
  return { name: "npm", install: ["npm", "ci", "--ignore-scripts"] };
}

function sh(cmd: string[], cwd: string): Promise<{ ok: boolean; tail: string }> {
  const [bin, ...args] = cmd;
  return execFileP(bin, args, {
    cwd,
    timeout: 600_000,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, CI: "true" },
  })
    .then(({ stdout, stderr }) => ({ ok: true, tail: (stdout + stderr).slice(-1500) }))
    .catch((e) => ({
      ok: false,
      tail: `${e.message}\n${(e.stdout ?? "") + (e.stderr ?? "")}`.slice(-1500),
    }));
}

function readPkg(root: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(join(root, "package.json"), "utf8").replace(/^\uFEFF/, "")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function runRepoChecks(root: string, map: RepoMap | null): Promise<CiRun> {
  const run: CiRun = { ran: false, passed: null, commands: [], installOk: null };
  const pkg = readPkg(root);
  const isJs = pkg !== null;
  const checkCmds: string[][] = [];

  if (isJs && !existsSync(join(root, "node_modules"))) {
    const pm = detectPkgManager(root, pkg);
    const scripts = (pkg.scripts ?? {}) as Record<string, string>;
    if (scripts.lint) checkCmds.push([pm.name, "run", "lint"]);
    if (scripts.test && !/no test specified/.test(scripts.test)) checkCmds.push([pm.name, "test"]);
    if (checkCmds.length === 0) {
      run.skippedReason = "no lint/test scripts";
      return run;
    }
    const install = await sh(pm.install, root);
    run.commands.push({ cmd: pm.install.join(" "), ok: install.ok, tail: install.tail });
    if (!install.ok && pm.name === "npm") {
      const fb = await sh(["npm", "install", "--ignore-scripts"], root);
      run.commands.push({ cmd: "npm install --ignore-scripts", ok: fb.ok, tail: fb.tail });
      run.installOk = fb.ok;
    } else {
      run.installOk = install.ok;
    }
    run.ran = true;
    if (!run.installOk) {
      run.passed = false;
      return run;
    }
  } else if (isJs) {
    const pm = detectPkgManager(root, pkg);
    const scripts = (pkg.scripts ?? {}) as Record<string, string>;
    if (scripts.lint) checkCmds.push([pm.name, "run", "lint"]);
    if (scripts.test && !/no test specified/.test(scripts.test)) checkCmds.push([pm.name, "test"]);
  } else if (existsSync(join(root, "go.mod"))) {
    checkCmds.push(["go", "build", "./..."], ["go", "test", "./..."]);
  } else if (existsSync(join(root, "Cargo.toml"))) {
    checkCmds.push(["cargo", "check"], ["cargo", "test"]);
  } else if (existsSync(join(root, "pytest.ini"))) {
    checkCmds.push(["pytest", "-x"]);
  }

  for (const cmd of checkCmds) {
    const r = await sh(cmd, root);
    run.commands.push({ cmd: cmd.join(" "), ok: r.ok, tail: r.tail });
    if (!r.ok) {
      run.ran = true;
      run.passed = false;
      return run;
    }
  }
  run.ran = run.commands.length > 0;
  run.passed = run.commands.every((c) => c.ok);
  return run;
}

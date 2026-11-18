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
  skippedReason?: string;
};

function sh(cmd: string, cwd: string): Promise<{ ok: boolean; tail: string }> {
  const [bin, ...args] = cmd.split(/\s+/);
  return execFileP(bin, args, { cwd, timeout: 600_000, maxBuffer: 4 * 1024 * 1024 })
    .then(({ stdout, stderr }) => ({
      ok: true,
      tail: (stdout + stderr).slice(-1500),
    }))
    .catch((e) => ({
      ok: false,
      tail: `${e.message}\n${(e.stdout ?? "") + (e.stderr ?? "")}`.slice(-1500),
    }));
}

export async function runRepoChecks(root: string, map: RepoMap | null): Promise<CiRun> {
  const run: CiRun = { ran: false, passed: null, commands: [] };
  const pkgPath = join(root, "package.json");
  const isJs = existsSync(pkgPath);

  if (isJs && !existsSync(join(root, "node_modules"))) {
    const install = await sh("npm ci --ignore-scripts", root);
    run.commands.push({ cmd: "npm ci --ignore-scripts", ok: install.ok, tail: install.tail });
    if (!install.ok) {
      const fallback = await sh("npm install --ignore-scripts", root);
      run.commands.push({ cmd: "npm install --ignore-scripts", ok: fallback.ok, tail: fallback.tail });
      if (!fallback.ok) {
        run.ran = true;
        run.passed = false;
        return run;
      }
    }
    run.ran = true;
  }

  const cmds: string[] = [];
  if (isJs) {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> };
    if (pkg.scripts?.lint) cmds.push("npm run lint --if-present");
    if (pkg.scripts?.test && !/no test specified|exit 1\s*$/.test(pkg.scripts.test)) cmds.push("npm test");
  } else if (existsSync(join(root, "go.mod"))) {
    cmds.push("go build ./...", "go test ./...");
  } else if (existsSync(join(root, "Cargo.toml"))) {
    cmds.push("cargo check", "cargo test");
  } else if (existsSync(join(root, "pyproject.toml")) || existsSync(join(root, "pytest.ini"))) {
    cmds.push("pytest -x");
  } else if (map?.testSetup.command) {
    cmds.push(map.testSetup.command);
  }

  for (const cmd of cmds) {
    const r = await sh(cmd, root);
    run.commands.push({ cmd, ok: r.ok, tail: r.tail });
    if (!r.ok) {
      run.ran = true;
      run.passed = false;
      return run;
    }
  }
  run.ran = cmds.length > 0 || run.commands.length > 0;
  run.passed = run.commands.every((c) => c.ok);
  return run;
}

#!/usr/bin/env node
import { Command } from "commander";
import { createAgent, type PrResult } from "../agent.js";
import { DEFAULT_LIMITS } from "../config.js";
import type { CheckResult } from "../checks/index.js";

const program = new Command();
program
  .name("contribot")
  .description("OSS contribution agent with etiquette limits enforced in code — not prompted.")
  .version("0.1.0");

function printChecks(results: CheckResult[]): void {
  for (const r of results) {
    const icon = r.status === "block" ? "✗" : r.status === "warn" ? "!" : "✓";
    const flag = r.overridden ? ` [overridden]` : r.status === "block" && r.overrideFlag ? ` (override: ${r.overrideFlag})` : "";
    console.log(`  ${icon} ${r.rule}: ${r.reason}${flag}`);
  }
}

program
  .command("scout")
  .argument("<repo>", "owner/repo or GitHub URL")
  .option("--out <file>", "write AGENT-BRIEF.md to file")
  .option("--no-signals", "skip GitHub API maintainer signals")
  .action(async (repo: string, opts: { out?: string; signals?: boolean }) => {
    const agent = createAgent();
    try {
      const { markdown } = await agent.scout(repo, { out: opts.out, skipSignals: opts.signals === false });
      if (opts.out) console.log(`brief written to ${opts.out}`);
      else console.log(markdown);
    } finally {
      agent.close();
    }
  });

program
  .command("plan")
  .argument("<repo>", "owner/repo or GitHub URL")
  .option("--issue <n>", "target a specific issue number", (v: string) => parseInt(v, 10))
  .action(async (repo: string, opts: { issue?: number }) => {
    const agent = createAgent();
    try {
      const res = await agent.plan(repo, { issue: opts.issue });
      if (!res.pick.task) {
        console.log(`no suitable task on ${res.ref.full}: ${res.pick.reason}`);
        process.exit(2);
      }
      const t = res.pick.task;
      console.log(`# Contribution plan — ${res.ref.full}`);
      if (t.issue) {
        console.log(`- issue: #${t.issue.number} ${t.issue.title}`);
        console.log(`- url: ${t.issue.html_url}`);
      }
      console.log(`- why this: ${res.pick.reason}`);
      console.log(`- intended diff shape: minimal, single-purpose change addressing the issue only`);
      console.log(`- checks that will run before PR:`);
      printChecks(res.check.results);
      if (res.check.status === "block") {
        console.log(`\nblocked — resolve the above before \`contribot pr\``);
        process.exit(1);
      }
    } finally {
      agent.close();
    }
  });

program
  .command("pr")
  .argument("<repo>", "owner/repo or GitHub URL")
  .option("--issue <n>", "target a specific issue number", (v: string) => parseInt(v, 10))
  .option("--patch <file>", "unified diff to apply to a fresh fork clone")
  .option("--message <msg>", "commit / PR title")
  .option("--summary <text>", "what changed, for the PR body")
  .option("--branch-slug <slug>", "branch name suffix")
  .option("--trivial", "typo-class change, no linked issue required")
  .option("--allow-large", "permit diffs over the size cap (logged)")
  .option("--force <flags...>", "override flags for blockable checks (each is logged to the ledger)")
  .action(async (repo: string, opts) => {
    const agent = createAgent();
    try {
      const res: PrResult = await agent.pr(repo, {
        issue: opts.issue,
        patch: opts.patch,
        message: opts.message,
        summary: opts.summary,
        branchSlug: opts.branchSlug,
        trivial: opts.trivial,
        allowLarge: opts.allowLarge,
        force: opts.force,
      });
      switch (res.stage) {
        case "no-task":
          console.log(`no suitable task on ${res.ref.full}: ${res.reason}`);
          process.exit(2);
          break;
        case "blocked":
          console.log(`blocked by etiquette rules:`);
          if (res.check) printChecks(res.check.results);
          if (res.reason) console.log(`  ✗ ${res.reason}`);
          process.exit(1);
          break;
        case "need-patch":
          console.log(`preflight passed:`);
          if (res.check) printChecks(res.check.results);
          console.log(`\n${res.hint}`);
          break;
        case "ci-failed":
          console.log(`repo checks failed — PR not opened:`);
          for (const c of res.ci?.commands ?? []) console.log(`  ${c.ok ? "✓" : "✗"} ${c.cmd}\n${c.tail}`);
          process.exit(1);
          break;
        case "opened":
          console.log(`draft PR opened: ${res.prUrl}`);
          console.log(`workspace: ${res.workspace}`);
          break;
      }
    } finally {
      agent.close();
    }
  });

program
  .command("discover")
  .description("search GitHub for repos where a contribution is most likely to land — ranks by project value × merge odds")
  .option("--lang <language>", "filter by language")
  .option("--min-stars <n>", "minimum stars", (v: string) => parseInt(v, 10))
  .option("--limit <n>", "repos to evaluate", (v: string) => parseInt(v, 10))
  .option("--query <q>", "extra GitHub search qualifiers")
  .option("--no-ai-check", "skip AI-policy fetch (faster)")
  .action(async (opts) => {
    const agent = createAgent();
    try {
      const { discoverRepos } = await import("../tasks/discover.js");
      const repos = await discoverRepos({
        language: opts.lang,
        minStars: opts.minStars,
        limit: opts.limit,
        extraQuery: opts.query,
        checkAi: opts.aiCheck !== false,
      });
      if (!repos.length) {
        console.log("no candidate repos matched — loosen --min-stars or --query");
        process.exit(2);
      }
      console.log(`ranked contribution targets (score = project value × merge odds):\n`);
      for (const c of repos) {
        const tag = c.aiPolicy === "banned" ? " ⛔ AI-BANNED" : "";
        console.log(`${String(c.score).padStart(6)}  ${c.ref.full}${tag}`);
        console.log(`        ${c.reasons.join(" · ")}`);
      }
      agent.ledger.record("scout", null, null, { discover: true, count: repos.length });
      const best = repos[0];
      if (best && best.aiPolicy !== "banned") {
        console.log(`\nnext: contribot scout ${best.ref.full} && contribot plan ${best.ref.full}`);
      }
    } finally {
      agent.close();
    }
  });

program
  .command("ledger")
  .option("--repo <full>", "filter to one repo")
  .action((opts: { repo?: string }) => {
    const agent = createAgent();
    try {
      const ledger = agent.ledger;
      const stats = ledger.perRepoStats().filter((s) => !opts.repo || s.repo === opts.repo);
      if (stats.length) {
        console.log("per-repo reputation:");
        for (const s of stats) {
          const resolved = s.merged + s.closed + s.rejected + s.stale;
          const parts = [`${s.opened} opened`];
          if (s.merged) parts.push(`${s.merged} merged`);
          if (s.rejected) parts.push(`${s.rejected} rejected`);
          if (s.closed) parts.push(`${s.closed} closed`);
          if (s.stale) parts.push(`${s.stale} stale`);
          console.log(`  ${s.repo}: ${parts.join(", ")}`);
          if (resolved >= 3 && s.rejected / resolved > 0.5) {
            console.log(`    ⚠ rejection rate >50% on ${s.repo} — you are generating slop. Stop.`);
          }
        }
      }
      const events = (opts.repo ? ledger.forRepo(opts.repo) : ledger.all(50)).filter((e) => !opts.repo || e.repo === opts.repo);
      console.log(`\nrecent events (${events.length}):`);
      for (const e of events.slice(0, 50)) {
        const detail = e.detail ? ` ${e.detail.slice(0, 120)}` : "";
        console.log(`  ${e.ts}  ${e.kind.padEnd(10)} ${e.repo ?? "-"} ${e.ref ?? ""}${detail}`);
      }
    } finally {
      agent.close();
    }
  });

program
  .command("limits")
  .action(() => {
    const agent = createAgent();
    try {
      const { limits, overridden, relaxed, dir } = agent.cfg;
      console.log(`config: ${dir}/config.json`);
      if (overridden.length) console.log(`  stricter overrides: ${overridden.join(", ")}`);
      if (relaxed.length) console.log(`  ⚠ UNSAFE MODE — relaxed above defaults (your own risk, logged per run): ${relaxed.join(", ")}`);
      if (!overridden.length && !relaxed.length) console.log("  defaults — numeric caps loosenable only with allowUnsafeLimits:true");
      console.log("");
      const rows: [string, string][] = [
        ["max open PRs per repo", String(limits.maxOpenPrsPerRepo)],
        ["max PRs per day (global)", String(limits.maxPrsPerDay)],
        ["per-repo cooldown after closed/rejected PR", `${limits.cooldownDays}d`],
        ["AI-banned detection", "block (no override)"],
        ["linked issue required", limits.requireLinkedIssue ? "yes (block)" : "relaxed"],
        ["diff size cap", `${limits.diffSizeCap} lines`],
        ["issue legitimacy", limits.issueLegitimacy],
        ["issue age threshold", `${limits.issueAgeDays}d`],
        ["CI parity (run repo's own checks first)", limits.ciParity ? "block on fail" : "relaxed"],
        ["AI disclosure in PR body", "enforced (non-removable)"],
        ["fork safety", "enforced — never push upstream, never force-push"],
      ];
      for (const [k, v] of rows) console.log(`  ${k.padEnd(48)} ${v}`);
      console.log("");
      console.log("defaults:", JSON.stringify(DEFAULT_LIMITS));
    } finally {
      agent.close();
    }
  });

program.parse();

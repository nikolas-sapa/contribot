import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export type LedgerEventKind =
  | "scout"
  | "plan"
  | "pr_opened"
  | "pr_outcome"
  | "refusal"
  | "override";

export type LedgerEvent = {
  id: number;
  ts: string;
  kind: LedgerEventKind;
  repo: string | null;
  ref: string | null;
  detail: string | null;
};

export class Ledger {
  private db: Database.Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        kind TEXT NOT NULL,
        repo TEXT,
        ref TEXT,
        detail TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_events_repo ON events(repo);
      CREATE INDEX IF NOT EXISTS idx_events_kind_ts ON events(kind, ts);
    `);
  }

  record(kind: LedgerEventKind, repo: string | null, ref: string | null, detail: unknown = null): void {
    this.db
      .prepare("INSERT INTO events (ts, kind, repo, ref, detail) VALUES (?, ?, ?, ?, ?)")
      .run(new Date().toISOString(), kind, repo, ref, detail === null ? null : JSON.stringify(detail));
  }

  all(limit = 200): LedgerEvent[] {
    return this.db
      .prepare("SELECT * FROM events ORDER BY id DESC LIMIT ?")
      .all(limit) as LedgerEvent[];
  }

  forRepo(repo: string): LedgerEvent[] {
    return this.db
      .prepare("SELECT * FROM events WHERE repo = ? ORDER BY id DESC")
      .all(repo) as LedgerEvent[];
  }

  openPrCount(repo: string): number {
    const opened = this.db
      .prepare("SELECT ref FROM events WHERE kind = 'pr_opened' AND repo = ?")
      .all(repo) as { ref: string }[];
    const resolved = new Set(
      (this.db
        .prepare("SELECT ref FROM events WHERE kind = 'pr_outcome' AND repo = ?")
        .all(repo) as { ref: string }[]).map((r) => r.ref),
    );
    return opened.filter((o) => !resolved.has(o.ref)).length;
  }

  prsOpenedSince(sinceIso: string): number {
    const r = this.db
      .prepare("SELECT COUNT(*) AS c FROM events WHERE kind = 'pr_opened' AND ts >= ?")
      .get(sinceIso) as { c: number };
    return r.c;
  }

  unresolvedOpenedRefs(repo: string): string[] {
    const opened = this.db
      .prepare("SELECT ref FROM events WHERE kind = 'pr_opened' AND repo = ?")
      .all(repo) as { ref: string }[];
    const resolved = new Set(
      (this.db
        .prepare("SELECT ref FROM events WHERE kind = 'pr_outcome' AND repo = ?")
        .all(repo) as { ref: string }[]).map((r) => r.ref),
    );
    return opened.map((o) => o.ref).filter((r) => !resolved.has(r));
  }

  lastOutcome(repo: string, kinds: string[] = ["closed", "rejected"]): LedgerEvent | null {
    const rows = this.db
      .prepare("SELECT * FROM events WHERE kind = 'pr_outcome' AND repo = ? ORDER BY id DESC LIMIT 50")
      .all(repo) as LedgerEvent[];
    for (const row of rows) {
      const detail = row.detail ? (JSON.parse(row.detail) as { outcome?: string }) : {};
      if (detail.outcome && kinds.includes(detail.outcome)) return row;
    }
    return null;
  }

  perRepoStats(): { repo: string; opened: number; merged: number; closed: number; rejected: number; stale: number }[] {
    const repos = this.db
      .prepare("SELECT DISTINCT repo FROM events WHERE repo IS NOT NULL")
      .all() as { repo: string }[];
    return repos.map(({ repo }) => {
      const events = this.forRepo(repo);
      const opened = events.filter((e) => e.kind === "pr_opened").length;
      const count = (outcome: string) =>
        events.filter(
          (e) =>
            e.kind === "pr_outcome" &&
            e.detail &&
            (JSON.parse(e.detail) as { outcome?: string }).outcome === outcome,
        ).length;
      return {
        repo,
        opened,
        merged: count("merged"),
        closed: count("closed"),
        rejected: count("rejected"),
        stale: count("stale"),
      };
    });
  }

  close(): void {
    this.db.close();
  }
}

export function ledgerPath(base: string): string {
  return join(base, "ledger.db");
}

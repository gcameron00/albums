import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

type Param = string | number | null;

/**
 * Minimal D1 stand-in backed by in-memory SQLite, so the real migrations and
 * SQL run in tests. Implements only what src/ uses.
 */
export function createTestDb(): { d1: D1Database; sqlite: DatabaseSync } {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  const migrations = join(import.meta.dirname, "..", "..", "migrations");
  for (const file of readdirSync(migrations).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(join(migrations, file), "utf8"));
  }

  const prepare = (sql: string) => {
    let args: Param[] = [];
    const stmt = {
      bind(...a: Param[]) {
        args = a;
        return stmt;
      },
      async first() {
        return sqlite.prepare(sql).get(...args) ?? null;
      },
      async all() {
        return { results: sqlite.prepare(sql).all(...args), success: true };
      },
      async run() {
        sqlite.prepare(sql).run(...args);
        return { success: true };
      },
      exec() {
        sqlite.prepare(sql).run(...args);
      },
    };
    return stmt;
  };

  const d1 = {
    prepare,
    async batch(stmts: Array<ReturnType<typeof prepare>>) {
      sqlite.exec("BEGIN");
      try {
        for (const s of stmts) s.exec();
        sqlite.exec("COMMIT");
      } catch (e) {
        sqlite.exec("ROLLBACK");
        throw e;
      }
      return [];
    },
  };
  return { d1: d1 as unknown as D1Database, sqlite };
}

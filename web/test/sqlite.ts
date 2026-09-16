// A node:sqlite Executable, so the admin write path can be tested the way the read path
// already is: against the real migrations and the real SQL, with no wrangler and no
// network. D1 is SQLite, so the only differences that matter are the ones queries.ts
// already papers over.

import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Executable, Row, Statement } from '../src/lib/db/queries.ts';
import { REPO_ROOT } from './legacy-context.ts';

const MIGRATIONS = join(REPO_ROOT, 'web/migrations');

/** Every migration in order, which is what the deployed schema is. */
export function migrated(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    db.exec(readFileSync(join(MIGRATIONS, file), 'utf8'));
  }
  return db;
}

export function executable(db: DatabaseSync): Executable {
  const all = async (sql: string, params: unknown[] = []): Promise<Row[]> =>
    db.prepare(sql).all(...(params as never[])) as unknown as Row[];

  return {
    all,
    async run(sql, params = []) {
      db.prepare(sql).run(...(params as never[]));
    },
    // D1's batch is atomic; a loop is close enough for a test that only cares that every
    // statement runs and that a failing one throws.
    async batch(statements: Statement[]) {
      for (const s of statements) db.prepare(s.sql).run(...((s.params ?? []) as never[]));
    },
    async insert(sql, params = []) {
      return Number(db.prepare(sql).run(...(params as never[])).lastInsertRowid);
    },
  };
}

// D1 implementation of the interfaces in queries.ts.
//
// Keeping this adapter tiny is the point: the SQL and the row mapping live in
// queries.ts, shared with the node:sqlite adapter the round-trip test uses, so the
// tested code and the deployed code are the same code.

import type { Executable, Row, Statement } from './queries.ts';

export function d1(db: D1Database): Executable {
  const prepare = (sql: string, params: unknown[]) =>
    params.length ? db.prepare(sql).bind(...params) : db.prepare(sql);

  return {
    async all(sql: string, params: unknown[] = []): Promise<Row[]> {
      const { results } = await prepare(sql, params).all();
      return (results ?? []) as Row[];
    },
    async run(sql: string, params: unknown[] = []): Promise<void> {
      await prepare(sql, params).run();
    },
    async batch(statements: Statement[]): Promise<void> {
      if (!statements.length) return;
      await db.batch(statements.map((s) => prepare(s.sql, s.params ?? [])));
    },
    async insert(sql: string, params: unknown[] = []): Promise<number> {
      const result = await prepare(sql, params).run();
      return Number(result.meta.last_row_id);
    },
  };
}

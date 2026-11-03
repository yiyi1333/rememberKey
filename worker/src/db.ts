/** Thin D1 helpers shared by all route modules. */

import type { Env } from './types';

export function stmt(db: D1Database, sql: string, ...params: unknown[]): D1PreparedStatement {
  return db.prepare(sql).bind(...params);
}

export async function one<T>(
  db: D1Database,
  sql: string,
  ...params: unknown[]
): Promise<T | null> {
  const row = await stmt(db, sql, ...params).first<T>();
  return row ?? null;
}

export async function all<T>(db: D1Database, sql: string, ...params: unknown[]): Promise<T[]> {
  const result = await stmt(db, sql, ...params).all<T>();
  return result.results ?? [];
}

export async function run(
  db: D1Database,
  sql: string,
  ...params: unknown[]
): Promise<D1Result> {
  return stmt(db, sql, ...params).run();
}

/**
 * Execute prepared statements atomically. D1 batches roll back as a whole when
 * any statement fails, which the write paths rely on for compare-and-set.
 */
export async function batch(
  db: D1Database,
  statements: D1PreparedStatement[],
): Promise<D1Result[]> {
  return db.batch(statements);
}

/** Number of rows changed by one statement result (0 when absent). */
export function changed(result: D1Result | undefined): number {
  return result?.meta?.changes ?? 0;
}

/** Unix timestamp in seconds (matches the former Go server's token expiry maths). */
export function unixNow(): number {
  return Math.floor(Date.now() / 1000);
}

/** Convenience accessor so callers do not need to import Env separately. */
export type WorkerEnv = Env;

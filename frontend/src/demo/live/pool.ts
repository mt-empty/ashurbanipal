// The slice of node-postgres's Pool that node-express's PostgresSource uses
// (connect → query(text, params) → release), over one PGlite instance.
import type { PGlite } from "@electric-sql/pglite";
import type { Pool, PoolClient } from "pg";

// PGlite has a single connection and runs a raw BEGIN/COMMIT interleaved with
// any other caller's queries, so each "client" holds the instance until released.
export function pgliteAsPool(db: PGlite): Pool {
  let tail = Promise.resolve();
  const pool = {
    async connect(): Promise<PoolClient> {
      let release!: () => void;
      const previous = tail;
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      const client = {
        query: async (text: string, params?: unknown[]) => ({ rows: (await db.query(text, params)).rows }),
        release,
      };
      return client as unknown as PoolClient;
    },
  };
  return pool as unknown as Pool;
}

// node-postgres returns int8 as text; PGlite would return a number.
export const NODE_POSTGRES_PARSERS = { 20: (value: string) => value };

// One demo source: a PGlite instance seeded from SQL, browsed through
// node-express's PostgresSource.
import { PGlite, type PGliteOptions } from "@electric-sql/pglite";
import { PostgresSource } from "../../../../implementations/node-express/src/db/postgres.js";
import { NODE_POSTGRES_PARSERS, pgliteAsPool } from "./pool.js";

export async function openSource(seed: string, options: PGliteOptions = {}): Promise<PostgresSource> {
  const db = await PGlite.create({ ...options, parsers: NODE_POSTGRES_PARSERS });
  await db.exec(seed);
  return new PostgresSource(pgliteAsPool(db));
}

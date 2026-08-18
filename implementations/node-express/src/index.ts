export { type Config, isEnabled, type Limits, type Sibling } from "./config.js";
export { PostgresSource } from "./db/postgres.js";
export type {
  ColumnInfo,
  ColumnRef,
  CommonValueEntry,
  CountEntry,
  DbSource,
  KeyKind,
  QueryOpts,
  TableData,
  TableInfo,
} from "./db/types.js";
export { FilterError, NotAllowedError } from "./errors.js";
export { buildWhereClause, type Condition, parseFilter } from "./filter.js";
export { createRouter } from "./routes.js";
// SqliteSource/MySqlSource are NOT re-exported here: this barrel is the
// only always-imported module, so pulling them in unconditionally would
// make every consumer's module graph (even a Postgres-only one) eagerly
// load the sqlite3/mysql2 drivers — the Node analog of Rust's Cargo
// feature-gating would then be defeated by a single barrel export. A host
// that wants either backend imports it directly:
// `import { SqliteSource } from "ashurbanipal-node-express/dist/src/db/sqlite.js"`
// (or the equivalent relative path to src/db/sqlite.js / src/db/mysql.js)
// — explicit by construction, never driver auto-detection.

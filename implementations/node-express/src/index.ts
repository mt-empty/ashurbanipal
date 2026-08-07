export { createRouter } from "./routes.js";
export {
  type Config,
  type Limits,
  type Sibling,
  ProductionEnabledError,
  isEnabled,
  validateConfig,
} from "./config.js";
export { NotAllowedError, FilterError } from "./errors.js";
export { parseFilter, buildWhereClause, type Condition } from "./filter.js";
export type {
  DbSource,
  ColumnInfo,
  ColumnRef,
  KeyKind,
  TableInfo,
  TableData,
  CountEntry,
  CommonValueEntry,
  QueryOpts,
} from "./db/types.js";
export { PostgresSource } from "./db/postgres.js";
// SqliteSource/MySqlSource are NOT re-exported here: this barrel is the
// only always-imported module, so pulling them in unconditionally would
// make every consumer's module graph (even a Postgres-only one) eagerly
// load the sqlite3/mysql2 drivers — the Node analog of Rust's Cargo
// feature-gating would then be defeated by a single barrel export. A host
// that wants either backend imports it directly:
// `import { SqliteSource } from "ashurbanipal-node-express/dist/db/sqlite.js"`
// (or the equivalent relative path to src/db/sqlite.js / src/db/mysql.js)
// — explicit by construction, never driver auto-detection.

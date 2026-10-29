import { supersedeLoads } from "../bootstrap/reload.js";
import { api } from "../core/api.js";
import { $, populateSelect, reportError } from "../core/dom.js";
import { markTiming } from "../core/perf-marks.js";
import { settleSchema, settleSource, sourceQuery, state, switchSchema, switchSource } from "../core/state.js";
import type { SchemasResponse, SourceEntry, SourcesResponse } from "../core/types.js";
import { syncGridLock } from "./grid-lock.js";
import { loadTables } from "./table-chips.js";

// The source and schema selectors in the header: the scope every table list
// and data request runs in.

// ==== Source selector ====
// Hidden when the host has one source. A source switch resets the table,
// sort and filter: another source has its own schemas and tables.
export async function loadSources(): Promise<void> {
  let names: string[];
  let defaultSource: string;
  try {
    let sources: SourceEntry[];
    ({ sources, default: defaultSource } = await api<SourcesResponse>("/sources"));
    names = sources.map((s) => s.name);
  } catch (e) {
    // /sources is mandatory (spec/protocol.md §5.8); on failure degrade to
    // single-source, with no `source` param, but leave a trace.
    console.warn("ashurbanipal: /sources failed; assuming single-source", e);
    settleSource(null, false);
    return;
  }
  const wanted = state.scope.source;
  // `default` must be listed (spec/protocol.md §5.8); a lone source is its own default either way.
  const fallback = names.includes(defaultSource) ? defaultSource : (names[0] ?? null);
  const source = wanted !== null && names.includes(wanted) ? wanted : fallback;
  settleSource(source, names.length > 1);
  if (!state.manySources) return;
  populateSelect($<HTMLSelectElement>("source-select"), names, source);
  $("source-select-wrap").hidden = false;
}
$<HTMLSelectElement>("source-select").onchange = () => {
  // switchSource restores the schema last used on this source rather than
  // resetting; loadSchemas() still validates it and falls back (R5/R12).
  supersedeLoads();
  switchSource($<HTMLSelectElement>("source-select").value);
  loadSchemas()
    .then((current) => (current ? loadTables() : undefined))
    .catch(reportError);
};

// ==== Schema selector ====
// Hidden for a single-schema source; every request after start-up still names its schema.
// Same supersession guard as loadTables: a slow /schemas from an earlier
// source switch must not overwrite a later one's schema and selector.
let loadSchemasToken = 0;

/** Fetches the source's schemas and settles the scope; resolves false when
 * a newer source switch superseded it, so the caller stops there. */
export async function loadSchemas(): Promise<boolean> {
  syncGridLock();
  const token = ++loadSchemasToken;
  let schemas: string[];
  let defaultSchema: string | null;
  try {
    const listing = await api<SchemasResponse>(`/schemas${sourceQuery()}`);
    schemas = listing.schemas.map((s) => s.name);
    // A host's JSON settings may drop a null field.
    defaultSchema = listing.default ?? null;
  } catch (e) {
    if (token !== loadSchemasToken) return false;
    // /schemas is mandatory (spec/protocol.md §5.7); on failure degrade to
    // single-schema but leave a trace.
    console.warn("ashurbanipal: /schemas failed; assuming single-schema", e);
    settleSchema(null, false, false);
    $("schema-select-wrap").hidden = true;
    markTiming("scope-settled");
    return true;
  }
  if (token !== loadSchemasToken) return false;
  const wanted = state.scope.schema;
  // The server's default can be null (no default schema on that connection).
  const schema = wanted !== null && schemas.includes(wanted) ? wanted : (defaultSchema ?? schemas[0] ?? null);
  settleSchema(schema, schemas.length > 1, defaultSchema === null);
  if (schema !== null) populateSelect($<HTMLSelectElement>("schema-select"), schemas, schema);
  // Re-hidden explicitly: a source switch can land on a source with fewer
  // schemas than the last one, whose selector would otherwise stay up.
  $("schema-select-wrap").hidden = !state.manySchemas;
  markTiming("scope-settled");
  return true;
}
$<HTMLSelectElement>("schema-select").onchange = () => {
  supersedeLoads();
  switchSchema($<HTMLSelectElement>("schema-select").value);
  loadTables().catch(reportError);
};

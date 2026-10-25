import { supersedeLoads } from "../bootstrap/reload.js";
import { api } from "../core/api.js";
import { $, populateSelect, reportError } from "../core/dom.js";
import { sourceQuery, state, switchSchema, switchSource } from "../core/state.js";
import type { SourceEntry } from "../core/types.js";
import { syncGridLock } from "./grid-lock.js";
import { loadTables } from "./table-chips.js";

// The source and schema selectors in the header: the scope every table list
// and data request runs in.

// ==== Source selector ====
// Hidden when the host has one source. A source switch resets the table,
// sort and filter: another source has its own schemas and tables.
export async function loadSources(): Promise<void> {
  let sources: SourceEntry[];
  try {
    ({ sources } = await api<{ sources: SourceEntry[] }>("/sources"));
  } catch (e) {
    // /sources is mandatory (spec/protocol.md §5.8); on failure degrade to
    // single-source, with no `source` param, but leave a trace.
    console.warn("ashurbanipal: /sources failed; assuming single-source", e);
    state.source = null;
    return;
  }
  if (sources.length <= 1) {
    state.source = null;
    return;
  }
  let source = state.source;
  if (!source || !sources.some((s) => s.name === source)) {
    source = sources[0].name;
  }
  state.source = source;
  populateSelect(
    $<HTMLSelectElement>("source-select"),
    sources.map((s) => s.name),
    source,
  );
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
// Hidden for a single-schema deployment, which then sends no `schema` param.
// With two or more, state.schema is pinned to a concrete name so every
// request names its schema.
// Same supersession guard as loadTables: a slow /schemas from an earlier
// source switch must not overwrite a later one's schema and selector.
let loadSchemasToken = 0;

/** Fetches the source's schemas and pins state.schema; resolves false when
 * a newer source switch superseded it, so the caller stops there. */
export async function loadSchemas(): Promise<boolean> {
  syncGridLock();
  const token = ++loadSchemasToken;
  let schemas: string[];
  try {
    ({ schemas } = await api<{ schemas: string[] }>(`/schemas${sourceQuery()}`));
  } catch (e) {
    if (token !== loadSchemasToken) return false;
    // /schemas is mandatory (spec/protocol.md §5.7); on failure degrade to
    // single-schema but leave a trace.
    console.warn("ashurbanipal: /schemas failed; assuming single-schema", e);
    state.schema = null;
    $("schema-select-wrap").hidden = true;
    return true;
  }
  if (token !== loadSchemasToken) return false;
  // Explicitly re-hides even though the element starts hidden in markup:
  // switching source can re-run this against a source with fewer schemas
  // than the previously selected one, and without this the wrap would keep
  // showing the prior source's stale multi-schema dropdown.
  if (schemas.length <= 1) {
    state.schema = null;
    $("schema-select-wrap").hidden = true;
    return true;
  }
  let schema = state.schema;
  if (!schema || !schemas.includes(schema)) {
    schema = schemas.includes("public") ? "public" : schemas[0];
  }
  state.schema = schema;
  populateSelect($<HTMLSelectElement>("schema-select"), schemas, schema);
  $("schema-select-wrap").hidden = false;
  return true;
}
$<HTMLSelectElement>("schema-select").onchange = () => {
  supersedeLoads();
  switchSchema($<HTMLSelectElement>("schema-select").value);
  loadTables().catch(reportError);
};

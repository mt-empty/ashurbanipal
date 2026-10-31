import { describe, expect, it } from "vitest";
import { withDefaults } from "../src/config.js";
import type {
  CommonValueEntry,
  CountEntry,
  DbSource,
  QueryOpts,
  ReferencedByEntry,
  SchemaListing,
  Structure,
  TableData,
  TableInfo,
} from "../src/db/types.js";
import { API_PATHS, handleApi, type NamedSource } from "../src/handlers.js";
import type { JoinData, JoinOpts } from "../src/join.js";

// handleApi without Express — the contract the GitHub Pages live demo's worker
// relies on. A fake DbSource records what each route asked of it.
class RecordingSource implements DbSource {
  calls: { method: string; args: unknown[] }[] = [];
  private record(method: string, args: unknown[]) {
    this.calls.push({ method, args });
  }
  async listSchemas(): Promise<SchemaListing> {
    this.record("listSchemas", []);
    return { schemas: ["public"], default: "public" };
  }
  async listTables(schema: string | undefined): Promise<TableInfo[]> {
    this.record("listTables", [schema]);
    return [{ name: "t" }];
  }
  async tableCounts(): Promise<CountEntry[]> {
    return [{ table: "t", approx_rows: 1 }];
  }
  async queryTable(schema: string | undefined, table: string, opts: QueryOpts): Promise<TableData> {
    this.record("queryTable", [schema, table, opts]);
    return { columns: [], rows: [], total_approx: 0 };
  }
  async commonValues(): Promise<CommonValueEntry[]> {
    return [];
  }
  async referencedBy(): Promise<ReferencedByEntry[]> {
    return [];
  }
  async structure(): Promise<Structure> {
    this.record("structure", []);
    return { indexes: [], constraints: { unique: [], foreign_keys: [], check: [] } };
  }
  async queryJoin(_schema: string | undefined, _spec: unknown, opts: JoinOpts): Promise<JoinData> {
    this.record("queryJoin", [opts]);
    return { columns: [], rows: [], has_more: false };
  }
}

// Two tables joined on one pair: the smallest join parseJoin accepts.
const JOIN = JSON.stringify({
  table: "orders",
  joins: [{ type: "inner", table: "users", on: [{ left: { join: 0, column: "user_id" }, right: "id" }] }],
});

const opts = { limits: withDefaults(undefined), siblings: async () => ({ siblings: [] }) };

function call(sources: NamedSource[], path: string, query: Record<string, string> = {}) {
  const params = new URLSearchParams(query);
  return handleApi(sources, path, (key) => params.get(key) ?? undefined, opts);
}

function setup() {
  const source = new RecordingSource();
  return { source, sources: [{ name: "primary", source }] };
}

describe("handleApi", () => {
  it("stamps every response with the protocol and nosniff headers", async () => {
    const { sources } = setup();
    for (const r of [await call(sources, "/tables"), await call(sources, "/tables/data")]) {
      expect(r.headers["x-ashurbanipal-protocol"]).toBe("1");
      expect(r.headers["X-Content-Type-Options"]).toBe("nosniff");
    }
  });

  it("answers a path outside API_PATHS with a 404", async () => {
    const { sources, source } = setup();
    const r = await call(sources, "/tables/nope", { source: "missing" });
    expect(r.status).toBe(404);
    expect(source.calls).toEqual([]);
  });

  it("routes every API path to a non-404 answer", async () => {
    const { sources } = setup();
    for (const path of API_PATHS) {
      const r = await call(sources, path, { table: "t", column: "c", join: JOIN });
      expect(r.status, path).not.toBe(404);
    }
  });

  it("serves /tables/structure from structure()", async () => {
    const { sources, source } = setup();
    expect((await call(sources, "/tables/structure", { table: "t" })).status).toBe(200);
    expect(source.calls.map((c) => c.method)).toEqual(["structure"]);
  });

  it("rejects an unknown source before a missing table", async () => {
    const { sources } = setup();
    const r = await call(sources, "/tables/data", { source: "missing" });
    expect(r.status).toBe(400);
    expect(JSON.parse(r.body).code).toBe("unknown_source");
  });

  it("maps a missing table, a bad order, and a non-numeric limit to invalid_parameter", async () => {
    const { sources } = setup();
    const queries: Record<string, string>[] = [{}, { table: "t", order: "up" }, { table: "t", limit: "ten" }];
    for (const query of queries) {
      const r = await call(sources, "/tables/data", query);
      expect(r.status).toBe(400);
      expect(r.headers["Content-Type"]).toBe("application/problem+json; charset=utf-8");
      expect(JSON.parse(r.body).code).toBe("invalid_parameter");
    }
  });

  it("clamps limit and offset and passes the first value of a repeated key", async () => {
    const { sources, source } = setup();
    const params = new URLSearchParams("table=t&limit=100000&offset=-5&order=desc&order=asc");
    await handleApi(sources, "/tables/data", (key) => params.get(key) ?? undefined, opts);
    const [, table, queryOpts] = source.calls[0].args as [string, string, QueryOpts];
    expect(table).toBe("t");
    expect(queryOpts).toMatchObject({ limit: opts.limits.maxPageSize, offset: 0, descending: true });
  });

  it("rejects a non-numeric sort_join on /tables/join", async () => {
    const { sources } = setup();
    const r = await call(sources, "/tables/join", { join: JOIN, sort_join: "x" });
    expect(JSON.parse(r.body).code).toBe("invalid_parameter");
  });

  it("throws for an empty source list, a host setup error", async () => {
    await expect(call([], "/sources")).rejects.toThrow("at least one source");
  });
});

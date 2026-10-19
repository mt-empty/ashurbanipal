import { describe, expect, it } from "vitest";
import { pgTypeClass } from "../src/db/postgres.js";
import { FilterError, isQueryTimeout, NotAllowedError } from "../src/errors.js";
import { parseFilter, parseFilterForJoin } from "../src/filter.js";
import {
  assignJoinLabels,
  BadJoinError,
  BadParamError,
  buildJoinSelect,
  type JoinColMeta,
  type JoinDialect,
  type JoinOpts,
  type JoinTableMeta,
  parseJoin,
  planJoin,
} from "../src/join.js";

const uuid = (name: string): JoinColMeta => ({ name, type: "uuid", class: { kind: "uuid" } });
const text = (name: string): JoinColMeta => ({ name, type: "text", class: { kind: "text" } });

const orders = (): JoinTableMeta => ({
  name: "orders",
  columns: [uuid("id"), uuid("user_id"), text("status"), { name: "tags", type: "ARRAY" }],
});
const users = (): JoinTableMeta => ({ name: "users", columns: [uuid("id"), text("email")] });

const opts = (over: Partial<JoinOpts> = {}): JoinOpts => ({
  limit: 10,
  offset: 0,
  descending: false,
  filter: [],
  ...over,
});

const JOIN = `{"table":"orders","joins":[{"type":"left","table":"users",
  "on":[{"left":{"join":0,"column":"user_id"},"right":"id"}]}]}`;

const pg: JoinDialect = {
  quote: (n) => `"${n.replace(/"/g, '""')}"`,
  castText: (e) => `${e}::text`,
  numbered: true,
  ilike: "native",
};

describe("parseJoin", () => {
  it("accepts a valid join", () => {
    const spec = parseJoin(JOIN);
    expect(spec.table).toBe("orders");
    expect(spec.joins[0]).toMatchObject({ left: true, table: "users" });
  });

  it("rejects structural violations with BadJoinError", () => {
    const pair = '{"left":{"join":0,"column":"a"},"right":"b"}';
    const entry = `{"type":"left","table":"u","on":[${pair}]}`;
    const cases: Record<string, string> = {
      "not json": "not json",
      array: "[]",
      "no joins": '{"table":"o","joins":[]}',
      "right join": `{"table":"o","joins":[{"type":"right","table":"u","on":[${pair}]}]}`,
      "uppercase type": `{"table":"o","joins":[{"type":"LEFT","table":"u","on":[${pair}]}]}`,
      "no pairs": '{"table":"o","joins":[{"type":"left","table":"u","on":[]}]}',
      "four pairs": `{"table":"o","joins":[{"type":"left","table":"u","on":[${[pair, pair, pair, pair].join(",")}]}]}`,
      "forward position":
        '{"table":"o","joins":[{"type":"left","table":"u","on":[{"left":{"join":1,"column":"a"},"right":"b"}]}]}',
      "negative position":
        '{"table":"o","joins":[{"type":"left","table":"u","on":[{"left":{"join":-1,"column":"a"},"right":"b"}]}]}',
      "fractional position":
        '{"table":"o","joins":[{"type":"left","table":"u","on":[{"left":{"join":0.5,"column":"a"},"right":"b"}]}]}',
      "operator key":
        '{"table":"o","joins":[{"type":"left","table":"u","on":[{"left":{"join":0,"column":"a"},"right":"b","op":">"}]}]}',
      "empty columns": `{"table":"o","joins":[${entry}],"columns":[]}`,
      "duplicate columns": `{"table":"o","joins":[${entry}],"columns":[{"join":0,"column":"a"},{"join":0,"column":"a"}]}`,
      "five tables": `{"table":"o","joins":[${[entry, entry, entry, entry].join(",")}]}`,
      oversize: `{"table":"${"t".repeat(8192)}","joins":[]}`,
      "unknown key": `{"table":"o","joins":[${entry}],"x":1}`,
    };
    for (const [name, raw] of Object.entries(cases)) {
      expect(() => parseJoin(raw), name).toThrow(BadJoinError);
    }
    expect(() => parseJoin(`{"table":"o","joins":[${[entry, entry, entry].join(",")}]}`)).not.toThrow();
  });
});

describe("planJoin", () => {
  it("rejects unknown names, hostile names and incompatible pairs", () => {
    const spec = parseJoin(JOIN);
    expect(() => planJoin(spec, [orders(), users()], opts())).not.toThrow();

    const hostile = parseJoin(JOIN);
    hostile.joins[0].on[0].right = 'id"; drop table users; --';
    expect(() => planJoin(hostile, [orders(), users()], opts())).toThrow(BadJoinError);

    const cross = parseJoin(JOIN);
    cross.joins[0].on[0].left.column = "status";
    expect(() => planJoin(cross, [orders(), users()], opts())).toThrow(/orders\.status \(text\).*users\.id \(uuid\)/);

    const array = parseJoin(JOIN);
    array.joins[0].on[0].left.column = "tags";
    expect(() => planJoin(array, [orders(), users()], opts())).toThrow(BadJoinError);

    const float = parseJoin(JOIN);
    float.joins[0].on[0].left.column = "score";
    const o = orders();
    o.columns.push({ name: "score", type: "double precision" });
    expect(() => planJoin(float, [o, users()], opts())).toThrow(
      /orders\.score \(double precision\).*floating-point values are not compared exactly/,
    );
  });

  it("pairs enums only within one type and rejects differing collations", () => {
    const e = (id: string): JoinColMeta => ({ name: "e", type: "USER-DEFINED", class: { kind: "enum", id } });
    const spec = parseJoin(
      '{"table":"x","joins":[{"type":"inner","table":"y","on":[{"left":{"join":0,"column":"e"},"right":"e"}]}]}',
    );
    const ok = planJoin(
      spec,
      [
        { name: "x", columns: [e("a")] },
        { name: "y", columns: [e("a")] },
      ],
      opts(),
    );
    expect(ok.labels).toEqual(["e_0", "e_1"]);
    expect(() =>
      planJoin(
        spec,
        [
          { name: "x", columns: [e("a")] },
          { name: "y", columns: [e("b")] },
        ],
        opts(),
      ),
    ).toThrow(BadJoinError);

    const bin = { ...text("v"), collation: "utf8mb4_bin" };
    const ci = { ...text("v"), collation: "utf8mb4_general_ci" };
    const clash = parseJoin(
      '{"table":"ca","joins":[{"type":"inner","table":"cb","on":[{"left":{"join":0,"column":"v"},"right":"v"}]}]}',
    );
    expect(() =>
      planJoin(
        clash,
        [
          { name: "ca", columns: [bin] },
          { name: "cb", columns: [ci] },
        ],
        opts(),
      ),
    ).toThrow(/collation/);
  });

  it("range-checks filter and sort positions", () => {
    const spec = parseJoin(JOIN);
    expect(() =>
      planJoin(spec, [orders(), users()], opts({ filter: [{ column: "id", op: "IS NULL", join: 2 }] })),
    ).toThrow(FilterError);
    expect(() => planJoin(spec, [orders(), users()], opts({ sortJoin: 1 }))).toThrow(BadParamError);
    expect(() => planJoin(spec, [orders(), users()], opts({ sort: "email" }))).toThrow(NotAllowedError);
  });
});

describe("assignJoinLabels", () => {
  it("keeps unique names and suffixes the rest without collisions", () => {
    expect(assignJoinLabels(["id", "id", "email", "id_1"], [0, 1, 1, 0])).toEqual(["id_0", "id_1_2", "email", "id_1"]);
    expect(assignJoinLabels(["id", "id", "email"], [0, 1, 1])).toEqual(["id_0", "id_1", "email"]);
  });
});

describe("buildJoinSelect", () => {
  it("uses catalog names and generated aliases only", () => {
    const plan = planJoin(
      parseJoin(JOIN),
      [orders(), users()],
      opts({
        sort: "email",
        sortJoin: 1,
        filter: [
          { column: "email", op: "=", value: "a@b.c", join: 1 },
          { logic: "OR", not: true, column: "status", op: "IS NULL" },
        ],
      }),
    );
    const { body, values } = buildJoinSelect(plan, pg, "public");
    expect(body).toContain('t0."id"::text as c0, ');
    expect(body).toContain(' from "public"."orders" t0 left join "public"."users" t1 on t1."id" = t0."user_id"');
    expect(body).toContain(' where (t1."email"::text = $3) OR (NOT (t0."status"::text IS NULL))');
    expect(body).toMatch(/ order by t1\."email" asc limit \$1 offset \$2$/);
    expect(values).toEqual(["a@b.c"]);
  });
});

describe("filter join key", () => {
  it("is accepted only by parseFilterForJoin", () => {
    const raw = '[{"join":1,"column":"email","op":"IS NULL"}]';
    expect(() => parseFilter(raw)).toThrow(FilterError);
    expect(parseFilterForJoin(raw)[0].join).toBe(1);
    expect(() => parseFilterForJoin('[{"join":-1,"column":"email","op":"IS NULL"}]')).toThrow(FilterError);
  });
});

describe("isQueryTimeout", () => {
  it("recognises every engine's signal and nothing else", () => {
    expect(isQueryTimeout({ code: "57014" })).toBe(true);
    expect(isQueryTimeout({ errno: 3024 })).toBe(true);
    expect(isQueryTimeout({ errno: 1969 })).toBe(true);
    expect(isQueryTimeout({ code: "SQLITE_INTERRUPT" })).toBe(true);
    expect(isQueryTimeout({ code: "42501" })).toBe(false);
    expect(isQueryTimeout(new Error("boom"))).toBe(false);
    expect(isQueryTimeout(null)).toBe(false);
  });
});

describe("pgTypeClass", () => {
  it("maps information_schema types to classes", () => {
    expect(pgTypeClass("integer", "", "", false)).toEqual({ kind: "number" });
    expect(pgTypeClass("numeric", "", "", false)).toEqual({ kind: "number" });
    expect(pgTypeClass("timestamp with time zone", "", "", false)).toEqual({ kind: "temporal" });
    expect(pgTypeClass("USER-DEFINED", "public", "mood", true)).toEqual({ kind: "enum", id: "public.mood" });
    expect(pgTypeClass("USER-DEFINED", "public", "geometry", false)).toBeUndefined();
    for (const t of ["ARRAY", "jsonb", "json", "double precision", "money"]) {
      expect(pgTypeClass(t, "", "", false), t).toBeUndefined();
    }
  });
});

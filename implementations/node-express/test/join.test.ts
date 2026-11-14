import { describe, expect, it } from "vitest";
import { pgColumnClass } from "../src/db/postgres.js";
import { FilterError, isQueryTimeout, NotAllowedError } from "../src/errors.js";
import { formAccepts, parseFilter, parseFilterForJoin, type ValueForm } from "../src/filter.js";
import {
  assignJoinLabels,
  BadJoinError,
  BadParamError,
  buildJoinSelect,
  type ColMeta,
  columnInfo,
  groupUniqueKeys,
  type JoinDialect,
  type JoinOpts,
  joinColumnInfos,
  joinOrderKeys,
  joinTableRefs,
  orderByClause,
  parseJoin,
  planJoin,
  type TableMeta,
  tableSchemas,
  tableWhereClause,
  tieBreakKeys,
} from "../src/join.js";

const uuid = (name: string): ColMeta => ({ name, type: "uuid", class: { kind: "uuid" } });
const text = (name: string): ColMeta => ({ name, type: "text", class: { kind: "text" } });

const orders = (): TableMeta => ({
  schema: "public",
  name: "orders",
  columns: [uuid("id"), uuid("user_id"), text("status"), { name: "tags", type: "ARRAY", class: { kind: "array" } }],
  orderKeys: [0],
});
const users = (): TableMeta => ({
  schema: "public",
  name: "users",
  columns: [uuid("id"), text("email")],
  orderKeys: [0],
});

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
  castParam: (p, t) => `${p}::${t}`,
  numbered: true,
  ilike: "native",
};

describe("row order (spec/protocol.md §5.4)", () => {
  it("prefers the primary key, then the shortest unique key, then the lowest name", () => {
    const cols = orders().columns;
    const pk = { name: "z_pkey", primary: true, columns: ["status", "id"] };
    const short = { name: "b", primary: false, columns: ["user_id"] };
    const tied = { name: "a", primary: false, columns: ["status"] };
    const hidden = { name: "0", primary: false, columns: ["hidden"] };
    expect(tieBreakKeys(cols, [short, pk])).toEqual([2, 0]);
    expect(tieBreakKeys(cols, [short, tied, hidden])).toEqual([2]);
    expect(tieBreakKeys(cols, [])).toEqual([]);
  });

  it("drops a key with an unusable part", () => {
    expect(
      groupUniqueKeys([
        { index: "a", primary: false, column: "x", usable: true },
        { index: "a", primary: false, column: "y", usable: false },
        { index: "b", primary: false, column: "x", usable: true },
      ]),
    ).toEqual([{ name: "b", primary: false, columns: ["x"] }]);
  });

  it("leaves out a key already used as sort", () => {
    const render = (i: number) => `c${i}`;
    expect(orderByClause(1, [1, 0], true, render)).toBe(" order by c1 desc, c0 desc");
    // order applies only with a sort.
    expect(orderByClause(undefined, [0], true, render)).toBe(" order by c0 asc");
    expect(orderByClause(undefined, [], false, render)).toBe("");
  });
});

describe("joinOrderKeys (spec/protocol.md §5.11.3)", () => {
  const keyed = (name: string, cols: [string, string][], ...orderKeys: number[]): TableMeta => ({
    name,
    columns: cols.map(([n, type]) => ({ name: n, type, class: { kind: "number" } })),
    orderKeys,
  });
  const int = (n: string): [string, string] => [n, "int4"];

  it("leaves out a key fully bound to a fixed table, column by column if composite", () => {
    expect(joinOrderKeys([keyed("a", [int("id"), int("b_id")], 0), keyed("b", [int("id")], 0)], [[[0, 1, 0]]])).toEqual(
      [[0, 0]],
    );
    const a = keyed("a", [int("id"), int("x"), int("y")], 0);
    const b = keyed("b", [int("x"), int("y")], 0, 1);
    expect(
      joinOrderKeys(
        [a, b],
        [
          [
            [0, 2, 1],
            [0, 1, 0],
          ],
        ],
      ),
    ).toEqual([[0, 0]]);
  });

  it("keeps a partly bound key", () => {
    const b = keyed("b", [int("x"), int("y")], 0, 1);
    expect(joinOrderKeys([keyed("a", [int("id"), int("x")], 0), b], [[[0, 1, 0]]])).toEqual([
      [0, 0],
      [1, 0],
      [1, 1],
    ]);
  });

  it("keeps a key bound across types or collations", () => {
    const b = keyed("b", [int("id")], 0);
    expect(joinOrderKeys([keyed("a", [int("id"), ["b_id", "int8"]], 0), b], [[[0, 1, 0]]])).toEqual([
      [0, 0],
      [1, 0],
    ]);
    const a = keyed("a", [int("id"), ["b_code", "text"]], 0);
    a.columns[1].collation = "C";
    expect(joinOrderKeys([a, keyed("b", [["code", "text"]], 0)], [[[0, 1, 0]]])).toEqual([
      [0, 0],
      [1, 0],
    ]);
  });

  it("keeps a key bound to a keyless table", () => {
    expect(joinOrderKeys([keyed("v", [int("b_id")]), keyed("b", [int("id")], 0)], [[[0, 0, 0]]])).toEqual([[1, 0]]);
  });

  it("counts a left-out table as fixed, and one binding from a fixed table is enough", () => {
    const chain = [
      keyed("a", [int("id"), int("b_id")], 0),
      keyed("b", [int("id"), int("c_id")], 0),
      keyed("c", [int("id")], 0),
    ];
    expect(joinOrderKeys(chain, [[[0, 1, 0]], [[1, 1, 0]]])).toEqual([[0, 0]]);
    const mixed = [keyed("v", [int("b_id")]), keyed("a", [int("id"), int("b_id")], 0), keyed("b", [int("id")], 0)];
    expect(
      joinOrderKeys(mixed, [
        [[0, 0, 1]],
        [
          [0, 0, 0],
          [1, 1, 0],
        ],
      ]),
    ).toEqual([[1, 0]]);
  });
});

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
    o.columns.push({ name: "score", type: "double precision", class: { kind: "float" } });
    expect(() => planJoin(float, [o, users()], opts())).toThrow(
      /orders\.score \(double precision\).*floating-point values are not compared exactly/,
    );
  });

  it("pairs enums only within one type and rejects differing collations", () => {
    const e = (id: string): ColMeta => ({ name: "e", type: "USER-DEFINED", class: { kind: "enum", enumType: id } });
    const spec = parseJoin(
      '{"table":"x","joins":[{"type":"inner","table":"y","on":[{"left":{"join":0,"column":"e"},"right":"e"}]}]}',
    );
    const ok = planJoin(
      spec,
      [
        { name: "x", columns: [e("a")], orderKeys: [] },
        { name: "y", columns: [e("a")], orderKeys: [] },
      ],
      opts(),
    );
    expect(ok.labels).toEqual(["e_0", "e_1"]);
    expect(() =>
      planJoin(
        spec,
        [
          { name: "x", columns: [e("a")], orderKeys: [] },
          { name: "y", columns: [e("b")], orderKeys: [] },
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
          { name: "ca", columns: [bin], orderKeys: [] },
          { name: "cb", columns: [ci], orderKeys: [] },
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

describe("columnInfo", () => {
  it("reports a collation only for a text column", () => {
    const named: ColMeta = { name: "name", type: "varchar(20)", class: { kind: "text" }, collation: "utf8mb4_bin" };
    const doc: ColMeta = { name: "doc", type: "json", class: { kind: "json" }, collation: "utf8mb4_bin" };
    expect(columnInfo(named).collation).toBe("utf8mb4_bin");
    expect(columnInfo(doc).collation).toBeUndefined();
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
    const { body, values } = buildJoinSelect(plan, pg);
    expect(body).toContain('t0."id"::text as c0, ');
    expect(body).toContain(' from "public"."orders" t0 left join "public"."users" t1 on t1."id" = t0."user_id"');
    expect(body).toContain(' where (t1."email"::text = $3) OR (NOT (t0."status"::text IS NULL))');
    expect(body).toMatch(/ order by t1\."email" asc, t0\."id" asc limit \$1 offset \$2$/);
    expect(values).toEqual(["a@b.c"]);
  });

  it("compares a typed column in its own type and checks its values", () => {
    const withTotal = orders();
    withTotal.columns.push({
      name: "total",
      type: "integer",
      class: { kind: "number" },
      compare: { form: "pg-numeric", cast: "numeric", intCast: "int8" },
    });
    const plan = planJoin(
      parseJoin(JOIN),
      [withTotal, users()],
      opts({
        filter: [
          { column: "total", op: "BETWEEN", value: ["1", "9.5"] },
          { logic: "AND", not: true, column: "status", op: "IN", value: ["a", "b"] },
          { logic: "OR", column: "total", op: "LIKE", value: "1%" },
        ],
      }),
    );
    const { body, values } = buildJoinSelect(plan, pg);
    expect(body).toContain(
      ' where (t0."total" BETWEEN $3::int8 AND $4::numeric) AND (NOT (t0."status"::text IN ($5, $6)))' +
        ' OR (t0."total"::text LIKE $7)',
    );
    expect(values).toEqual(["1", "9.5", "a", "b", "1%"]);
    expect(() =>
      planJoin(
        parseJoin(JOIN),
        [withTotal, users()],
        opts({ filter: [{ column: "total", op: "IN", value: ["1", "x"] }] }),
      ),
    ).toThrow(/"x" for column "total"/);
  });
});

describe("value forms (spec/protocol.md §5.4.2)", () => {
  const cases: [ValueForm, string, boolean][] = [
    ["mysql-decimal", "-12", true],
    ["mysql-decimal", "+3.25", true],
    ["mysql-decimal", "0.5", true],
    ["mysql-decimal", ".5", false],
    ["mysql-decimal", "5.", false],
    ["mysql-decimal", "1e3", false],
    ["mysql-decimal", "abc", false],
    ["mysql-decimal", "", false],
    ["mysql-decimal", "NaN", false],
    ["mysql-decimal", "9".repeat(35), true],
    ["mysql-decimal", "9".repeat(36), false],
    ["mysql-float", "1.5e-3", true],
    ["mysql-float", "2E10", true],
    ["mysql-float", "1e", false],
    ["mysql-float", "NaN", false],
    ["mysql-date", "2016-02-29", true],
    ["mysql-date", "2015-02-29", false],
    ["mysql-date", "2016-02-30", false],
    ["mysql-date", "0000-00-00", true],
    ["mysql-date", "0000-01-01", false],
    ["mysql-date", "12000-01-01", false],
    ["mysql-date", "2016-01-01 10:00", false],
    ["mysql-datetime", "2016-01-01", true],
    ["mysql-datetime", "2016-01-01 10:30", true],
    ["mysql-datetime", "2016-01-01T10:30:00.123456", true],
    ["mysql-datetime", "0000-00-00 00:00:00", true],
    ["mysql-datetime", "2016-01-01T10:30:00.1234567", false],
    ["mysql-datetime", "2016-01-01T10:30:00Z", false],
    ["mysql-datetime", "2016-01-01 ", false],
    ["mysql-datetime", "2016-01-01 24:00", false],
    ["mysql-time", "23:59:59", true],
    ["mysql-time", "-01:00:00", true],
    ["mysql-time", "100:00:00.5", true],
    ["mysql-time", "838:59:59", true],
    ["mysql-time", "839:00:00", false],
    ["mysql-time", "9:30", false],
    ["mysql-time", "10:60", false],
    ["pg-numeric", "-12", true],
    ["pg-numeric", "9".repeat(40), true],
    ["pg-numeric", "NaN", true],
    ["pg-numeric", "-Infinity", true],
    ["pg-numeric", "1e3", false],
    ["pg-numeric", "abc", false],
    ["pg-float", "1e+300", true],
    ["pg-float", "infinity", true],
    ["pg-float", "1e", false],
    ["pg-date", "2016-02-29", true],
    ["pg-date", "2016-02-30", false],
    ["pg-date", "12000-01-01", true],
    ["pg-date", "0044-03-15 BC", true],
    ["pg-date", "0001-02-29 BC", true],
    ["pg-date", "0002-02-29 BC", false],
    ["pg-date", "infinity", true],
    ["pg-date", "-infinity", true],
    ["pg-date", "0000-01-01", false],
    ["pg-date", "0000-00-00", false],
    ["pg-timestamp", "2016-01-01 10:30", true],
    ["pg-timestamp", "0044-03-15 10:00:00 BC", true],
    ["pg-timestamp", "12000-01-01 10:00:00", true],
    ["pg-timestamp", "2016-01-01 24:00:00", true],
    ["pg-timestamp", "infinity", true],
    ["pg-timestamp", "2016-01-01T10:30:00Z", false],
    ["pg-time", "23:59:59", true],
    ["pg-time", "24:00", true],
    ["pg-time", "24:00:00.000", true],
    ["pg-time", "24:00:01", false],
    ["pg-time", "10:60", false],
    ["pg-time", "9:30", false],
    ["pg-time", "10:00+02", false],
    ["pg-timestamptz", "2016-01-01 10:00:00+00", true],
    ["pg-timestamptz", "2016-01-01T10:00:00.5+05:30", true],
    ["pg-timestamptz", "1890-01-01 00:00:00+00:53:28", true],
    ["pg-timestamptz", "0044-03-15 10:00:00+00:53:28 BC", true],
    ["pg-timestamptz", "2016-01-01 10:00-0300", true],
    ["pg-timestamptz", "2016-01-01 10:00Z", true],
    ["pg-timestamptz", "2016-01-01", true],
    ["pg-timestamptz", "-infinity", true],
    ["pg-timestamptz", "2016-01-01Z", false],
    ["pg-timestamptz", "2016-01-01 10:00+5", false],
    ["pg-timestamptz", "2016-01-01 10:00+05:3", false],
    ["pg-timetz", "10:00:00+02", true],
    ["pg-timetz", "24:00:00+00", true],
    ["pg-timetz", "10:00", true],
    ["pg-timetz", "10:00+", false],
  ];
  for (const [form, v, ok] of cases) {
    it(`${form} ${JSON.stringify(v)} → ${ok}`, () => expect(formAccepts(form, v)).toBe(ok));
  }
});

describe("own schema", () => {
  it("parses per table and rejects a wrong type or an unlisted schema", () => {
    const spec = parseJoin(
      '{"table":"shipments","schema":"warehouse","joins":[{"type":"left","table":"orders","schema":"public",' +
        '"on":[{"left":{"join":0,"column":"order_id"},"right":"id"}]}]}',
    );
    expect(joinTableRefs(spec)).toEqual([
      { schema: "warehouse", table: "shipments" },
      { schema: "public", table: "orders" },
    ]);
    const on = '"on":[{"left":{"join":0,"column":"user_id"},"right":"id"}]';
    for (const bad of [
      `{"table":"orders","schema":1,"joins":[{"type":"left","table":"users",${on}}]}`,
      `{"table":"orders","schema":null,"joins":[{"type":"left","table":"users",${on}}]}`,
      `{"table":"orders","joins":[{"type":"left","table":"users","schema":["public"],${on}}]}`,
    ]) {
      expect(() => parseJoin(bad), bad).toThrow(BadJoinError);
    }
    expect(() => tableSchemas(joinTableRefs(spec), "public", ["public"])).toThrow(BadJoinError);
  });

  it("splices and reports a table in another schema under it", () => {
    const u = users();
    u.schema = "warehouse";
    const plan = planJoin(parseJoin(JOIN), [orders(), u], opts());
    expect(buildJoinSelect(plan, pg).body).toContain(' from "public"."orders" t0 left join "warehouse"."users" t1 ');
    for (const c of joinColumnInfos(plan, "public")) {
      expect(c.schema, `${c.table}.${c.column}`).toBe(c.table === "users" ? "warehouse" : undefined);
    }
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

describe("pgColumnClass", () => {
  it("maps information_schema types to classes", () => {
    expect(pgColumnClass("integer", "", "", false)).toEqual({ kind: "number" });
    expect(pgColumnClass("numeric", "", "", false)).toEqual({ kind: "number" });
    expect(pgColumnClass("timestamp with time zone", "", "", false)).toEqual({ kind: "temporal" });
    expect(pgColumnClass("USER-DEFINED", "public", "mood", true)).toEqual({ kind: "enum", enumType: "public.mood" });
    expect(pgColumnClass("USER-DEFINED", "public", "geometry", false)).toEqual({ kind: "other" });
    expect(pgColumnClass("USER-DEFINED", "public", "citext", false)).toEqual({ kind: "text" });
    for (const [t, kind] of [
      ["ARRAY", "array"],
      ["jsonb", "json"],
      ["json", "json"],
      ["double precision", "float"],
      ["real", "float"],
      ["smallint", "number"],
      ["date", "temporal"],
      ["timestamp without time zone", "temporal"],
      ["time without time zone", "time"],
      ["time with time zone", "time"],
      ["money", "other"],
    ] as const) {
      expect(pgColumnClass(t, "", "", false), t).toEqual({ kind });
    }
  });
});

describe("a MySQL zero date", () => {
  it("compares the column's text", () => {
    const table: TableMeta = {
      name: "t",
      orderKeys: [],
      columns: [{ name: "d", type: "date", class: { kind: "temporal" }, compare: { form: "mysql-date" } }],
    };
    for (const [value, want] of [
      ["2016-02-29", ' where ("d" = $3)'],
      ["0000-00-00", ' where ("d"::text = $3)'],
    ] as const) {
      expect(tableWhereClause([{ column: "d", op: "=", value }], table, pg).where).toBe(want);
    }
    expect(tableWhereClause([{ column: "d", op: "IN", value: ["2016-02-29", "0000-00-00"] }], table, pg).where).toBe(
      ' where ("d"::text IN ($3, $4))',
    );
  });
});

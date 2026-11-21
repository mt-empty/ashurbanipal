import { describe, expect, it } from "vitest";
import { pgColumnClass, JOIN_DIALECT as pgDialect } from "../src/db/postgres.js";
import { FilterError, isQueryTimeout } from "../src/errors.js";
import { formAccepts, parseFilter, parseFilterForJoin, type ValueForm } from "../src/filter.js";
import {
  type ColMeta,
  columnInfo,
  groupUniqueKeys,
  type JoinOpts,
  joinColumnInfos,
  parseJoin,
  planJoin,
  type TableMeta,
  tableWhereClause,
} from "../src/join.js";

// Planning and SQL building are covered per engine by spec/fixtures/join-builder-tests.json (join-fixture.test.ts).

const uuid = (name: string): ColMeta => ({ name, type: "uuid", class: { kind: "uuid" } });
const text = (name: string): ColMeta => ({ name, type: "text", class: { kind: "text" } });

const orders = (): TableMeta => ({
  schema: "public",
  name: "orders",
  columns: [uuid("id"), uuid("user_id")],
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

describe("groupUniqueKeys", () => {
  it("drops a key with an unusable part", () => {
    expect(
      groupUniqueKeys([
        { index: "a", primary: false, column: "x", usable: true },
        { index: "a", primary: false, column: "y", usable: false },
        { index: "b", primary: false, column: "x", usable: true },
      ]),
    ).toEqual([{ name: "b", primary: false, columns: ["x"] }]);
  });
});

describe("planJoin", () => {
  it("says why a float key cannot join", () => {
    const float = parseJoin(JOIN);
    float.joins[0].on[0].left.column = "score";
    const o = orders();
    o.columns.push({ name: "score", type: "double precision", class: { kind: "float" } });
    expect(() => planJoin(float, [o, users()], opts())).toThrow(
      /orders\.score \(double precision\).*floating-point values are not compared exactly/,
    );
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

describe("joinColumnInfos", () => {
  it("reports a table in another schema under it", () => {
    const u = users();
    u.schema = "warehouse";
    const plan = planJoin(parseJoin(JOIN), [orders(), u], opts());
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

describe("a MySQL zero date on the table route", () => {
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
      expect(tableWhereClause([{ column: "d", op: "=", value }], table, pgDialect).where).toBe(want);
    }
    expect(
      tableWhereClause([{ column: "d", op: "IN", value: ["2016-02-29", "0000-00-00"] }], table, pgDialect).where,
    ).toBe(' where ("d"::text IN ($3, $4))');
  });
});

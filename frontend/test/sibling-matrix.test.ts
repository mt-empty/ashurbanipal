import assert from "node:assert/strict";
import { test } from "node:test";
import type { Sibling } from "../src/core/types.ts";
import { buildSiblingMatrix, listSiblings, type MatrixCell, sameViewHref } from "../src/lib/sibling-matrix.ts";

const sib = (name: string, label?: string, healthy = true): Sibling => ({
  name,
  ...(label !== undefined && { label }),
  base_url: `https://${name}-${label ?? "x"}.example/__ashurbanipal`,
  healthy,
});

// "here", "-" for missing, the label for a link, "=label" for a same-view link.
const show = (cell: MatrixCell) =>
  cell.kind === "here" ? "here" : cell.kind === "missing" ? "-" : `${cell.sameView ? "=" : ""}${cell.sibling.label}`;

test("nothing labelled keeps the flat list", () => {
  assert.equal(buildSiblingMatrix({ siblings: [sib("billing")] }), null);
  assert.equal(buildSiblingMatrix({ siblings: [] }), null);
});

test("rows and columns follow the list, the same on every instance sharing it", () => {
  const list = [
    sib("orders", "dev"),
    sib("orders", "int"),
    sib("billing", "dev"),
    sib("billing", "int"),
    sib("users", "prod"),
  ];
  const dev = buildSiblingMatrix({ instance: { name: "orders", label: "dev" }, siblings: list });
  const int = buildSiblingMatrix({ instance: { name: "orders", label: "int" }, siblings: list });
  assert.ok(dev && int);
  assert.deepEqual(dev.labels, ["dev", "int", "prod"]);
  assert.deepEqual(int.labels, dev.labels);
  assert.deepEqual(
    dev.rows.map((r) => [r.name, ...r.cells.map(show)]),
    [
      ["orders", "here", "=int", "-"],
      ["billing", "dev", "int", "-"],
      ["users", "-", "-", "prod"],
    ],
  );
  assert.deepEqual(
    int.rows.map((r) => [r.name, ...r.cells.map(show)]),
    [
      ["orders", "=dev", "here", "-"],
      ["billing", "dev", "int", "-"],
      ["users", "-", "-", "prod"],
    ],
  );
  assert.equal(int.ownLabel, "int");
});

test("an instance its own list leaves out goes first", () => {
  const m = buildSiblingMatrix({
    instance: { name: "orders", label: "dev" },
    siblings: [sib("billing", "int"), sib("billing", "prod")],
  });
  assert.ok(m);
  assert.deepEqual(m.labels, ["dev", "int", "prod"]);
  assert.deepEqual(
    m.rows.map((r) => r.name),
    ["orders", "billing"],
  );
});

test("labels without an instance give a grid with no here and no same view", () => {
  const m = buildSiblingMatrix({ siblings: [sib("orders", "dev"), sib("orders", "int")] });
  assert.ok(m);
  assert.deepEqual(m.labels, ["dev", "int"]);
  assert.deepEqual(m.rows[0].cells.map(show), ["dev", "int"]);
});

test("an instance with no labelled siblings still shows its own cell", () => {
  const m = buildSiblingMatrix({ instance: { name: "orders", label: "dev" }, siblings: [sib("billing")] });
  assert.ok(m);
  assert.deepEqual(
    m.rows.map((r) => [r.name, ...r.cells.map(show)]),
    [["orders", "here"]],
  );
  assert.deepEqual(
    m.listed.map((l) => l.sibling.name),
    ["billing"],
  );
});

test("a duplicate name and label fills the cell once and is listed after the grid", () => {
  const first = sib("billing", "dev", true);
  const copy = { ...sib("billing", "dev", false), base_url: "https://billing-dev-2.example/__ashurbanipal" };
  const m = buildSiblingMatrix({
    instance: { name: "orders", label: "dev" },
    siblings: [sib("orders", "dev"), sib("orders", "dev"), first, copy],
  });
  assert.ok(m);
  const billing = m.rows.find((r) => r.name === "billing");
  assert.equal(billing?.cells[0].kind === "link" && billing.cells[0].sibling, first);
  assert.deepEqual(
    m.listed.map((l) => [l.sibling.name, l.note]),
    [
      ["orders", "dev · duplicate"],
      ["billing", "dev · duplicate"],
    ],
  );
});

test("repeated unlabelled names are told apart by host", () => {
  const audit = (host: string): Sibling => ({
    name: "audit",
    base_url: `https://${host}/__ashurbanipal`,
    healthy: true,
  });
  const m = buildSiblingMatrix({
    siblings: [sib("orders", "dev"), audit("audit-dev"), audit("audit-int"), sib("users")],
  });
  assert.ok(m);
  assert.deepEqual(
    m.listed.map((l) => [l.sibling.name, l.note]),
    [
      ["audit", "audit-dev"],
      ["audit", "audit-int"],
      ["users", undefined],
    ],
  );
  assert.deepEqual(
    listSiblings([audit("a.example:8080"), audit("b.example")]).map((l) => l.note),
    ["a.example:8080", "b.example"],
  );
});

test("same-view hrefs append the query string to the mount", () => {
  assert.equal(
    sameViewHref("https://o.example/__ashurbanipal", "?table=orders"),
    "https://o.example/__ashurbanipal?table=orders",
  );
  assert.equal(
    sameViewHref("https://o.example/__ashurbanipal/", "?table=orders"),
    "https://o.example/__ashurbanipal?table=orders",
  );
  assert.equal(sameViewHref("https://o.example/__ashurbanipal", ""), "https://o.example/__ashurbanipal");
});

test("a base_url with its own query or fragment keeps both", () => {
  assert.equal(
    sameViewHref("https://o.example/__ashurbanipal?tenant=a", "?table=orders"),
    "https://o.example/__ashurbanipal?tenant=a&table=orders",
  );
  assert.equal(
    sameViewHref("https://o.example/__ashurbanipal#top", "?table=orders"),
    "https://o.example/__ashurbanipal?table=orders#top",
  );
});

test("an unparseable base_url is returned unchanged", () => {
  assert.equal(sameViewHref("not a url", "?table=orders"), "not a url");
});

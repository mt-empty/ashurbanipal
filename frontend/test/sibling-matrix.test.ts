import assert from "node:assert/strict";
import { test } from "node:test";
import type { Sibling } from "../src/core/types.ts";
import { buildSiblingMatrix, type MatrixCell, sameViewHref } from "../src/lib/sibling-matrix.ts";

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

test("the instance's row and column come first, the rest in first-appearance order", () => {
  const m = buildSiblingMatrix({
    instance: { name: "orders", label: "dev" },
    siblings: [sib("billing", "int"), sib("billing", "dev"), sib("orders", "int"), sib("users", "staging")],
  });
  assert.ok(m);
  assert.deepEqual(m.labels, ["dev", "int", "staging"]);
  assert.deepEqual(
    m.rows.map((r) => [r.name, ...r.cells.map(show)]),
    [
      ["orders", "here", "=int", "-"],
      ["billing", "dev", "int", "-"],
      ["users", "-", "-", "staging"],
    ],
  );
  assert.deepEqual(
    m.rows.map((r) => r.isInstance),
    [true, false, false],
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
    m.unlabelled.map((s) => s.name),
    ["billing"],
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

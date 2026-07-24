import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { APP_PATH } from "./support/helpers";

// Fixture-driven runner for the page's DSL parser — the single canonical
// implementation of spec/filter-dsl.md, reachable only through the
// window.__ashurbanipal test hook (the file is a module; its scope is
// otherwise sealed). Cases come from spec/fixtures/parser-tests.json,
// generated from the doc's §5 V/R/A table.
const fixtureUrl = new URL("../../../spec/fixtures/parser-tests.json", import.meta.url);

type ParserCase = {
  name: string;
  input: string;
  expect?: unknown[];
  expect_error?: { position?: number };
};

const cases: ParserCase[] = JSON.parse(readFileSync(fixtureUrl, "utf8")).cases;
const byPrefix = (prefix: string) => cases.filter((c) => c.name.startsWith(prefix));

type ParserResult =
  | { ast: unknown[] }
  | { error: { message: string; position: number | undefined } };

async function openParser(page: Page) {
  await page.goto(APP_PATH);
  // The parser hook exists as soon as the module script ran — no need to
  // wait for table data.
  await page.waitForFunction(() => "__ashurbanipal" in window);
}

function runCases(page: Page, batch: ParserCase[]): Promise<ParserResult[]> {
  return page.evaluate(
    (inputs) =>
      inputs.map((input) => {
        try {
          return { ast: (window as any).__ashurbanipal.parseFilterDsl(input) };
        } catch (e: any) {
          return { error: { message: String(e.message), position: e.position } };
        }
      }),
    batch.map((c) => c.input),
  );
}

async function assertCases(page: Page, batch: ParserCase[]) {
  const results = await runCases(page, batch);
  for (const [i, c] of batch.entries()) {
    const result = results[i];
    if (c.expect) {
      expect.soft(result, `case ${c.name} (${JSON.stringify(c.input.slice(0, 60))})`).toEqual({
        ast: c.expect,
      });
    } else {
      expect.soft("error" in result, `case ${c.name} should be rejected`).toBe(true);
      if (!("error" in result)) continue;
      // Every parse error carries a byte offset (spec/filter-dsl.md §4);
      // the exact value is asserted only where the fixture pins it.
      expect.soft(result.error.message, `case ${c.name} error carries an offset`).toMatch(
        / at position \d+$/,
      );
      if (c.expect_error?.position !== undefined) {
        expect.soft(result.error.position, `case ${c.name} byte offset`).toBe(
          c.expect_error.position,
        );
      }
    }
  }
}

test("valid cases (V*) emit the exact wire AST", async ({ page }) => {
  await openParser(page);
  await assertCases(page, byPrefix("V"));
});

test("rejected cases (R*) fail client-side with a byte offset", async ({ page }) => {
  await openParser(page);
  await assertCases(page, byPrefix("R"));
});

test("adversarial cases (A*) parse to bind-safe ASTs or reject — never crash", async ({ page }) => {
  await openParser(page);
  await assertCases(page, byPrefix("A"));
});

// The composition side (click-to-filter, FK nav, common values) writes text
// the parser must accept back — the V9/V12/V15/V21 quoting shapes are the
// ones most likely to silently diverge (spec/filter-dsl.md §6).
test("quoteFilterValue output round-trips through the parser unchanged", async ({ page }) => {
  await openParser(page);
  const values = ["it's fine", "AND", "", "NOT", "% smith%", "plain"];
  const roundTripped = await page.evaluate((vals) => {
    const { parseFilterDsl, quoteFilterValue } = (window as any).__ashurbanipal;
    return vals.map((v: string) => parseFilterDsl(`col = ${quoteFilterValue(v)}`)[0].value);
  }, values);
  expect(roundTripped).toEqual(values);
});

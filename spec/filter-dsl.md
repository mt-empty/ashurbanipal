# Filter DSL — grammar and test plan

Status: normative, for the **frontend's** parser
Scope: this document specs the grammar the `dbviewer.html` JS parser must
satisfy when converting the `#filter` box's text into the JSON filter AST
(`spec/protocol.md` §5.4.2). Parsing is client-side only: no backend —
reference or port — parses DSL text; the backend contract is the AST, and
everything a server must do with it (column allow-listing, operator
mapping, value binding, limits) lives in `spec/protocol.md`.
History: the grammar was originally implemented server-side (in the Rust
crate's `filter.rs`) against this same document and its test table; the
parsing obligation moved to the frontend when the wire format became the
AST.

Prior art considered: RSQL/FIQL (the established REST filter syntax) and the
`postgrest-parser` crate. Neither is used directly — the existing Rust RSQL
crate is undocumented, and `postgrest-parser` is a weeks-old 0.x — but the
shape below deliberately stays close to RSQL's `field op value` conjunction
style so nothing here is novel. The parser is hand-written (~8 operators, no
nesting; small enough that owning the security-critical path outweighs a
dependency).

## 1. Shape

```
condition (AND|OR condition)*
condition := [NOT] simple_condition
simple_condition := column OP value
           | column IS NULL
           | column IS NOT NULL
```

Flat chain of conditions. **No parentheses, no nesting.** `AND` binds
tighter than `OR` (SQL convention), so `a = 1 OR b = 2 AND c = 3` means
`a = 1 OR (b = 2 AND c = 3)`.

`NOT` is a prefix on a single `simple_condition` only — `NOT status = active`,
never a general boolean operator over a compound expression. This is exactly
how unparenthesized real SQL already behaves (`NOT` binds tighter than `AND`,
which binds tighter than `OR`, and without parens it can only ever reach one
predicate), so supporting it doesn't reopen the no-parens/no-nesting
restriction — `NOT` is fully resolved within `condition` before the
`AND`/`OR` chain logic ever runs.

## 2. Grammar (EBNF)

```ebnf
filter      = condition , { ws , logic , ws , condition } ;
logic       = "AND" | "OR" ;                        (* case-insensitive *)
condition   = [ "NOT" , ws ] , simple_condition ;
simple_condition
            = column , ows , operator , ows , value
            | column , ws , "IS" , ws , [ "NOT" , ws ] , "NULL" ;
column      = ( letter | "_" ) , { letter | digit | "_" } ;
operator    = "=" | "!=" | ">=" | "<=" | ">" | "<" | "LIKE" | "ILIKE" ;
value       = quoted | bare ;
quoted      = "'" , { any-char-except-quote | "''" } , "'" ;
bare        = { any-char-except-ws-and-quote }- ;   (* no spaces, non-empty *)
ws          = whitespace , { whitespace } ;         (* required *)
ows         = { whitespace } ;                      (* optional *)
```

Notes:

- **Keywords** (`AND`, `OR`, `IS`, `NOT`, `NULL`, `LIKE`, `ILIKE`) are
  case-insensitive. Column names are matched case-sensitively against the
  schema allow-list.
- **Whitespace** around symbolic operators is optional (`status=completed`
  is valid); word operators (`LIKE`, `ILIKE`, `IS NULL`, `AND`, `OR`, `NOT`)
  require surrounding whitespace.
- **`NOT` only appears where a `condition` can start** — the very
  beginning of the filter, or immediately after `AND`/`OR`. It's
  zero-or-one (`[ "NOT" , ws ]`), not recursive: `NOT NOT status = active`
  is a parse error, not a double negation that cancels out. There's no
  mid-predicate `NOT` (`status NOT = active`, `email NOT LIKE 'x'`) — the
  prefix form covers every predicate kind uniformly, so a second
  mid-predicate mechanism would just be redundant surface area.
- **Values**: a bare value runs to the next whitespace. Values containing
  spaces, quotes, or the words `AND`/`OR`/`NOT` must be single-quoted; a
  literal `'` inside a quoted value is escaped by doubling (`''`), as in
  SQL. `''` (empty quoted string) is a valid value; a bare value can't be
  empty. `AND`/`OR`/`NOT` are always treated as keywords wherever a bare
  token could occur — not just where they're structurally ambiguous — so
  the rule stays one sentence instead of three position-dependent
  exceptions.
- **Bare values are otherwise unrestricted** — `18d852af-…`, `2016-01-01`,
  `%foo%`, `{"a":1}` are all fine. The value never reaches SQL text (it's
  always a bind parameter), so the grammar doesn't need to police its
  contents.
- **Longest-match** on symbolic operators: `>=`/`<=` are tried before
  `>`/`<`, so `a >=1` is `>=` + bare value `1`. With an explicit space,
  `a > =1` is `>` + bare value `=1` (bare values are whitespace-delimited).
  Both are well-defined; neither is ambiguous.

## 3. Semantics

- Parser output is the wire AST (`spec/protocol.md` §5.4.2): an array of
  `{logic?, not?, column, op, value?}` condition objects — the parser
  never produces SQL text, and never validates a column against the
  schema. `logic` is absent on the first condition and carries the
  joining `AND`/`OR` on every subsequent one; `not` reflects the prefix
  `NOT`; `value` is absent exactly for `IS NULL`/`IS NOT NULL`.
- What the server then does with the AST — validating each `column`
  against the live schema allow-list, mapping each `op` through a
  hardcoded SQL-fragment table, binding every `value` as a parameter
  against the text-cast column — is the server's contract, specified in
  `spec/protocol.md` §5.4.2 (evaluation rules) and §6, not here.
- `LIKE`/`ILIKE` pass `%`/`_` through to Postgres untranslated — the user
  writes Postgres patterns directly. `ILIKE` is Postgres's own
  case-insensitive `LIKE`; same passthrough, case-insensitive at the
  database level.
- `NOT` doesn't invert the operator: the parser emits the same `op` with
  `not: true`, and the server negates at the SQL-fragment level
  (`NOT (column::text = $n)` — `spec/protocol.md` §5.4.2), so `NOT` never
  needs its own operator mapping to keep in sync.
- Known v1 limitation (deliberate): the uniform `::text` cast makes
  `>`/`<`/`>=`/`<=` **lexicographic**. Correct for ISO-8601 timestamps and
  equal-length strings; wrong for numerics (`"10" < "9"`). Documented in the
  UI later; typed casting is a post-v1 improvement, not a v1 requirement.
- Duplicate/contradictory conditions (`status = 'a' AND status = 'b'`) are
  legal and simply return zero rows — the parser doesn't do satisfiability
  analysis.
- Limits: ≤ 10 conditions — the parser rejects an 11th rather than emit
  an AST the server would refuse. The server independently enforces the
  same condition cap plus a byte bound on the JSON-encoded `filter`
  param (`spec/protocol.md` §5.4.2); cheap guardrails against
  pathological input, always a rejection, never a truncated query.

## 4. Error behavior

Any parse failure → an inline, client-side error with the byte offset
(`unexpected token at position 17`), surfaced before any request is sent.
The parser never "best-effort" submits a partially-parsed filter. (Server
rejections — unknown column, structural AST violations — are separate,
arrive as HTTP 400s per `spec/protocol.md` §2, and can still occur on a
filter that parsed cleanly.)

## 5. Test table

This table specs the **frontend parser**. It must pass all of these
before a change to the parser is considered done. `✓` = parses, with the
expected conditions in the emitted AST; `✗` = rejected client-side with a
parse error (§4). Machine-readable fixtures
(`spec/fixtures/parser-tests.json`) are generated from this table — it
remains the human-readable source of truth. (Server-side rejections in
the A-cases below — the schema allow-list — are backend conformance
territory, `spec/protocol.md` §5.4.2, exercised through AST-level
fixtures, not this table.)

### Valid

| # | Input | Expect |
|---|-------|--------|
| V1 | `status = completed` | `(status, =, "completed")` |
| V2 | `status=completed` | same as V1 (no-space symbolic op) |
| V3 | `session_id = 18d852af-77ae-4a95-9f7d-e37a77fda2fd` | uuid as bare value |
| V4 | `created_at > 2016-01-01` | `(created_at, >, "2016-01-01")` |
| V5 | `a >= 1 AND b <= 2` | two conditions, AND |
| V6 | `status = completed AND created_at > 2016-01-01 OR is_active = true` | precedence: `V… AND V…` grouped, then OR |
| V7 | `name LIKE %smith%` | `%` preserved in value |
| V8 | `name LIKE '% smith%'` | quoted value with space |
| V9 | `note = 'it''s fine'` | doubled-quote escape → `it's fine` |
| V10 | `deleted_at IS NULL` | valueless condition |
| V11 | `deleted_at IS NOT NULL` | valueless condition |
| V12 | `status = 'AND'` | quoted keyword as value |
| V13 | `a = 1 and b = 2 or c = 3` | lowercase keywords |
| V14 | `payload = '{"a": 1}'` | jsonb-ish quoted value |
| V15 | `email = ''` | empty quoted value |
| V16 | `name ILIKE '%SMITH%'` | case-insensitive `LIKE` |
| V17 | `NOT status = completed` | prefix negation on a plain comparison |
| V18 | `NOT email ILIKE '%test%'` | prefix negation on `ILIKE` |
| V19 | `NOT deleted_at IS NULL` | prefix negation on a valueless condition — legal, redundant alternate spelling of `IS NOT NULL` |
| V20 | `not status = completed` | lowercase `NOT`, case-insensitive (parallels V13) |
| V21 | `status = 'NOT'` | quoted keyword as value (parallels V12) |

### Rejected (parse errors)

| # | Input | Why |
|---|-------|-----|
| R1 | *(empty string)* | no condition |
| R2 | `status =` | missing value |
| R3 | `= completed` | missing column |
| R4 | `status == completed` | unknown operator |
| R5 | `status = a AND` | trailing logic token |
| R6 | `(status = a)` | parentheses unsupported |
| R7 | `status = a; DROP TABLE users` | `;` can't appear in a bare value's grammar role — trailing garbage after a complete filter |
| R8 | `status = 'unterminated` | unclosed quote |
| R9 | `1abc = x` | column can't start with a digit |
| R10 | `status LIKE` | word operator missing value |
| R11 | `a = 1 OR OR b = 2` | doubled logic token |
| R12 | `status NOT = completed` | mid-predicate `NOT` unsupported — only the prefix form (`NOT status = completed`) is |
| R13 | 1 KiB+ filter string | length limit |
| R14 | 11+ ANDed conditions | condition-count limit |
| R15 | `NOT NOT status = completed` | double negation — `[NOT]` is zero-or-one, not recursive |
| R16 | `status = NOT` | bare `NOT` is always the keyword; quote it (`status = 'NOT'`, V21) to use as a literal value |

### Adversarial (must parse *or* reject safely — never reach SQL text)

| # | Input | Expected handling |
|---|-------|-------------------|
| A1 | `status = '''; DROP TABLE users; --'` | parses; value `'; DROP TABLE users; --` becomes a bind param — harmless |
| A2 | `id = 1 OR 1=1` | **rejected** — second condition's column `1` starts with a digit (R9) |
| A3 | `col"name = x` | `"` not legal in column → rejected |
| A4 | `name LIKE '%'' OR ''1''=''1'` | parses; entire pattern is one bind param |
| A5 | `status = 𝕔𝕠𝕞𝕡𝕝𝕖𝕥𝕖𝕕` (unicode confusables) | parses as bare value; bind param, harmless |
| A6 | `ｓｔａｔｕｓ = x` (fullwidth column) | not `[a-zA-Z0-9_]` → rejected |
| A7 | `status = x` (NUL byte) | rejected (not whitespace, not legal in column) |
| A8 | column named `pg_sleep` or `users; --` | parses (if lexically legal) but fails the schema allow-list check → 400 at the builder stage |
| A9 | deeply repeated `a = 1 AND a = 1 AND …` at the count limit | parses at 10, rejects at 11 — no stack recursion (parser must be iterative) |
| A10 | `NOT pg_sleep = 1` | parses (lexically legal) but fails the schema allow-list check on column `pg_sleep`, same as A8 — `NOT` doesn't bypass allow-listing |

Test A8 is the reminder that the grammar is only half the defense: the
server-side column allow-list check (`spec/protocol.md` §5.4.2/§6) must
have its own tests in every backend's suite (valid column, unknown
column, known column on the *wrong* table) — an AST-level check the
parser can neither perform nor bypass.

## 6. Frontend consumers (composition, not parsing)

Three `dbviewer.html` features generate clauses against this exact
grammar that the client-side parser then reads back: click-to-filter (a
per-cell button), FK cell navigation, and the common-values header
dropdown. All three funnel through one
function, `quoteFilterValue()`/`applyFilterClause()`, which implements §2's
quoting notes — bare when safe, single-quoted with `''`-escaping otherwise,
exact-match `AND`/`OR`/`NOT` forced to quote. All three only ever compose
plain `column = value` equality clauses today — none of them emit `NOT`,
`LIKE`/`ILIKE`, or `IS [NOT] NULL` — so widening `quoteFilterValue()`'s
forced-quote regex from `/^(AND|OR)$/i` to `/^(AND|OR|NOT)$/i` to match
`NOT` joining the keyword set (§2) was a one-line change, not a behavior
change to any shipped feature.

This is clause *composition*, not the parser `frontend-style-guide.md` §7
keeps client-side: it never parses or judges arbitrary user-typed text, only
formats a known column/value pair it already has from the server. So it's
not the thing that rule warns against — but its quoting output still has to
agree with this document. `tools/e2e-tests/tests/filter-parser.spec.ts`
checks that `quoteFilterValue()`'s output round-trips through the parser
unchanged, covering in particular the shapes behind V9 (`''`-doubling),
V12 (exact `AND`/`OR` as a value), V15 (empty string), and V21 (exact
`NOT` as a value) — the cases most likely to silently diverge if the two
are ever edited independently.

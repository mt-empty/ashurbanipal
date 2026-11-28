# Filter DSL — grammar and test plan

Status: normative, for the **frontend's** parser
Scope: this document specs the grammar the frontend parser
(`frontend/src/lib/filter-dsl.ts`, bundled into `dbviewer.html`) must
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
style so nothing here is novel. The parser is hand-written (a dozen operators, no
nesting; small enough that owning the security-critical path outweighs a
dependency).

## 1. Shape

```
condition (AND|OR condition)*
condition := [NOT] simple_condition
simple_condition := column OP value      (column may carry a JSON path: col->key->0)
           | column [NOT] IN ( value, value, ... )
           | column [NOT] BETWEEN value AND value
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
            | column , ws , [ "NOT" , ws ] , "IN" , ows , list
            | column , ws , [ "NOT" , ws ] , "BETWEEN" , ws , value , ws , "AND" , ws , value
            | column , ws , "IS" , ws , [ "NOT" , ws ] , "NULL" ;
list        = "(" , ows , item , { ows , "," , ows , item } , ows , ")" ;
item        = quoted | list_bare ;
list_bare   = { any-char-except-ws-quote-comma-parens }- ;
column      = [ qualifier , "." ] , colname , { path_step } ;  (* qualifier only in a join view, §3 *)
colname     = name | quoted_name ;
path_step   = ( "->>" | "->" ) , ( name | digits | quoted ) ;  (* at most 8; no whitespace *)
digits      = digit , { digit } ;                  (* an array index, 0 to 2147483647 *)
qualifier   = name | quoted_name ;
quoted_name = '"' , { any-char-except-quote | '""' } , '"' ;   (* at least one char *)
name        = ( letter | "_" ) , { letter | digit | "_" } ;
operator    = "=" | "!=" | ">=" | "<=" | ">" | "<" | "LIKE" | "ILIKE" ;
value       = quoted | bare ;
quoted      = "'" , { any-char-except-quote | "''" } , "'" ;
bare        = { any-char-except-ws-and-quote }- ;   (* no spaces, non-empty *)
ws          = whitespace , { whitespace } ;         (* required *)
ows         = { whitespace } ;                      (* optional *)
```

Notes:

- **Keywords** (`AND`, `OR`, `IS`, `NOT`, `NULL`, `LIKE`, `ILIKE`, `IN`,
  `BETWEEN`) are case-insensitive. Column names are matched case-sensitively against the
  schema allow-list.
- **Quoted names** (`"first name" = x`, `"a""b" = 1`) write a column or a
  join alias that is not a bare `name`: any characters, `""` for a literal
  `"`, at least one character. A quoted column works in any view and may
  carry a path (`"unit-price"->k`); as for a bare one, no whitespace may sit
  between it and its `.` or its arrows. In a join view a quoted name with no
  `.` after it is a column of the start table, like a bare one.
- **Qualified columns** (`alias.column`) are accepted only in a join view
  (§3). No whitespace is allowed around the `.`, and only one qualifier is
  allowed (`a.b.c` is a parse error). Outside a join view a `.` in a column
  is a parse error, exactly as before.
- **JSON paths** (`metadata->prefs->theme`, `o.metadata->status`) step into
  a JSON column, after the qualifier if there is one. A step is a bare
  name, digits (an array index), or a quoted key with `''` for a quote:
  `'0'` is the key `"0"`, not the first item. `->>` means the same as `->`,
  so Postgres pasted from psql parses. No whitespace is allowed anywhere in
  the column and its path, the same rule as for the `.`. At most 8 steps;
  a key is 1 to 255 UTF-8 bytes with no `"`, `\` or control character
  (U+0000 to U+001F), and an index is at most 2147483647: the limits of
  `spec/protocol.md` §5.4.2, which refuses such keys rather than escaping
  them. A dot never starts a path (`data.status` is a qualified column),
  and neither `data["k"]` nor `data#>'{k}'` is a path.
- **Longest-match on arrows**: `->>` is tried before `->`, and an arrow
  counts only right after a column or a step, so `metadata->n>5` is the
  path `[n]`, `>` and `5`, and `metadata->>n>5` is the same.
- **Whitespace** around symbolic operators is optional (`status=completed`
  is valid); word operators (`LIKE`, `ILIKE`, `IN`, `BETWEEN`, `IS NULL`,
  `AND`, `OR`, `NOT`) require surrounding whitespace. Whitespace between
  `IN` and `(`, and around list commas, is optional.
- **`NOT` only appears where a `condition` can start** — the very
  beginning of the filter, or immediately after `AND`/`OR`. It's
  zero-or-one (`[ "NOT" , ws ]`), not recursive: `NOT NOT status = active`
  is a parse error, not a double negation that cancels out. For the same
  reason a bare `NOT` is never a column name, after a qualifier too
  (`NOT NOT != 0` and `o.not = 1` are parse errors); a column named `not`
  is written `"not"`. There's no
  mid-predicate `NOT` (`status NOT = active`, `email NOT LIKE 'x'`) — the
  prefix form covers every predicate kind uniformly. The exceptions are
  `NOT IN` and `NOT BETWEEN`, written the SQL way; each means exactly the
  prefix form (`NOT column IN (…)`), so `NOT column NOT IN (…)` is a parse
  error like `NOT NOT`.
- **Lists** (`IN`): at least one item, no trailing comma. An item is a
  quoted value or a bare value that also stops at `,` and `)` and cannot
  contain `(`. A bare `NULL` item is a parse error: `x NOT IN (1, NULL)`
  is never true in SQL, so the parser points to `IS NULL` instead. A
  quoted `'NULL'` is the four-letter string, as anywhere else.
- **`BETWEEN lo AND hi`**: the `AND` is part of the condition, not a
  logic token. Both bounds are values; since a bare `AND` is never a value,
  the next `AND`/`OR` after `hi` starts the next condition. A bare `NULL`
  bound is a parse error, as in a list.
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
  `NOT`, `NOT IN` or `NOT BETWEEN`; `path`, present only when the column
  has one, is an array of strings (keys) and integers (indexes);
  `value` is absent exactly for `IS NULL`/`IS NOT NULL`,
  and is an array of strings for `IN` (the list items) and `BETWEEN`
  (`[lo, hi]`).
- **Join view.** The join overlay (`spec/join-dsl.md`) runs the same parser
  with the ordered list of table aliases (effective names, position 0
  first). Every emitted condition then carries `join`, the position of its
  table, per `spec/protocol.md` §5.11.3: a qualified column resolves its
  qualifier against the aliases (case-sensitive), an unqualified column
  means position 0. An unknown qualifier is a parse error. Without the
  alias list (a single-table view) no condition carries `join` and a
  qualified column is a parse error.
- What the server then does with the AST — validating each `column`
  against the live schema allow-list, mapping each `op` through a
  hardcoded SQL-fragment table, checking and binding every `value` as a
  parameter, comparing in the column's own type or as text by its class —
  is the server's contract, specified in `spec/protocol.md` §5.4.2
  (evaluation rules) and §6, not here. The parser does not know column
  types, so `amount > abc` parses and the server rejects it.
- `LIKE`/`ILIKE` pass `%`/`_` through to Postgres untranslated — the user
  writes Postgres patterns directly. `ILIKE` is Postgres's own
  case-insensitive `LIKE`; same passthrough, case-insensitive at the
  database level.
- `NOT` doesn't invert the operator: the parser emits the same `op` with
  `not: true`, and the server wraps the condition's mapped fragment in
  `NOT (…)` (`spec/protocol.md` §5.4.2), so `NOT` never needs its own
  operator mapping to keep in sync.
- Duplicate/contradictory conditions (`status = 'a' AND status = 'b'`) are
  legal and simply return zero rows — the parser doesn't do satisfiability
  analysis.
- Limits: ≤ 10 conditions — the parser rejects an 11th rather than emit
  an AST the server would refuse. An `IN` or `BETWEEN` condition counts as
  one; the 1 KiB input limit keeps a list far below the server's
  1000-item cap. The server independently enforces the
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
| V22 | `o.status = completed` with aliases `[o, u]` | `(join 0, status, =, "completed")` |
| V23 | `u.email LIKE '%@x.com'` with aliases `[o, u]` | `(join 1, email, LIKE, "%@x.com")` |
| V24 | `status = completed` with aliases `[o, u]` | unqualified means position 0: `(join 0, status, =, "completed")` |
| V25 | `"order items".id = 1` with aliases `[order items, x]` | quoted qualifier, `(join 0, id, =, "1")` |
| V26 | `o.a = 1 AND u.b = 2 OR NOT u.c IS NULL` with aliases `[o, u]` | `join` on each condition: 0, 1, 1 |
| V27 | `id IN (1, 2, 3)` | `(id, IN, ["1", "2", "3"])` |
| V28 | `id in(1,2)` | lowercase keyword, no optional spaces |
| V29 | `status NOT IN (a, 'b c')` | `not: true`, `(status, IN, ["a", "b c"])` |
| V30 | `NOT status IN (a)` | same AST as `status NOT IN (a)` |
| V31 | `name IN ('NULL', 'it''s')` | quoted `NULL` is a string; `''` escape inside a list |
| V32 | `total BETWEEN 10 AND 20` | `(total, BETWEEN, ["10", "20"])` |
| V33 | `total BETWEEN 10 AND 20 AND status = a` | the BETWEEN's `AND` is consumed; then a logic `AND` |
| V34 | `NOT created_at BETWEEN 2016-01-01 AND '2016-12-31 23:59'` | negated BETWEEN with a quoted bound |
| V35 | `total BETWEEN 20 AND 10` | reversed bounds parse (the server returns zero rows) |
| V36 | `u.id IN (1) OR o.total BETWEEN 1 AND 2` with aliases `[o, u]` | `join` 1 then 0 |
| V37 | `total NOT BETWEEN 1 AND 2` | same AST as `NOT total BETWEEN 1 AND 2` |
| V38 | `metadata->status = failed` | `(metadata, path ["status"], =, "failed")` |
| V39 | `metadata->>status = failed` | same as V38: `->>` is `->` |
| V40 | `o.metadata->status = failed` with aliases `[o, u]` | qualifier, then the path: `(join 0, metadata, path ["status"], …)` |
| V41 | `doc->arr->0->'user id' = 42` | digits are an index: path `["arr", 0, "user id"]` |
| V42 | `doc->'0' = x` | a quoted `0` is the key `"0"`: path `["0"]` |
| V43 | `doc->'it''s' = x` | `''` in a quoted key: path `["it's"]` |
| V44 | `metadata->n>5` | the arrow is not `>`: path `["n"]`, `>`, `"5"` |
| V45 | `metadata->>n>5` | same as V44 |
| V46 | `metadata->'a b'>=5` | quoted key, then `>=` |
| V47 | `doc->a->b->c->d->e->f->g->h = 1` | 8 steps, the most allowed |
| V48 | `doc->n IN (9, 10) AND NOT doc->n BETWEEN 1 AND 2 OR doc->status IS NULL` | a path with IN, NOT BETWEEN and IS NULL |
| V49 | `doc->'$'->'.'->'['->'*'->'ü' = x` | characters a JSON path language would read are plain keys once quoted |
| V50 | `"first name" = x` | a quoted column: `(first name, =, "x")` |
| V51 | `"a""b" = 1` | `""` is a literal quote: `(a"b, =, "1")` |
| V52 | `"not" = 1` | a keyword quoted is a column: `(not, =, "1")` |
| V53 | `"unit-price"->k = 1` | a quoted column with a path: `(unit-price, ["k"], =, "1")` |
| V54 | `"o"."unit price" = 1` with aliases `[o, u]` | quoted alias and column: `(join 0, unit price, =, "1")` |
| V55 | `"unit price" = 1` with aliases `[o, u]` | a quoted name with no `.` is a column of position 0 |
| V56 | `o."not" = 1` with aliases `[o, u]` | a quoted `not` after a qualifier: `(join 0, not, =, "1")` |

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
| R12 | `status NOT = completed` | mid-predicate `NOT` unsupported except before `IN`/`BETWEEN` — only the prefix form (`NOT status = completed`) is |
| R13 | 1 KiB+ filter string | length limit |
| R14 | 11+ ANDed conditions | condition-count limit |
| R15 | `NOT NOT status = completed` | double negation — `[NOT]` is zero-or-one, not recursive |
| R16 | `status = NOT` | bare `NOT` is always the keyword; quote it (`status = 'NOT'`, V21) to use as a literal value |
| R17 | `o.status = x` with no aliases | qualified column outside a join view |
| R18 | `z.status = x` with aliases `[o, u]` | unknown qualifier |
| R19 | `o. status = x` with aliases `[o, u]` | no whitespace around the `.` |
| R20 | `o.u.status = x` with aliases `[o, u]` | one qualifier only |
| R21 | `.status = x` with aliases `[o, u]` | missing qualifier |
| R22 | `"".status = x` with aliases `[o, u]` | empty quoted qualifier |
| R23 | `id IN ()` | empty list |
| R24 | `id IN (1, 2,)` | trailing comma |
| R25 | `id IN (1, 2` | unclosed list |
| R26 | `id IN 1, 2` | list needs parentheses |
| R27 | `id IN (1, NULL)` | bare `NULL` in a list — use `IS NULL` |
| R28 | `id NOT IN (1, null)` | same, any case |
| R29 | `NOT id NOT IN (1)` | double negation |
| R30 | `id IN (a AND b)` | bare `AND` is always the keyword |
| R31 | `total BETWEEN 10` | missing `AND hi` |
| R32 | `total BETWEEN 10 OR 20` | `BETWEEN` needs `AND` |
| R33 | `total BETWEEN 10 AND` | missing upper bound |
| R34 | `NOT total NOT BETWEEN 1 AND 2` | double negation |
| R35 | `id IN ((1))` | `(` cannot start a bare list item |
| R36 | `idIN (1)` | `IN` needs whitespace before it |
| R37 | `total BETWEEN NULL AND 5` | a bare `NULL` bound, as in a list; use `IS NULL` |
| R38 | `doc->a->b->c->d->e->f->g->h->i = 1` | 9 steps; the error is at the ninth |
| R39 | `metadata -> role = admin` | whitespace before `->` |
| R40 | `metadata-> role = admin` | whitespace after `->` |
| R41 | `data.status = x` with no aliases | a dot is a qualifier, never a path |
| R42 | `data["k"] = x` | not a path syntax |
| R43 | `data#>'{a}' = x` | not a path syntax |
| R44 | `doc->'' = x` | empty key |
| R45 | `doc->'say "hi"' = x` | a key holding `"` |
| R46 | `doc->'a\b' = x` | a key holding `\` |
| R47 | `doc->'a` + U+0001 + `' = x` | a key holding a control character |
| R48 | `doc->'` + 256 × `k` + `' = x` | a key over 255 bytes |
| R49 | `doc->2147483648 = x` | an index past 2147483647 |
| R50 | `doc->= x` | an arrow with no step |
| R51 | `doc->-1 = x` | an index can't be negative |
| R52 | `"" = 1` | empty quoted name |
| R53 | `"open = 1` | unterminated quoted name |
| R54 | `"a" .b = 1` | no whitespace before the `.` |
| R55 | `"a".b = 1` | a qualified column outside a join view, quoted or not |
| R56 | `NOT NOT != 0` | a bare `NOT` is never a column, so this is `NOT NOT`, not a negated column `NOT` |
| R57 | `o.not = 1` with aliases `[o, u]` | a bare `not` after a qualifier |

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
| A11 | `u.pg_sleep = 1` with aliases `[o, u]` | parses with `join 1`; the column fails the allow-list of table 1, same as A8 |
| A12 | `id IN ('1); DROP TABLE users; --')` | parses; one list item, a bind param — harmless |
| A13 | `doc->''' OR 1=1 --' = x` | parses; the key `' OR 1=1 --` is a bind param — harmless |
| A14 | `email->domain = x` | parses (the parser knows no types); the server refuses a path on a column that isn't json with a 400, and the page stops it before sending when it knows the column |

Test A8 is the reminder that the grammar is only half the defense: the
server-side column allow-list check (`spec/protocol.md` §5.4.2/§6) must
have its own tests in every backend's suite (valid column, unknown
column, known column on the *wrong* table) — an AST-level check the
parser can neither perform nor bypass.

## 6. Frontend consumers (composition, not parsing)

Several features write clauses against this grammar that the parser then
reads back: click-to-filter on a grid cell or record-view field, FK cell
navigation, the referenced-by drill-in, and the common-values dropdown.
They build text through `quoteFilterValue()`, `filterClause()`,
`eqClause()`, `filterClauses()`, `pathText()` and `pathEqClause()` in
`frontend/src/lib/filter-dsl.ts`,
which implement §2's quoting notes — a column bare when it is a `name`
other than `NOT`, double-quoted otherwise; a value bare when safe, single-quoted with
`''`-escaping otherwise, exact-match `AND`/`OR`/`NOT` forced to quote, and
`NULL` too, since a list item or a `BETWEEN` bound refuses it bare.
They emit only `column = value` and, for a null cell, `column IS NULL`;
the JSON tree's leaves emit the same with a path (`column->key->0 = value`),
and `pathText()` returns nothing for a key §2 can't write.

This is clause *composition*, not the parser `frontend-style-guide.md` §7
keeps client-side: it never parses or judges arbitrary user-typed text, only
formats a known column/value pair it already has from the server. So it's
not the thing that rule warns against — but its quoting output still has to
agree with this document. `frontend/test/filter-dsl.test.ts`
checks that `quoteFilterValue()`'s output round-trips through the parser
unchanged, covering in particular the shapes behind V9 (`''`-doubling),
V12 (exact `AND`/`OR` as a value), V15 (empty string), and V21 (exact
`NOT` as a value) — the cases most likely to silently diverge if the two
are ever edited independently.

In a join view, click-to-filter composes `alias.column = value` (alias
quoted with `"` when it is not a bare name). The common-values dropdown does
not run there, and FK navigation leaves the join view.

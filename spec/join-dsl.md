# Join DSL — grammar and test plan

Status: normative, for the **frontend's** parser
Scope: this document specs the restricted SQL-like text the `dbviewer.html`
join overlay parses into the structured `join` object of
`GET {mount}/api/tables/join` (`spec/protocol.md` §5.11). Parsing is
client-side only: no backend — reference or port — receives join text. The
backend contract is the JSON object; everything a server must do with it
(catalog checks, type compatibility, limits) lives in `spec/protocol.md`.

This is a sibling of `spec/filter-dsl.md` and follows its shape. It is not
SQL: it accepts a small subset and rejects everything else with a message
that names the part.

## 1. Shape

```
[ SELECT columns ] FROM table [alias] { join-clause } [ ; ]
```

One start table, one to three join clauses, an optional column list. No
`WHERE`, `ORDER BY` or paging: filter and sort stay with the filter bar and
the header sort (`spec/filter-dsl.md`), and the pager owns `LIMIT`/`OFFSET`.

## 2. Grammar (EBNF)

```ebnf
join        = [ select , ws ] , from , { ws , joinclause } , [ ows , ";" ] ;
select      = "SELECT" , ws , columns ;
columns     = "*" | selitem , { ows , "," , ows , selitem } ;
selitem     = name , "." , ( ident | "*" ) ;
from        = "FROM" , ws , tableref ;
tableref    = ident , [ ws , [ "AS" , ws ] , alias ] ;
joinclause  = [ ( "INNER" | "LEFT" , [ ws , "OUTER" ] ) , ws ] , "JOIN" , ws ,
              tableref , ws , "ON" , ws , pair , { ws , "AND" , ws , pair } ;
pair        = colref , ows , "=" , ows , colref ;
colref      = name , "." , ident ;
name        = ident ;                               (* a table's alias, or its name when unaliased *)
alias       = ident ;
ident       = bare | quoted ;
bare        = ( letter | "_" ) , { letter | digit | "_" } ;   (* ASCII only; not a keyword *)
quoted      = '"' , { any-char-except-quote | '""' } , '"' ;   (* at least one char *)
ws          = whitespace , { whitespace } ;         (* spaces, tabs, newlines *)
ows         = { whitespace } ;
```

Notes:

- **Keywords** (`SELECT FROM JOIN INNER LEFT OUTER ON AND AS`) are
  case-insensitive. A bare identifier may not be a keyword, `OR`, or a rejected
  word (§4); quote it (`"left"`) to use it as a name.
- **Names are case-sensitive**, matched exactly against the catalog, as in
  `spec/protocol.md` §5.11.1.
- **A bare `JOIN` means `INNER JOIN`.** `LEFT JOIN` and `LEFT OUTER JOIN` are
  the same.
- **`SELECT` absent or `*` means all columns.**
  `alias.*` means all columns of that table. `*` cannot be mixed with other
  items.
- A trailing `;` is allowed once, at the very end.

## 3. Semantics

- **Output** is a `JoinDef`, the one object the form, the text and the
  request are views of:

  ```json
  { "tables":  [ { "table": "orders", "alias": "o" }, { "table": "users", "alias": null } ],
    "joins":   [ { "type": "left", "on": [ { "left": { "join": 0, "column": "user_id" }, "right": "id" } ] } ],
    "columns": null }
  ```

  `tables[0]` is the start table, `joins[i]` joins `tables[i + 1]`. `alias`
  is `null` when the text gave none. `columns` is `null` for all columns,
  otherwise a list of `{ "join": n, "column": "x" }` and `{ "join": n,
  "all": true }` (for `alias.*`).
- **Wire request.** The `JoinDef` maps to the `spec/protocol.md` §5.11 object
  by merging `tables[i + 1]` into `joins[i]` as its `table`. `columns` is
  omitted when it is `null` or when every item is `all` and together they
  name every table. Otherwise each `all` item is expanded in catalog column
  order.
- **Effective name** of a table is its alias, or its table name when
  unaliased. Effective names must all differ. A table that appears twice
  therefore needs an alias on the second use. Once aliased, only the alias
  resolves: `orders o … orders.id` is an unknown alias.
- **Pairs.** One side of each pair must be a column of the table being
  joined, the other a column of an earlier table, in either order in the
  text. The parser rewrites it to the wire's `left` (earlier table) and
  `right` (this table's column).
- **Limits.** At most 4 tables and 3 pairs per `ON`, matching
  `spec/protocol.md` §5.11.1. The parser rejects a 5th table or a 4th pair
  rather than emit an object the server would refuse.
- **Catalog.** The parser may be given the tables and columns the page
  already holds. When given, an unknown table is always rejected, and an
  unknown column is rejected for every table whose columns are known. An
  unknown name suggests the closest catalog name (Levenshtein distance ≤ 2,
  ties in catalog order). Without a catalog, names are not checked; the
  server answers 400. The parser makes no request.
- **Type hints.** Type compatibility is not a parse rule. The frontend greys
  columns that cannot pair, using a table that mirrors
  `spec/protocol.md` §5.11.2 (`docs/adapter-decisions.md` §5.11 has the
  per-engine mapping). An unknown type is allowed; the server is the
  authority.
- **Canonical text.** `print(def)` writes one canonical form, so text →
  definition → text is stable:

  ```
  SELECT *
  FROM orders o
  LEFT JOIN users u ON o.user_id = u.id
  ```

  Keywords upper-case, one clause per line, `INNER JOIN` or `LEFT JOIN`
  (never bare `JOIN`, never `OUTER`), no `AS`, no trailing `;`, the alias
  omitted when `null`, pairs written earlier-table first, items of the
  select list in order, `SELECT *` when `columns` is `null`. A name is
  quoted only when it is not a bare identifier or is a keyword or rejected
  word; `"` inside a quoted name is doubled.

## 4. Error behavior

Any failure is an inline, client-side error with a stable `code`, a 1-based
`line` and `column` (UTF-16 code units) pointing at the start of the
offending token (just past the last character for an unexpected end), and a
`message` that names the part. The message text is implementation-defined;
the `code` and position are what the fixtures pin.

| code | when |
|------|------|
| `empty` | no text |
| `expected` | a required token is missing or the wrong one is present |
| `unsupported-keyword` | `RIGHT FULL CROSS NATURAL USING WHERE GROUP HAVING ORDER LIMIT OFFSET UNION DISTINCT` |
| `unsupported-syntax` | parentheses or subqueries, function calls, `OR`, an `ON` operator other than `=`, comments (`--`, `/* */`) |
| `multiple-statements` | anything but whitespace after the `;` |
| `no-join` | a start table with no join clause |
| `bad-pair` | a pair that does not have exactly one side on the table being joined and one on an earlier table, or a column with no alias |
| `duplicate-name` | two tables with the same effective name |
| `unknown-alias` | a colref whose first part is not a table's effective name |
| `unknown-table`, `unknown-column` | catalog check |
| `too-many-tables`, `too-many-pairs` | limits in §3 |
| `bad-select` | `*` mixed with items, or the same column selected twice (including `alias.*` with `alias.col`) |
| `bad-identifier` | an unterminated or empty quoted name, or a character that cannot start a token |
| `type-mismatch` | only when the caller supplies a type check (the page knows the column types, the parser does not): the second column of a pair cannot be joined to the first. Never raised on the fixture cases |

Messages for `WHERE` and `ORDER` say to use the filter bar and the header
sort; `RIGHT` says to use `LEFT` with the tables swapped.

Server rejections (type mismatch, unknown names the page's catalog did not
have, the byte bound, a timeout) arrive as HTTP 400 or 500 per
`spec/protocol.md` §2 and §5.11.5 and are shown in the overlay.

## 5. Test table

Machine-readable fixtures (`spec/fixtures/join-parser-tests.json`) are
generated from this table, which remains the human-readable source of truth.
Cases run against the fixture's `catalog` (`orders`, `users`, `order_extra`,
`events`, from the seed schema) unless marked *(no catalog)*.
`✓` = parses to the stated `JoinDef`; `✗` = rejected with the stated code.

### Valid

| # | Input | Expect |
|---|-------|--------|
| V1 | `FROM orders JOIN users ON orders.user_id = users.id` | inner join, `columns` null, aliases null |
| V2 | `select * from orders left join users on orders.user_id = users.id` | lowercase keywords, left join |
| V3 | `FROM orders AS o LEFT JOIN users AS u ON o.user_id = u.id` | `AS` aliases |
| V4 | `FROM orders o LEFT JOIN users u ON o.user_id = u.id` | bare aliases, same def as V3 |
| V5 | `FROM orders o LEFT OUTER JOIN users u ON o.user_id = u.id` | `OUTER` ignored, same def as V3 |
| V6 | `FROM orders INNER JOIN users ON orders.user_id = users.id` | explicit inner, same def as V1 |
| V7 | `FROM orders JOIN users ON users.id = orders.user_id` | pair sides swapped, same def as V1 |
| V8 | `SELECT o.id, u.full_name FROM orders o JOIN users u ON o.user_id = u.id` | explicit column list |
| V9 | `SELECT o.*, u.email FROM orders o JOIN users u ON o.user_id = u.id` | `alias.*` plus a column |
| V10 | `FROM "orders" JOIN "users" ON "orders"."user_id" = "users"."id"` | quoted names, same def as V1 |
| V11 | `FROM "we""ird" w JOIN b ON w.a = b.c` *(no catalog)* | `""` escape, table `we"ird` |
| V12 | `FROM orders JOIN users ON orders.user_id = users.id;` | one trailing `;` |
| V13 | `FROM orders a JOIN orders b ON a.user_id = b.user_id` | self-join with aliases |
| V14 | four tables, three joins, clauses on separate lines and tabs | whitespace is free |
| V15 | `FROM orders o JOIN users u ON o.user_id = u.id AND o.created_at = u.created_at AND o.id = u.id` | three pairs |
| V16 | `From orders Left Join users On orders.user_id = users.id` | mixed case keywords |
| V17 | `FROM orders JOIN users ON orders.user_id = users.id JOIN events ON events.user_id = users.id` | second join's pair names an earlier table |
| V18 | `FROM "left" JOIN b ON "left".x = b.y` *(no catalog)* | keyword as quoted name |

### Rejected

| # | Input | Code |
|---|-------|------|
| R1 | *(empty or whitespace)* | `empty` |
| R2 | `FROM` | `expected` |
| R3 | `FROM orders` | `no-join` |
| R4 | `FROM orders RIGHT JOIN users ON orders.user_id = users.id` | `unsupported-keyword` |
| R5 | `… FULL JOIN …` | `unsupported-keyword` |
| R6 | `… CROSS JOIN users` | `unsupported-keyword` |
| R7 | `… NATURAL JOIN users` | `unsupported-keyword` |
| R8 | `… JOIN users USING (id)` | `unsupported-keyword` |
| R9 | `… ON … WHERE orders.id = 1` | `unsupported-keyword` (message points to the filter bar) |
| R10 | `… GROUP BY orders.id` | `unsupported-keyword` |
| R11 | `… HAVING …` | `unsupported-keyword` |
| R12 | `… ORDER BY orders.id` | `unsupported-keyword` (message points to header sort) |
| R13 | `… LIMIT 10` | `unsupported-keyword` |
| R14 | `… OFFSET 10` | `unsupported-keyword` |
| R15 | `… UNION SELECT …` | `unsupported-keyword` |
| R16 | `SELECT DISTINCT o.id FROM …` | `unsupported-keyword` |
| R17 | `FROM (SELECT * FROM orders) o JOIN …` | `unsupported-syntax` |
| R18 | `… ON (orders.user_id = users.id)` | `unsupported-syntax` |
| R19 | `SELECT count(o.id) FROM …` | `unsupported-syntax` |
| R20 | `… ON a.x = b.y OR a.z = b.w` | `unsupported-syntax` |
| R21 | `… ON orders.total_cents > users.age` (also `<>`, `!=`, `<`, `>=`, `LIKE`) | `unsupported-syntax` |
| R22 | `FROM orders -- note` and `/* x */ FROM orders …` | `unsupported-syntax` |
| R23 | `FROM orders JOIN users ON … ; SELECT 1` | `multiple-statements` |
| R24 | `FROM orders JOIN orders ON orders.id = orders.user_id` | `duplicate-name` |
| R25 | `FROM orders o JOIN users o ON o.id = o.user_id` | `duplicate-name` |
| R26 | five tables | `too-many-tables` |
| R27 | four pairs in one `ON` | `too-many-pairs` |
| R28 | `… ON users.id = users.email` (both sides the joined table) | `bad-pair` |
| R29 | `… JOIN events ON orders.id = users.id` (neither side is the joined table) | `bad-pair` |
| R30 | `… ON user_id = id` (no alias) | `bad-pair` |
| R31 | `FROM orders JOIN user ON orders.user_id = user.id` | `unknown-table`, suggests `users` |
| R32 | `FROM orders JOIN users ON orders.user_idd = users.id` | `unknown-column`, suggests `user_id` |
| R33 | `FROM orders JOIN users ON x.user_id = users.id` | `unknown-alias` |
| R34 | `FROM orders o JOIN users u ON orders.user_id = u.id` | `unknown-alias` (alias hides the table name) |
| R35 | `SELECT *, o.id FROM …` | `bad-select` |
| R36 | `SELECT o.*, o.id FROM …` | `bad-select` |
| R37 | `FROM "orders JOIN users …` | `bad-identifier` |
| R38 | `FROM "" JOIN b ON "".x = b.y` | `bad-identifier` |
| R39 | `FROM orders JOIN users` | `expected` |
| R40 | `FROM orders JOIN users ON orders.user_id users.id` | `expected` |

### Adversarial (must parse *or* reject safely — a name is data, never SQL text)

| # | Input | Expected handling |
|---|-------|-------------------|
| A1 | `FROM orders; DROP TABLE users` | `multiple-statements` |
| A2 | `… ON a.id = b.id OR 1=1` | `unsupported-syntax` (R20) |
| A3 | `FROM "orders"" JOIN users …` | `bad-identifier` (unterminated) |
| A4 | `FROM "x; DROP TABLE users" a JOIN b ON a.i = b.j` *(no catalog)* | parses; the table name is `x; DROP TABLE users`, which the server then rejects as `invalid_join` |
| A5 | `FROM ｏｒｄｅｒｓ …` (fullwidth) | `bad-identifier`, not `[A-Za-z0-9_]` |
| A6 | a NUL byte in a bare name | `bad-identifier` |
| A7 | `FROM a JOIN b ON a.x = b.x JOIN c … JOIN d … JOIN e …` | `too-many-tables`, no recursion (the parser is iterative) |

A4 is the reminder that this grammar is half the defense: the server
checks every table and column against the live catalog
(`spec/protocol.md` §5.11.1 and §6), and no join text ever reaches SQL.

## 6. Frontend consumers

- The overlay's SQL mode parses on every edit and shows the first error
  with its line (`line`, `column`, `message`).
- The overlay's Form mode and the SQL text edit the same `JoinDef`; the form
  shows `print(def)` read-only.
- The active join lives in the page URL as the canonical text (`join`
  parameter). The saved-joins list stores canonical text per source and
  schema. Both parse without a catalog on load, so a restored join whose
  names no longer exist fails at the server (400), not in the parser.
- Filter and sort in a join view use the existing controls.
  `alias.column` filter names are specified in `spec/filter-dsl.md` §1.

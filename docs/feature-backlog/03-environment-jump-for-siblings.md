# Jump between dev / int / staging environments of the same app

> **Status:** DONE · **Area:** spec, ports, conformance, frontend, docs, e2e · **Ref:** PR #173, released in 0.8.0

## 1. The ask

A host runs several services, and each service runs in more than one
environment (for example dev and int). From any one Ashurbanipal, a user
wants to:

- see every service in every environment in one place, and
- jump to any of them in one click, including the same service in the
  other environment, on the same table, filter and sort.

Design: board **W · Matrix** on the design canvas
(https://claude.ai/artifact/Tgvg8sC9udMhbyocWppmy9),
with edge states on board **AA**. Boards X, Y and Z were the alternatives
and were not chosen.

§5 (the fallback note) is frontend-only and ships first, on its own. It
also helps a shared link whose table was renamed. §4 needs the spec change
and every port.

## 2. State before this story

- Config: each sibling has `name`, `base_url`, `health_path` and nothing
  else (`implementations/rust/core/src/config.rs:31`, `docs/design.md` §7).
  An instance does not know its own name.
- Wire: `GET /api/siblings` returns `name`, `base_url`, `healthy`
  (`spec/protocol.md` §5.6, `spec/openapi.yaml:917`).
- Frontend: a flat list in the `#siblings-pop` popover, links open in a new
  tab (`frontend/src/features/siblings.ts`, `frontend/src/index.html:174`).
- The page URL already holds source, schema, table, filter and sort
  (`frontend/src/core/url.ts:18`). An unknown table in the URL already falls
  back to the first table and drops the filter (`loadTables` in `frontend/src/features/sidebar.ts`).

## 3. The "no environment" rule

`spec/protocol.md` §4 says an implementation MUST NOT infer which
environment it runs in. This story keeps that rule:

- A **label** is an opaque string the host writes in its config. It is
  echoed back unchanged.
- No implementation parses, normalizes, compares against known names, or
  derives behavior from a label. The kill switch, limits and every other
  behavior ignore it.
- No implementation derives a label or name from a hostname, URL, port,
  environment variable or any other signal.

"dev" and "int" in this story are examples. A host may write any label.

## 4. The interface

### 4.1 Configuration (every port)

Two additions, both optional. A host that sets neither sees no change.

- `instance` — this instance's own identity. If present, `name` and
  `label` are both required and non-empty.
- `label` on each sibling — optional, non-empty when present.

Reference shape (TOML, as in `docs/design.md` §7):

```toml
[ashurbanipal.instance]
name  = "orders"
label = "dev"

[[ashurbanipal.siblings]]
name        = "orders"
label       = "int"
base_url    = "https://orders-int.internal.vpn/__ashurbanipal"
health_path = "/health"

[[ashurbanipal.siblings]]
name        = "billing"
label       = "dev"
base_url    = "https://billing-dev.internal.vpn/__ashurbanipal"
health_path = "/health"
```

Per-port field names follow each port's existing idiom:

| Port | `instance` | sibling `label` |
|---|---|---|
| Rust (`core/src/config.rs`) | `instance: Option<Instance>`, `Instance { name: String, label: String }` | `label: Option<String>` |
| Go (`config.go`) | `Instance *Instance`, `Instance{Name, Label string}` | `Label string` (empty means unset) |
| Node (`src/config.ts`) | `instance?: { name: string; label: string }` | `label?: string` |
| Flask (`ashurbanipal/config.py`) | `instance: Instance \| None = None` | `label: str \| None = None` |
| Spring (`AshurbanipalProperties.kt`) | `instance: Instance? = null` → `ashurbanipal.instance.name/label` | `label: String? = null` |

Configuration rules:

- **C1.** `instance` with a missing or empty `name` or `label` is ignored.
- **C2.** An empty-string sibling `label` is treated as no label.
- **C3.** Two siblings with the same `name` and the same `label` (both
  unset counts as the same) are both kept, in configuration order.

Sibling configuration is never rejected and never stops the host or the
viewer. Each correction above is reported as a warning (W5).
- **C4.** A sibling whose `name` and `label` equal the `instance`'s is
  allowed, and recommended: one shared sibling list, in the same order, on
  every instance gives every instance the same grid. See W2.

### 4.2 Wire: `GET {mount}/api/siblings` (§5.6)

```json
{
  "instance": { "name": "orders", "label": "dev" },
  "siblings": [
    { "name": "orders",  "label": "dev", "base_url": "https://orders-dev.internal.vpn/__ashurbanipal",  "healthy": true },
    { "name": "orders",  "label": "int", "base_url": "https://orders-int.internal.vpn/__ashurbanipal",  "healthy": true },
    { "name": "billing", "label": "dev", "base_url": "https://billing-dev.internal.vpn/__ashurbanipal", "healthy": true },
    { "name": "billing", "label": "int", "base_url": "https://billing-int.internal.vpn/__ashurbanipal", "healthy": false }
  ]
}
```

- **W1.** `instance` is present iff configured. `label` on a sibling is
  present iff configured. Both values are echoed byte-for-byte.
- **W2.** A sibling matching `instance` (C4) MUST NOT be health-checked.
  It stays in `siblings` at its configuration position with
  `healthy: true`, since this instance is serving the response.
- **W3.** `siblings` MUST keep configuration order. The frontend builds rows
  and columns from it.
- **W4.** Every existing §5.6 rule (origin-relative health path, 2xx means
  healthy, per-check timeout, parallel checks) is unchanged.
- **W5.** Each correction from C1–C3 adds one human-readable string to an
  optional `warnings` array, present only when there is at least one. Its
  wording is implementation-defined and never parsed.

Both fields are optional additions, so the protocol stays v1
(`spec/protocol.md` §7 versioning policy).

OpenAPI change to `SiblingsResponse` (`spec/openapi.yaml:917`):

```yaml
SiblingsResponse:
  type: object
  required: [siblings]
  properties:
    instance:
      type: object
      required: [name, label]
      properties:
        name:  { type: string, minLength: 1 }
        label: { type: string, minLength: 1 }
      description: >
        This instance's own name and label, as the host configured them.
        Absent when not configured. Opaque: never parsed or acted on.
    siblings:
      type: array
      items:
        type: object
        required: [name, base_url, healthy]
        properties:
          name:     { type: string }
          label:    { type: string, minLength: 1, description: "Opaque host-written label. Absent when not configured." }
          base_url: { type: string }
          healthy:  { type: boolean }
```

### 4.3 Frontend contract

The frontend reads only the wire shape above.

- **F1. Mode.** If `instance` is present or any sibling has a `label`, show
  the matrix. Otherwise keep today's flat list unchanged.
- **F2. Columns.** Labels in order of first appearance in `siblings`, so
  every instance sharing one list shows the same columns. An
  `instance.label` that no sibling carries goes first. The instance's own
  column header is bold.
- **F3. Rows.** Names in order of first appearance among labelled
  siblings, the same way; an `instance.name` no sibling carries goes first.
  The instance's own row name is bold.
- **F4. Cells.**
  - The instance's own cell: "you are here", not a link, `aria-current="page"`.
  - A configured sibling: a link with a health dot and the word "up" or
    "down". Colour is never the only signal.
  - No sibling for that pair: the text "not set up", not a link.
- **F5. Same view.** In the instance's own row, the other cells link to
  `base_url` + the current `location.search`, and read "same view". Only
  the instance's own row does this, because only that service shares its
  tables. The page is served at exactly `{mount}`, so a trailing `/` on
  `base_url` is dropped, never added: some ports' routers 404 `{mount}/`.
- **F6. Unlabelled siblings** in a labelled config: a flat list under the
  matrix, as today.
- **F7. Real links.** Every link is a plain `<a href>` with
  `rel="noopener"`. No click handler may cancel the default action, so
  right-click › Open in New Tab, Ctrl/⌘-click and middle-click always work.
  A plain click switches this tab: no `target` attribute. This changes
  today's new-tab behavior on purpose; Back returns to the exact view
  because the URL holds it.
- **F8. Markup.** A real `<table>`: labels are `<th scope="col">`, names are
  `<th scope="row">`. Long names truncate with an ellipsis and keep the full
  name in `title`.
- **F9. Refresh.** A refresh while the pop-up is open re-renders cells in
  place. It must not close the popover or move keyboard focus.
- **F10. Trigger.** The pill text is unchanged: "Other services · N up" or
  "· N down".
- **F11. Warnings.** With `warnings` (W5) the pill adds "· N warnings" and
  the pop-up lists each one above the grid. A repeated name and label fills
  its cell once; later copies are listed under the grid as "<label> ·
  duplicate". Unlabelled entries sharing a name show their host.

## 5. Fallback note (ships first)

Design: boards **AB** (light), **AC** (dark) and **AD** (every case) on the
same canvas.

### 5.1 The problem

A link names a source, schema, table and filter. When the instance it opens
lacks one of them, the page already falls back to a safe choice
(`loadSources`, `loadSchemas` and `loadTables` in `frontend/src/features/sidebar.ts`,
and `dropOneStaleInput` in `frontend/src/core/store.ts`). It does this silently, so the user can
look at `audit_log` and believe it is `orders`.

### 5.2 Behavior

- **N1. Who gets a note.** Only a name the page URL asked for, at page load.
  A name restored from `localStorage` still resets silently (R5). Back and
  Forward (popstate) do not show a note: that history entry was already
  shown once.
- **N2. What it says.** One sentence that names each swap in top-bar order,
  using the instance label from §4 when there is one, else "here":
  - "There is no table `orders` in int. Showing `audit_log` instead, without
    your filter."
  - "There is no schema `sales` or table `orders` in int. Showing `public` /
    `audit_log` instead, without your filter."
  - "There is no source `replica` here. Showing `primary` instead."
  - A filter the table can't satisfy (`unknown_column`): "Your filter
    doesn't fit `orders` in int, so it was removed."
- **N3. Where.** A bar under the filter, above the table meta line. Neutral
  look: a 1 px border, an info icon, no red or amber. It is not an error.
- **N4. Controls.** Only ✕ (`aria-label="Close this note"`). There is no Back
  button; the browser's Back does that.
- **N5. When it goes away.** On ✕, or on the user's next change of table,
  schema, source or filter. It stays through refresh, auto-refresh and the
  sibling poll.
- **N6. Accessibility.** The bar has `role="status"`, so it is announced
  once. The ✕ target is at least 44 px.
- **N7. Narrow window.** The text wraps; ✕ stays at the top right.

Not in scope: a sort the other instance can't use is still dropped
silently (R11).

### 5.3 What exists and what is new

Exists:

- A bar slot under the filter: `#join-notice` (`frontend/src/index.html:73`)
  and its helpers (`frontend/src/features/join-view.ts:65`).
- The `#status` live region (`frontend/src/core/dom.ts:29`).
- The fallbacks themselves (§5.1).

New:

- **Record what the URL named.** `applyUrlOverlay()`
  (`frontend/src/core/url.ts:18`) runs after `restoreFromStorage()`, so
  afterwards the two can't be told apart. Record the URL's source, schema,
  table and filter there.
- **Record each swap.** At each fallback point, push "asked X, got Y" only
  if the URL named X.
- **A second bar, `#view-notice`.** `#join-notice` can't be reused: every
  `loadData()` hides it (`frontend/src/bootstrap/controller.ts:181`), which
  would clear the note as soon as the fallback table loads, and its tint is
  the danger colour. Same layout, neutral style, its own hide rule (N5).
- **One sentence builder** for N2.

Size: about 60–100 lines of TypeScript and CSS, plus one e2e spec. No
backend, spec or port change.

### 5.4 Touchpoints

- `frontend/src/core/url.ts`, `frontend/src/features/sidebar.ts`,
  `frontend/src/core/store.ts` — N1, the swap records.
- `frontend/src/index.html`, `frontend/src/styles.css` — `#view-notice`.
- `docs/ui-guidelines.md` R6d — change "resets silently" to: silent for
  restored state, a note (this section) for a name the URL asked for.
- `tools/e2e-tests/tests/` — one spec, DOM assertions only: a URL naming a
  missing table shows the note with both names; a `localStorage`-only stale
  table shows no note; ✕ hides it; a table switch hides it; a refresh does
  not.

## 6. Touchpoints

Spec and docs:

- `spec/protocol.md` §5.6 — W1–W4, plus one sentence pointing at §4's rule.
- `spec/openapi.yaml:917` — `SiblingsResponse` as in §4.2.
- `spec/CHANGELOG.md` — additive v1 entry.
- `docs/design.md` §7 — config example with `instance` and `label`.
- `readme.md:240` and each port's README — config table rows for
  `instance` and `label`.

Backend, every port:

- Config type: `instance`, sibling `label`, rules C1–C4.
- Siblings handler: echo `instance` and `label`; report the self entry
  healthy without a health check (W2). Rust: `core/src/config.rs`,
  `axum/src/routes.rs:471-500`, and the actix-web equivalent.
- Unit tests for C1–C4 and W2 in each port's config tests.
- Demo configs: give `rust:demo` / `rust:demo-sibling` (and each port's
  demo) an `instance` and labels, so `<port>:dev` shows the matrix.

Conformance:

- `conformance/runner/html_and_siblings.rs:51` checks only the empty list.
  Add cases for `instance` echo, `label` echo, the self entry reported
  healthy without a probe, and order. Each port's conformance target needs a way to start with a
  labelled sibling config.

Frontend:

- `frontend/src/core/types.ts` — `Sibling.label?`, a new `SiblingInstance`.
- `frontend/src/features/siblings.ts` — F1–F10.
- `frontend/src/index.html:174`, `frontend/src/styles.css:293` — matrix
  markup and styles, using existing tokens.
- `frontend/src/demo/demo-fixtures.ts` — a labelled fixture for the
  GitHub Pages demo.
- `tools/e2e-tests/tests/` — a new spec. Assert on DOM, not screenshots:
  column and row order (F2, F3), "you are here" has no `href`, "not set up"
  has no `href`, the same-view `href` carries the current query string, and
  every link has an `href` and no `target` attribute (F7).

## 7. Decisions and open questions

- **Decided: a plain click switches this tab** (F7), for every cell.
- **Settled: same view when the other instance differs.** The frontend
  checks the URL against the other instance's own lists before it asks for
  data, so no request uses a missing name:
  - unknown source → first source (`loadSources`, `frontend/src/features/sidebar.ts`);
  - unknown schema → `public`, else the first schema (`loadSchemas`);
  - unknown table → first table, and the filter is dropped (`loadTables`).
  The e2e spec should cover one same-view link whose table is missing.
- **Decided: tell the user about the fallback**, with a note and no Back
  button (§5).

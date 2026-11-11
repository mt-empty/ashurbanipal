# Type checker for the Flask port

> **Status:** DONE · **Area:** flask, ci · **Ref:** both steps in one PR, as two commits

**Ask:** run a static type checker over the Flask port in CI, the way the
other four ports get one from their compiler. Python is the only port whose
type hints nothing checks.

## 1. Why

- `implementations/flask-python/pyproject.toml` configures ruff only. Ruff
  checks style and some bugs, not types.
- The port already has type hints on most functions, but nothing verifies
  them, so they can drift from the code.
- A November 2026 feasibility study looked at typed, catalog-checked
  identifiers in every port, so that only a checked table or column name can
  reach SQL. Its verdict for Flask was "not worth it" for one reason:
  without a type checker, such types are only checked at run time. This
  story removes that blocker.

## 2. Where it stood

A trial run of mypy 2.4.1 over `ashurbanipal/` (10 files, about 3,500
lines), with the `postgres` and `mysql` extras and `types-PyMySQL`
installed:

| Mode | Errors | Kinds |
|---|---|---|
| default | 15, in 4 files | `arg-type` 7, `index` 3, `misc` 2, `assignment` 2, `operator` 1 |
| `--strict` | 60, in 6 files | the 15 above, plus `no-untyped-def` 24, `type-arg` 18, `no-any-return` 3 |

- **Default mode.** Six errors had one cause: `Condition.value` was
  `str | None`, though the parser already required a string for every
  operator that takes one. Five more were `fetchone()` on queries that
  always return a row (`db/postgres.py:160`, `:365`).
- **`--strict` mode.** The extra errors were missing hints and bare `dict`,
  `list`, `tuple` and `Callable`.

## 3. Decisions

- **Use mypy.** It is the most widely used checker and installs as a plain
  dev dependency through uv, like ruff. basedpyright, Pyrefly and ty were
  tried too; ty is still pre-1.0, and pyright's strict mode reported 474
  errors here, mostly from untyped libraries.
- **Enforce the condition rule with types.** A filter condition is a
  `NullCheck` or a `Comparison` whose `value` is a `str`, so no backend can
  bind a missing value. Rows that always exist are read through
  `db.one_row`.
- **Check the package first.** Start with `ashurbanipal/`. Do `tests/` and
  `demo/` later, or not at all.
- **Phase it in two steps.**
  1. Fix the 15 default-mode errors and turn the check on in CI.
  2. Turn on `strict = true` and fix the rest.
- **No blanket ignores.** A `# type: ignore[code]` needs a comment with the
  reason, following the repo's comment rule (`CLAUDE.md`).

## 4. Changes

- `pyproject.toml`: add `mypy` and `types-PyMySQL` to the `dev` extra, and
  add a `[tool.mypy]` section (`files = ["ashurbanipal"]`, `python_version =
  "3.12"`, then `strict = true` in step 2).
- `mise-tasks/flask.toml`: add a `flask:typecheck` task (`uv run mypy`), and
  add it to `[tasks.flask]` in `mise.toml`.
- `.github/workflows/_flask-build-test.yml`: add a `mypy` step next to
  `ruff check`.
- `CLAUDE.md` and `mise.toml`: name the new task in the `flask` umbrella.
- Step 2 only: ship a `py.typed` marker in the wheel, so host apps that use
  mypy can check their calls into the package.

## 5. What "done" means

- `mise run flask` runs mypy and passes in strict mode.
- CI fails on a new type error.
- Conformance and the Flask tests still pass on Postgres, MySQL, MariaDB
  and SQLite. Fixes for `None` handling must not change any response.

## 6. Out of scope

- Typed, catalog-checked identifier classes. That is a follow-up, once this
  checker exists.
- Type-checking `tests/` and `demo/`.

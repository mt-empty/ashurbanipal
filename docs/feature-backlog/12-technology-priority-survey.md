# Prioritize new ports/backends by 2025 Stack Overflow survey usage

**Ask:** rank candidate new language ports and DB backends by actual
developer usage share (not guesswork) against what this project already
ships (Rust/Axum, Kotlin/Spring Boot, Go/net-http, Node/Express; Postgres
default + Rust-only opt-in SQLite), so backlog effort goes where it
reaches the most real users for the least speculative work. Source: 2025
Stack Overflow Developer Survey,
[survey.stackoverflow.co/2025/technology](https://survey.stackoverflow.co/2025/technology/)
("used this year" figures, cross-checked across two independent fetches).

**Findings:**
- **Languages** (backend-plausible only): JavaScript 66%, Python 57.9%,
  TypeScript 43.6%, Java 29.4%, C# 27.8%, C++ 23.5%, PHP 18.9%, Go 16.4%,
  Rust 14.8%, Kotlin 10.8%.
- **Frameworks**: Node.js 48.7% / Express 19.9% (JS); ASP.NET Core 19.7%
  (C#, no real competitor); FastAPI 14.8% / Flask 14.4% / Django 12.6%
  (Python, three-way split, FastAPI fastest-growing at +5pp YoY); Spring
  Boot 14.7% (Java/Kotlin, already ported); Laravel 8.9% vs. Symfony 4.0%
  (PHP, Laravel dominant).
- **Databases**: PostgreSQL 55.6% (have), MySQL 40.5%, SQLite 37.5%
  (have, opt-in), SQL Server 30.1%, Redis 28%, MongoDB 24%, MariaDB
  22.5%, Oracle 10.6%, DuckDB 3.3%.

**In-flight, not a gap:** a MySQL `DbSource` backend already exists,
uncommitted (`implementations/rust/src/db/mysql.rs`,
`implementations/rust/tests/schema_isolation_mysql.rs`, the `mysql`
Cargo feature, new rows in `docs/adapter-decisions.md`). At 40.5% it
would otherwise top the backend ranking below — omitted because the work
is already done, not overlooked. MariaDB (22.5%) rides the same
`sqlx/mysql` driver, so it isn't a separate line item either.

**Recommendation — language/framework ports, ranked:**
1. **Python / FastAPI** — 57.9% usage, 2nd only to JS, no port today.
   FastAPI is fastest-growing and has a real single async DB story
   (`SQLAlchemy`/`asyncpg`) comparable to `sqlx`; it beats Flask/Django
   as the pick since it's already the default for API-only services.
2. **C# / ASP.NET Core** — 27.8% usage, ASP.NET Core is the *only* real
   contender (19.7%, no comparable rival) — zero framework-choice
   ambiguity, and `Npgsql`/ADO.NET is a mature `sqlx`-equivalent. Best
   framework-landscape fit of any unported language.
3. **PHP / Laravel** — 18.9% usage, Laravel is 2x Symfony so the choice
   is clear, and PDO is a real cross-driver abstraction. Ranked last
   because PHP's shared-nothing, process-per-request model has no
   long-lived connection/pool to embed into — the "reuse the host's
   existing connection" pitch needs rethinking before this is a
   straight `PORTING.md` exercise.

**Recommendation — DB backends, ranked (Rust `DbSource`, `sqlite.rs`
pattern):**
1. **SQL Server** — 30.1% usage, highest-usage engine with zero backend
   anywhere in the project. No `sqlx` support (dropped upstream), so
   this needs `tiberius` directly — real but scoped, same shape as the
   SQLite/MySQL opt-in-feature precedent.
2. **DuckDB** — only 3.3% usage, doesn't earn priority on the
   survey-weighted criterion, but is a cheap follow-on: in-process like
   SQLite (same low-friction `DbSource` fit), just not worth jumping the
   queue for on usage data alone.

**Explicitly excluded, despite high survey numbers:**
- **MongoDB (24%) and Redis (28%)** — fail the project's data model, not
  just "hard to implement": `DbSource` needs a live catalog of
  tables/columns to allow-list against (CLAUDE.md's "no unvalidated
  identifier reaches SQL text" invariant) and a SQL-subset filter DSL
  (`spec/filter-dsl.md`). Neither is a schemaful, SQL-queryable store.
- **C++ (23.5%)** — no dominant web framework (Crow/Drogon/Pistache all
  niche) — would force an arbitrary pick, unlike Axum/Spring/Express/net-http.
- **Java (29.4%)** as a separate port — already served by Kotlin/Spring
  Boot: same JVM, same JDBC abstraction, same dominant framework. A pure
  Java port would duplicate `implementations/spring-boot-starter` for
  syntax only.

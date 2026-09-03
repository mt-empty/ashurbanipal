//! Which database engine the target under test is backed by, and the
//! handful of places the spec's own relaxations (`docs/adapter-decisions.md`)
//! make a conformance expectation legitimately backend-specific.
//!
//! Each divergence is one method returning a purpose-built enum (or the
//! concrete expected value): call sites `match` it exhaustively, so adding
//! a backend is a compile error at every place its behavior might differ,
//! not a silently-wrong `if` that fell through. Everything the spec makes
//! engine-independent stays a plain `assert_exact` with no reference to
//! this type.
//!
//! Determined once, before any test runs, from the loaded seed's
//! `_conformance_meta.dialect` sentinel column (`common::ensure_seed`
//! reads it). `ASHURBANIPAL_CONFORMANCE_BACKEND` is only a fallback for a
//! seed predating that column; absent both, Postgres — the reference.

use std::sync::OnceLock;

/// Set once from `_conformance_meta.dialect` by `common::ensure_seed`.
static SEEDED: OnceLock<Backend> = OnceLock::new();

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Backend {
    Postgres,
    Mysql,
    Sqlite,
}

/// What `/api/tables/common-values` returns for a column that has data.
pub enum CommonValues {
    /// Postgres samples `pg_stats`: a non-empty, most-frequent-first list.
    Sampled,
    /// MySQL and SQLite have no most-common-values catalog and always
    /// answer with an empty list (`docs/adapter-decisions.md` §5.5).
    AlwaysEmpty,
}

/// The strongest claim the runner can make about a never-`ANALYZE`d
/// table's `approx_rows`.
pub enum UnanalyzedCount {
    /// Postgres `reltuples` before ANALYZE, and SQLite's unconditional
    /// no-cardinality sentinel, both read back exactly `-1`.
    ExactlyMinusOne,
    /// MySQL's InnoDB fills `information_schema.tables.table_rows` in on
    /// first access, so only "a valid estimate" is guaranteed
    /// (`docs/adapter-decisions.md` §5.3).
    AnyValidEstimate,
}

impl Backend {
    fn parse(raw: &str) -> Option<Backend> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "postgres" | "postgresql" => Some(Backend::Postgres),
            "mysql" | "mariadb" => Some(Backend::Mysql),
            "sqlite" => Some(Backend::Sqlite),
            _ => None,
        }
    }

    /// Records the dialect the loaded seed declares in its
    /// `_conformance_meta.dialect` sentinel column — the authoritative
    /// source, read once by `common::ensure_seed` before any test runs.
    /// A recognized value wins over the `ASHURBANIPAL_CONFORMANCE_BACKEND`
    /// fallback in [`current`](Self::current); an absent or unrecognized
    /// one (e.g. a seed predating the column) leaves the fallback in play.
    pub fn record_from_seed(dialect: &str) {
        if let Some(backend) = Backend::parse(dialect) {
            let _ = SEEDED.set(backend);
        }
    }

    /// The backend the target is running: the loaded seed's declared
    /// dialect if [`record_from_seed`](Self::record_from_seed) saw one,
    /// otherwise `ASHURBANIPAL_CONFORMANCE_BACKEND`, otherwise Postgres —
    /// the reference.
    pub fn current() -> Backend {
        if let Some(backend) = SEEDED.get() {
            return *backend;
        }
        static ENV_FALLBACK: OnceLock<Backend> = OnceLock::new();
        *ENV_FALLBACK.get_or_init(|| {
            std::env::var("ASHURBANIPAL_CONFORMANCE_BACKEND")
                .ok()
                .and_then(|raw| Backend::parse(&raw))
                .unwrap_or(Backend::Postgres)
        })
    }

    /// The name of the connection's own default schema — what an absent
    /// `schema` param resolves to, and the value `schema=<this>` must
    /// resolve identically to. Postgres seeds into `public`; SQLite's sole
    /// schema is `main`; MySQL's is the connection's database, which for
    /// this suite's devcontainer target is `ashurbanipal` (override with
    /// `ASHURBANIPAL_CONFORMANCE_DEFAULT_SCHEMA` for another deployment).
    pub fn default_schema(self) -> String {
        match self {
            Backend::Postgres => "public".to_string(),
            Backend::Sqlite => "main".to_string(),
            Backend::Mysql => std::env::var("ASHURBANIPAL_CONFORMANCE_DEFAULT_SCHEMA")
                .unwrap_or_else(|_| "ashurbanipal".to_string()),
        }
    }

    pub fn common_values(self) -> CommonValues {
        match self {
            Backend::Postgres => CommonValues::Sampled,
            Backend::Mysql | Backend::Sqlite => CommonValues::AlwaysEmpty,
        }
    }

    pub fn unanalyzed_count(self) -> UnanalyzedCount {
        match self {
            Backend::Postgres | Backend::Sqlite => UnanalyzedCount::ExactlyMinusOne,
            Backend::Mysql => UnanalyzedCount::AnyValidEstimate,
        }
    }

    /// How a boolean column's value must be written in a `filter` condition
    /// that compares it as text: Postgres renders `true`/`false`, MySQL and
    /// SQLite render `1`/`0` (`docs/adapter-decisions.md` §5.4.2).
    pub fn bool_true_literal(self) -> &'static str {
        match self {
            Backend::Postgres => "true",
            Backend::Mysql | Backend::Sqlite => "1",
        }
    }
}

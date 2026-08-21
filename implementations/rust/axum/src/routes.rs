use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Query, State};
use axum::http::{HeaderValue, StatusCode};
use axum::middleware::map_response;
use axum::response::{Html, IntoResponse, Json, Response};
use axum::routing::get;
use axum::Router;
use serde::{Deserialize, Serialize};

use ashurbanipal::filter;
use ashurbanipal::{Config, DbError, DbSource, QueryOpts, TableInfo};

const DBVIEWER_HTML: &str = include_str!("../frontend/dbviewer.html");

const PROTOCOL_HEADER: &str = "x-ashurbanipal-protocol";
/// Bumped only for non-additive wire changes; additive optional fields
/// keep the same version.
const PROTOCOL_VERSION: &str = "1";

pub(crate) struct AppState<S> {
    pub config: Config,
    /// Ordered `(name, source)` pairs; the first entry is the default a
    /// request with no `source` param resolves to (mirrors `api/sources`'
    /// listing order, which callers can rely on for the same reason).
    pub sources: Vec<(String, S)>,
    pub http: reqwest::Client,
}

/// If `config.enabled` is false (the default), every route (including the
/// HTML one) 404s — indistinguishable from the crate not being mounted at
/// all. The host decides when that's true; this crate has no opinion on
/// environment names.
///
/// `sources` MUST be non-empty — a host with nothing to browse should pass
/// `enabled = false` instead, not an empty list.
pub fn router<S: DbSource>(config: Config, sources: Vec<(String, S)>) -> Router {
    if !config.is_enabled() {
        return Router::new();
    }
    assert!(!sources.is_empty(), "router() requires at least one source");
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
        .expect("reqwest client construction only fails on TLS backend misconfiguration");
    let state = Arc::new(AppState {
        config,
        sources,
        http,
    });
    // The version header goes on every API response (errors included) but
    // not the HTML route, hence the separate layered sub-router.
    let api = Router::new()
        .route("/__ashurbanipal/api/sources", get(list_sources::<S>))
        .route("/__ashurbanipal/api/schemas", get(list_schemas::<S>))
        .route("/__ashurbanipal/api/tables", get(list_tables::<S>))
        .route("/__ashurbanipal/api/table-counts", get(table_counts::<S>))
        .route("/__ashurbanipal/api/tables/data", get(table_data::<S>))
        .route(
            "/__ashurbanipal/api/tables/common-values",
            get(common_values::<S>),
        )
        .route("/__ashurbanipal/api/siblings", get(siblings::<S>))
        .layer(map_response(stamp_protocol_version));
    Router::new()
        .route("/__ashurbanipal", get(serve_html::<S>))
        .merge(api)
        .with_state(state)
}

/// Resolves the `source` query param against `state.sources` the same way
/// `schema` resolves against a live catalog list (`spec/protocol.md` §6):
/// absent means the first-registered default, present means an exact
/// case-sensitive match or a rejection — never a fallback guess.
fn resolve_source<'a, S>(
    sources: &'a [(String, S)],
    requested: Option<&str>,
) -> Result<&'a S, DbError> {
    match requested {
        None => Ok(&sources[0].1),
        Some(name) => sources
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, s)| s)
            .ok_or_else(|| DbError::NotAllowed(format!("source {name:?}"))),
    }
}

async fn stamp_protocol_version(mut response: Response) -> Response {
    response
        .headers_mut()
        .insert(PROTOCOL_HEADER, HeaderValue::from_static(PROTOCOL_VERSION));
    response
}

/// Bridges `ashurbanipal-core`'s framework-agnostic `DbError` (and this
/// crate's own bad-request cases, e.g. an invalid `order` value) into
/// `axum::IntoResponse`. A wrapper, not a direct `impl IntoResponse for
/// DbError`, because neither `DbError` nor `IntoResponse` is defined in
/// this crate — the orphan rule forbids that impl here.
enum ApiError {
    Db(DbError),
    BadRequest(String),
}

impl From<DbError> for ApiError {
    fn from(e: DbError) -> Self {
        ApiError::Db(e)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        match self {
            ApiError::BadRequest(msg) => (StatusCode::BAD_REQUEST, msg).into_response(),
            ApiError::Db(DbError::NotAllowed(what)) => {
                (StatusCode::BAD_REQUEST, format!("not allowed: {what}")).into_response()
            }
            ApiError::Db(DbError::FilterParse(reason)) => {
                (StatusCode::BAD_REQUEST, format!("invalid filter: {reason}")).into_response()
            }
            ApiError::Db(DbError::Sqlx(e)) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("database error: {e}"),
            )
                .into_response(),
        }
    }
}

async fn serve_html<S: DbSource>(State(_): State<Arc<AppState<S>>>) -> Html<&'static str> {
    Html(DBVIEWER_HTML)
}

#[derive(Serialize)]
struct SourceEntry {
    name: String,
}

#[derive(Serialize)]
struct SourcesResponse {
    sources: Vec<SourceEntry>,
}

/// Never fails: `sources` is always non-empty (`router()` asserts it), so
/// there's no allow-list to check against — this route *is* the allow-list.
async fn list_sources<S: DbSource>(State(state): State<Arc<AppState<S>>>) -> Response {
    let sources = state
        .sources
        .iter()
        .map(|(name, _)| SourceEntry { name: name.clone() })
        .collect();
    Json(SourcesResponse { sources }).into_response()
}

#[derive(Serialize)]
struct SchemasResponse {
    schemas: Vec<String>,
}

#[derive(Deserialize)]
struct SourceParams {
    source: Option<String>,
}

async fn list_schemas<S: DbSource>(
    State(state): State<Arc<AppState<S>>>,
    Query(params): Query<SourceParams>,
) -> Result<Json<SchemasResponse>, ApiError> {
    let source = resolve_source(&state.sources, params.source.as_deref())?;
    let schemas = source.list_schemas().await?;
    Ok(Json(SchemasResponse { schemas }))
}

#[derive(Deserialize)]
struct SchemaParams {
    schema: Option<String>,
    source: Option<String>,
}

#[derive(Serialize)]
struct TablesResponse {
    tables: Vec<TableInfo>,
}

async fn list_tables<S: DbSource>(
    State(state): State<Arc<AppState<S>>>,
    Query(params): Query<SchemaParams>,
) -> Result<Json<TablesResponse>, ApiError> {
    let source = resolve_source(&state.sources, params.source.as_deref())?;
    let tables = source.list_tables(params.schema.as_deref()).await?;
    Ok(Json(TablesResponse { tables }))
}

#[derive(Serialize)]
struct CountEntry {
    table: String,
    approx_rows: i64,
}

#[derive(Serialize)]
struct CountsResponse {
    counts: Vec<CountEntry>,
}

async fn table_counts<S: DbSource>(
    State(state): State<Arc<AppState<S>>>,
    Query(params): Query<SchemaParams>,
) -> Result<Json<CountsResponse>, ApiError> {
    let source = resolve_source(&state.sources, params.source.as_deref())?;
    let counts = source.table_counts(params.schema.as_deref()).await?;
    Ok(Json(CountsResponse {
        counts: counts
            .into_iter()
            .map(|(table, approx_rows)| CountEntry { table, approx_rows })
            .collect(),
    }))
}

#[derive(Deserialize)]
struct DataParams {
    schema: Option<String>,
    source: Option<String>,
    table: String,
    filter: Option<String>,
    #[serde(default, deserialize_with = "deserialize_saturating_u32")]
    limit: Option<u32>,
    #[serde(default, deserialize_with = "deserialize_saturating_u32")]
    offset: Option<u32>,
    sort: Option<String>,
    order: Option<String>,
}

/// `spec/protocol.md` §5.4 requires `limit`/`offset` to be clamped, never
/// rejected, for out-of-range values — saturating via `i128` (not `u32`)
/// keeps axum's `Query` extractor from 400ing before the real clamp/`OFFSET`
/// handling runs; non-numeric input still 400s. See
/// `conformance/runner/table_data.rs::offset_is_unclamped_and_beyond_table_size_returns_empty_rows`.
fn deserialize_saturating_u32<'de, D>(deserializer: D) -> Result<Option<u32>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = String::deserialize(deserializer)?;
    match raw.parse::<u32>() {
        Ok(v) => Ok(Some(v)),
        Err(_) => match raw.parse::<i128>() {
            Ok(v) => Ok(Some(v.clamp(0, u32::MAX as i128) as u32)),
            Err(e) => Err(serde::de::Error::custom(e)),
        },
    }
}

async fn table_data<S: DbSource>(
    State(state): State<Arc<AppState<S>>>,
    Query(params): Query<DataParams>,
) -> Result<Response, ApiError> {
    let source = resolve_source(&state.sources, params.source.as_deref())?;
    // An empty (or whitespace-only) filter param means "no filter", not a
    // deserialization target; a valid-but-empty JSON array means the same
    // (spec/protocol.md §5.4.2).
    let parsed_filter = match params.filter.as_deref() {
        Some(raw) if !raw.trim().is_empty() => match filter::parse(raw) {
            Ok(conditions) if conditions.is_empty() => None,
            Ok(conditions) => Some(conditions),
            Err(e) => return Err(DbError::FilterParse(e.to_string()).into()),
        },
        _ => None,
    };

    let limits = &state.config.limits;
    let limit = params
        .limit
        .unwrap_or(limits.default_page_size)
        .clamp(1, limits.max_page_size);
    let descending = match params.order.as_deref() {
        None | Some("asc") => false,
        Some("desc") => true,
        Some(other) => {
            return Err(ApiError::BadRequest(format!(
                "invalid order {other:?} (expected \"asc\" or \"desc\")"
            )))
        }
    };

    let opts = QueryOpts {
        limit,
        offset: params.offset.unwrap_or(0),
        sort: params.sort,
        descending,
        timeout_secs: limits.query_timeout_secs,
        filter: parsed_filter,
    };
    let data = source
        .query_table(params.schema.as_deref(), &params.table, opts)
        .await?;
    Ok(Json(data).into_response())
}

#[derive(Deserialize)]
struct CommonValuesParams {
    schema: Option<String>,
    source: Option<String>,
    table: String,
    column: String,
}

#[derive(Serialize)]
struct CommonValueEntry {
    value: String,
    freq: f32,
}

#[derive(Serialize)]
struct CommonValuesResponse {
    values: Vec<CommonValueEntry>,
}

async fn common_values<S: DbSource>(
    State(state): State<Arc<AppState<S>>>,
    Query(params): Query<CommonValuesParams>,
) -> Result<Json<CommonValuesResponse>, ApiError> {
    let source = resolve_source(&state.sources, params.source.as_deref())?;
    let values = source
        .common_values(params.schema.as_deref(), &params.table, &params.column)
        .await?;
    Ok(Json(CommonValuesResponse {
        values: values
            .into_iter()
            .map(|(value, freq)| CommonValueEntry { value, freq })
            .collect(),
    }))
}

#[derive(Serialize)]
struct SiblingStatus {
    name: String,
    dbviewer_url: String,
    healthy: bool,
}

#[derive(Serialize)]
struct SiblingsResponse {
    siblings: Vec<SiblingStatus>,
}

async fn siblings<S: DbSource>(State(state): State<Arc<AppState<S>>>) -> Response {
    let checks = state.config.siblings.iter().cloned().map(|sibling| {
        let http = state.http.clone();
        async move {
            let health_url = health_url(&sibling.dbviewer_url, &sibling.health_path);
            let healthy = match health_url {
                Some(url) => matches!(
                    http.get(url).send().await,
                    Ok(resp) if resp.status().is_success()
                ),
                None => false,
            };
            SiblingStatus {
                name: sibling.name,
                dbviewer_url: sibling.dbviewer_url,
                healthy,
            }
        }
    });
    let siblings = futures_join_all(checks).await;
    Json(SiblingsResponse { siblings }).into_response()
}

/// Resolves against the sibling's origin, not the dbviewer path.
fn health_url(dbviewer_url: &str, health_path: &str) -> Option<String> {
    let scheme_end = dbviewer_url.find("://")? + 3;
    let host_end = dbviewer_url[scheme_end..]
        .find('/')
        .map(|i| scheme_end + i)
        .unwrap_or(dbviewer_url.len());
    Some(format!("{}{}", &dbviewer_url[..host_end], health_path))
}

async fn futures_join_all<F, T>(futures: impl IntoIterator<Item = F>) -> Vec<T>
where
    F: std::future::Future<Output = T> + Send + 'static,
    T: Send + 'static,
{
    let handles: Vec<_> = futures.into_iter().map(tokio::spawn).collect();
    let mut results = Vec::with_capacity(handles.len());
    for handle in handles {
        results.push(handle.await.expect("sibling check task panicked"));
    }
    results
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn health_url_resolves_against_origin() {
        assert_eq!(
            health_url("https://billing.internal.vpn/__ashurbanipal", "/health"),
            Some("https://billing.internal.vpn/health".to_string())
        );
        assert_eq!(
            health_url("http://localhost:4001/__ashurbanipal", "/healthz"),
            Some("http://localhost:4001/healthz".to_string())
        );
        assert_eq!(health_url("not-a-url", "/health"), None);
    }

    // resolve_source carries no `S: DbSource` bound, so these run against
    // plain data — no pool/DB needed, unlike the tests/*.rs integration
    // suite (which `mise run rust:test`'s `cargo test --lib` deliberately
    // excludes, per its own doc comment in mise.toml — these inline tests
    // are this feature's only automated, CI-covered coverage).
    fn sources(names: &[&'static str]) -> Vec<(String, &'static str)> {
        names.iter().map(|n| (n.to_string(), *n)).collect()
    }

    #[test]
    fn resolve_source_absent_picks_first_registered() {
        let sources = sources(&["primary", "reporting"]);
        assert_eq!(resolve_source(&sources, None).unwrap(), &"primary");
    }

    #[test]
    fn resolve_source_present_finds_exact_match() {
        let sources = sources(&["primary", "reporting"]);
        assert_eq!(
            resolve_source(&sources, Some("reporting")).unwrap(),
            &"reporting"
        );
    }

    #[test]
    fn resolve_source_unknown_name_is_rejected() {
        let sources = sources(&["primary", "reporting"]);
        assert!(matches!(
            resolve_source(&sources, Some("bogus")),
            Err(DbError::NotAllowed(_))
        ));
    }

    #[test]
    fn resolve_source_is_case_sensitive() {
        let sources = sources(&["primary"]);
        assert!(matches!(
            resolve_source(&sources, Some("Primary")),
            Err(DbError::NotAllowed(_))
        ));
    }

    struct NeverQueriedSource;

    impl DbSource for NeverQueriedSource {
        async fn list_schemas(&self) -> Result<Vec<String>, DbError> {
            unreachable!("router() must panic on empty sources before any query runs")
        }
        async fn list_tables(&self, _schema: Option<&str>) -> Result<Vec<TableInfo>, DbError> {
            unreachable!()
        }
        async fn table_counts(&self, _schema: Option<&str>) -> Result<Vec<(String, i64)>, DbError> {
            unreachable!()
        }
        async fn query_table(
            &self,
            _schema: Option<&str>,
            _table: &str,
            _opts: QueryOpts,
        ) -> Result<ashurbanipal::TableData, DbError> {
            unreachable!()
        }
        async fn common_values(
            &self,
            _schema: Option<&str>,
            _table: &str,
            _column: &str,
        ) -> Result<Vec<(String, f32)>, DbError> {
            unreachable!()
        }
    }

    #[test]
    #[should_panic(expected = "router() requires at least one source")]
    fn router_panics_on_empty_sources_when_enabled() {
        let config = Config::from_toml("enabled = true").unwrap();
        let _ = router::<NeverQueriedSource>(config, Vec::new());
    }

    #[test]
    fn router_disabled_never_reaches_the_empty_sources_check() {
        // Fail-closed takes priority: a disabled host with no sources
        // configured must 404 quietly, not panic at startup.
        let config = Config::default();
        let _ = router::<NeverQueriedSource>(config, Vec::new());
    }
}

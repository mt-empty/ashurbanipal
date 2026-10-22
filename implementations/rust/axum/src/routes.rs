use std::sync::Arc;
use std::time::Duration;

use axum::extract::{FromRequestParts, State};
use axum::http::header::X_CONTENT_TYPE_OPTIONS;
use axum::http::request::Parts;
use axum::http::{HeaderValue, StatusCode};
use axum::middleware::map_response;
use axum::response::{Html, IntoResponse, Json, Response};
use axum::routing::get;
use axum::Router;
use serde::{Deserialize, Serialize};

use ashurbanipal::filter;
use ashurbanipal::{
    resolve_source, Config, DbError, DbSource, Instance, JoinData, JoinOpts, JoinSpec,
    ProblemDetails, QueryOpts, ReferencedBy, SiblingsView, Structure, TableInfo,
};

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
    pub siblings: SiblingsView,
}

/// If `config.enabled` is false (the default), every route (including the
/// HTML one) 404s — indistinguishable from the crate not being mounted at
/// all. The host decides when that's true; this crate has no opinion on
/// environment names.
///
/// `sources` MUST be non-empty — a host with nothing to browse should pass
/// `enabled = false` instead, not an empty list. Sibling config is never
/// rejected: `/api/siblings` reports what it corrected in `warnings`.
pub fn router<S: DbSource>(config: Config, sources: Vec<(String, S)>) -> Router {
    if !config.is_enabled() {
        return Router::new();
    }
    assert!(!sources.is_empty(), "router() requires at least one source");
    let siblings_view = config.siblings_view();
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
        .expect("reqwest client construction only fails on TLS backend misconfiguration");
    let state = Arc::new(AppState {
        config,
        sources,
        http,
        siblings: siblings_view,
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
        .route(
            "/__ashurbanipal/api/tables/referenced-by",
            get(referenced_by::<S>),
        )
        .route("/__ashurbanipal/api/tables/structure", get(structure::<S>))
        .route("/__ashurbanipal/api/tables/join", get(table_join::<S>))
        .route("/__ashurbanipal/api/siblings", get(siblings::<S>))
        .layer(map_response(stamp_api_headers));
    Router::new()
        .route("/__ashurbanipal", get(serve_html::<S>))
        .merge(api)
        .with_state(state)
}

// nosniff stops a browser from rendering echoed request text in a JSON error as HTML.
async fn stamp_api_headers(mut response: Response) -> Response {
    let headers = response.headers_mut();
    headers.insert(PROTOCOL_HEADER, HeaderValue::from_static(PROTOCOL_VERSION));
    headers.insert(X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
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
        let (status, code, title) = match self {
            ApiError::BadRequest(msg) => (400, "invalid_parameter", msg),
            ApiError::Db(err) => err.problem(),
        };
        // Never `Json<ProblemDetails>` — that sets `application/json`, and
        // `spec/protocol.md` §2 requires `application/problem+json`.
        let body = serde_json::to_vec(&ProblemDetails::new(status, code, title))
            .expect("ProblemDetails serialization is infallible");
        Response::builder()
            .status(
                StatusCode::from_u16(status).expect("problem() only returns valid HTTP statuses"),
            )
            .header(axum::http::header::CONTENT_TYPE, "application/problem+json")
            .body(axum::body::Body::from(body))
            .expect("a status + one header + a byte body always builds")
    }
}

/// Wraps `axum::extract::Query` so a malformed query string — a missing
/// required field, a duplicate key, a value the target type can't parse —
/// surfaces through this crate's own `application/problem+json` path
/// instead of axum's default plain-text extractor rejection.
/// `spec/protocol.md` §2 requires every error response use problem+json,
/// and this rejection happens inside axum's own request-dispatch layer
/// (unlike the pre-dispatch, server-level rejections `PORTING.md`'s
/// "Request-boundary rejections" section carves out), so it's this crate's
/// to fix, not an accepted per-port gap.
struct Query<T>(T);

impl<T, S> FromRequestParts<S> for Query<T>
where
    T: serde::de::DeserializeOwned,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        axum::extract::Query::<T>::from_request_parts(parts, state)
            .await
            .map(|axum::extract::Query(value)| Query(value))
            .map_err(|rejection| ApiError::BadRequest(rejection.to_string()))
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
struct JoinParams {
    schema: Option<String>,
    source: Option<String>,
    join: String,
    filter: Option<String>,
    #[serde(default, deserialize_with = "deserialize_saturating_u32")]
    limit: Option<u32>,
    #[serde(default, deserialize_with = "deserialize_saturating_u32")]
    offset: Option<u32>,
    sort: Option<String>,
    sort_join: Option<String>,
    order: Option<String>,
}

fn join_request(
    params: &JoinParams,
    limits: &ashurbanipal::Limits,
) -> Result<(JoinSpec, JoinOpts), ApiError> {
    let spec = JoinSpec::parse(&params.join).map_err(|e| ApiError::from(DbError::BadJoin(e.0)))?;
    let filter = match params.filter.as_deref() {
        Some(raw) if !raw.trim().is_empty() => match filter::parse_for_join(raw) {
            Ok(conditions) if conditions.is_empty() => None,
            Ok(conditions) => Some(conditions),
            Err(e) => return Err(DbError::FilterParse(e.to_string()).into()),
        },
        _ => None,
    };
    let descending = match params.order.as_deref() {
        None | Some("asc") => false,
        Some("desc") => true,
        Some(other) => {
            return Err(ApiError::BadRequest(format!(
                "invalid order {other:?} (expected \"asc\" or \"desc\")"
            )))
        }
    };
    let sort_join = match params.sort_join.as_deref() {
        None => None,
        Some(raw) => Some(raw.parse::<usize>().map_err(|_| {
            ApiError::BadRequest(format!(
                "invalid sort_join {raw:?} (expected a table position)"
            ))
        })?),
    };
    let opts = JoinOpts {
        limit: params
            .limit
            .unwrap_or(limits.default_page_size)
            .clamp(1, limits.max_page_size),
        offset: params.offset.unwrap_or(0),
        sort: params.sort.clone(),
        sort_join,
        descending,
        timeout_secs: limits.query_timeout_secs,
        filter,
    };
    Ok((spec, opts))
}

async fn table_join<S: DbSource>(
    State(state): State<Arc<AppState<S>>>,
    Query(params): Query<JoinParams>,
) -> Result<Json<JoinData>, ApiError> {
    let source = resolve_source(&state.sources, params.source.as_deref())?;
    let (spec, opts) = join_request(&params, &state.config.limits)?;
    Ok(Json(
        source
            .query_join(params.schema.as_deref(), &spec, opts)
            .await?,
    ))
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

#[derive(Deserialize)]
struct ReferencedByParams {
    schema: Option<String>,
    source: Option<String>,
    table: String,
}

#[derive(Serialize)]
struct ReferencedByResponse {
    referenced_by: Vec<ReferencedBy>,
}

async fn referenced_by<S: DbSource>(
    State(state): State<Arc<AppState<S>>>,
    Query(params): Query<ReferencedByParams>,
) -> Result<Json<ReferencedByResponse>, ApiError> {
    let source = resolve_source(&state.sources, params.source.as_deref())?;
    let referenced_by = source
        .referenced_by(params.schema.as_deref(), &params.table)
        .await?;
    Ok(Json(ReferencedByResponse { referenced_by }))
}

#[derive(Deserialize)]
struct StructureParams {
    schema: Option<String>,
    source: Option<String>,
    table: String,
}

async fn structure<S: DbSource>(
    State(state): State<Arc<AppState<S>>>,
    Query(params): Query<StructureParams>,
) -> Result<Json<Structure>, ApiError> {
    let source = resolve_source(&state.sources, params.source.as_deref())?;
    let structure = source
        .structure(params.schema.as_deref(), &params.table)
        .await?;
    Ok(Json(structure))
}

#[derive(Serialize)]
struct SiblingStatus {
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    label: Option<String>,
    base_url: String,
    healthy: bool,
}

#[derive(Serialize)]
struct SiblingsResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    instance: Option<Instance>,
    siblings: Vec<SiblingStatus>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    warnings: Vec<String>,
}

async fn siblings<S: DbSource>(State(state): State<Arc<AppState<S>>>) -> Response {
    let view = &state.siblings;
    let checks = view.siblings.iter().cloned().map(|sibling| {
        let http = state.http.clone();
        let is_instance = view.is_instance(&sibling);
        async move {
            let healthy = is_instance
                || match health_url(&sibling.base_url, &sibling.health_path) {
                    Some(url) => matches!(
                        http.get(url).send().await,
                        Ok(resp) if resp.status().is_success()
                    ),
                    None => false,
                };
            SiblingStatus {
                name: sibling.name,
                label: sibling.label,
                base_url: sibling.base_url,
                healthy,
            }
        }
    });
    let siblings = futures_join_all(checks).await;
    Json(SiblingsResponse {
        instance: view.instance.clone(),
        siblings,
        warnings: view.warnings.clone(),
    })
    .into_response()
}

/// Resolves against the sibling's origin, not its path.
fn health_url(base_url: &str, health_path: &str) -> Option<String> {
    let scheme_end = base_url.find("://")? + 3;
    let host_end = base_url[scheme_end..]
        .find('/')
        .map(|i| scheme_end + i)
        .unwrap_or(base_url.len());
    Some(format!("{}{}", &base_url[..host_end], health_path))
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

    // resolve_source itself now lives in ashurbanipal-core (see its own
    // tests there) — only the router()-specific behavior below is
    // axum-adapter-specific and stays here.
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
        async fn referenced_by(
            &self,
            _schema: Option<&str>,
            _table: &str,
        ) -> Result<Vec<ReferencedBy>, DbError> {
            unreachable!()
        }
        async fn structure(
            &self,
            _schema: Option<&str>,
            _table: &str,
        ) -> Result<Structure, DbError> {
            unreachable!()
        }
        async fn query_join(
            &self,
            _schema: Option<&str>,
            _spec: &JoinSpec,
            _opts: JoinOpts,
        ) -> Result<JoinData, DbError> {
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

    // Port 9 refuses at once, so every check is a fast `healthy: false`.
    const LABELLED: &str = r#"
        enabled = true

        [instance]
        name = "orders"
        label = "dev"

        [[siblings]]
        name = "orders"
        label = "dev"
        base_url = "http://127.0.0.1:9/__ashurbanipal"
        health_path = "/health"

        [[siblings]]
        name = "orders"
        label = "int"
        base_url = "http://127.0.0.1:9/__ashurbanipal"
        health_path = "/health"

        [[siblings]]
        name = "billing"
        base_url = "http://127.0.0.1:9/__ashurbanipal"
        health_path = "/health"
    "#;

    #[tokio::test]
    async fn siblings_report_this_instance_in_place_without_a_check() {
        use tower::ServiceExt;
        let config = Config::from_toml(LABELLED).unwrap();
        let app = router(config, vec![("primary".to_string(), NeverQueriedSource)]);
        let resp = app
            .oneshot(
                axum::http::Request::builder()
                    .uri("/__ashurbanipal/api/siblings")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "instance": { "name": "orders", "label": "dev" },
                "siblings": [
                    { "name": "orders", "label": "dev", "base_url": "http://127.0.0.1:9/__ashurbanipal", "healthy": true },
                    { "name": "orders", "label": "int", "base_url": "http://127.0.0.1:9/__ashurbanipal", "healthy": false },
                    { "name": "billing", "base_url": "http://127.0.0.1:9/__ashurbanipal", "healthy": false },
                ],
            })
        );
    }

    #[tokio::test]
    async fn sibling_config_mistakes_are_kept_and_warned() {
        use tower::ServiceExt;
        let config =
            Config::from_toml(&LABELLED.replace("label = \"int\"", "label = \"dev\"")).unwrap();
        let app = router(config, vec![("primary".to_string(), NeverQueriedSource)]);
        let resp = app
            .oneshot(
                axum::http::Request::builder()
                    .uri("/__ashurbanipal/api/siblings")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["siblings"].as_array().unwrap().len(), 3);
        assert_eq!(
            json["warnings"],
            serde_json::json!(["two siblings share the name \"orders\" and the label \"dev\""])
        );
    }
}

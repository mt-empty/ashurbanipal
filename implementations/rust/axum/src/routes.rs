use std::sync::Arc;

use axum::extract::{FromRequestParts, State};
use axum::http::header::X_CONTENT_TYPE_OPTIONS;
use axum::http::request::Parts;
use axum::http::{HeaderValue, StatusCode};
use axum::middleware::map_response;
use axum::response::{Html, IntoResponse, Json, Response};
use axum::routing::get;
use axum::Router;
use tower_http::compression::CompressionLayer;

use ashurbanipal::protocol_wire::{
    CommonValuesParams, CommonValuesResponse, CountsResponse, DataParams, JoinParams,
    ReferencedByResponse, SchemaParams, SchemasResponse, SourceParams, SourcesResponse,
    TableParams, TablesResponse,
};
use ashurbanipal::{
    resolve_source, Config, DbError, DbSource, JoinData, ProblemDetails, SiblingChecker, Structure,
    TableData,
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
    pub siblings: SiblingChecker,
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
    let checker = SiblingChecker::new(&config);
    let state = Arc::new(AppState {
        config,
        sources,
        siblings: checker,
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
        .route(
            "/__ashurbanipal",
            get(serve_html::<S>).layer(CompressionLayer::new()),
        )
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

/// Never fails: `sources` is always non-empty (`router()` asserts it), so
/// there's no allow-list to check against — this route *is* the allow-list.
async fn list_sources<S: DbSource>(State(state): State<Arc<AppState<S>>>) -> Response {
    Json(SourcesResponse::from_sources(&state.sources)).into_response()
}

async fn list_schemas<S: DbSource>(
    State(state): State<Arc<AppState<S>>>,
    Query(params): Query<SourceParams>,
) -> Result<Json<SchemasResponse>, ApiError> {
    let source = resolve_source(&state.sources, params.source.as_deref())?;
    Ok(Json(source.list_schemas().await?.into()))
}

async fn list_tables<S: DbSource>(
    State(state): State<Arc<AppState<S>>>,
    Query(params): Query<SchemaParams>,
) -> Result<Json<TablesResponse>, ApiError> {
    let source = resolve_source(&state.sources, params.source.as_deref())?;
    let tables = source.list_tables(params.schema.as_deref()).await?;
    Ok(Json(TablesResponse { tables }))
}

async fn table_counts<S: DbSource>(
    State(state): State<Arc<AppState<S>>>,
    Query(params): Query<SchemaParams>,
) -> Result<Json<CountsResponse>, ApiError> {
    let source = resolve_source(&state.sources, params.source.as_deref())?;
    Ok(Json(
        source.table_counts(params.schema.as_deref()).await?.into(),
    ))
}

async fn table_data<S: DbSource>(
    State(state): State<Arc<AppState<S>>>,
    Query(params): Query<DataParams>,
) -> Result<Json<TableData>, ApiError> {
    let source = resolve_source(&state.sources, params.source.as_deref())?;
    let opts = params.query_opts(&state.config.limits)?;
    Ok(Json(
        source
            .query_table(params.schema.as_deref(), &params.table, opts)
            .await?,
    ))
}

async fn table_join<S: DbSource>(
    State(state): State<Arc<AppState<S>>>,
    Query(params): Query<JoinParams>,
) -> Result<Json<JoinData>, ApiError> {
    let source = resolve_source(&state.sources, params.source.as_deref())?;
    let (spec, opts) = params.join_request(&state.config.limits)?;
    Ok(Json(
        source
            .query_join(params.schema.as_deref(), &spec, opts)
            .await?,
    ))
}

async fn common_values<S: DbSource>(
    State(state): State<Arc<AppState<S>>>,
    Query(params): Query<CommonValuesParams>,
) -> Result<Json<CommonValuesResponse>, ApiError> {
    let source = resolve_source(&state.sources, params.source.as_deref())?;
    let values = source
        .common_values(params.schema.as_deref(), &params.table, &params.column)
        .await?;
    Ok(Json(values.into()))
}

async fn referenced_by<S: DbSource>(
    State(state): State<Arc<AppState<S>>>,
    Query(params): Query<TableParams>,
) -> Result<Json<ReferencedByResponse>, ApiError> {
    let source = resolve_source(&state.sources, params.source.as_deref())?;
    let referenced_by = source
        .referenced_by(params.schema.as_deref(), &params.table)
        .await?;
    Ok(Json(ReferencedByResponse { referenced_by }))
}

async fn structure<S: DbSource>(
    State(state): State<Arc<AppState<S>>>,
    Query(params): Query<TableParams>,
) -> Result<Json<Structure>, ApiError> {
    let source = resolve_source(&state.sources, params.source.as_deref())?;
    let structure = source
        .structure(params.schema.as_deref(), &params.table)
        .await?;
    Ok(Json(structure))
}

async fn siblings<S: DbSource>(State(state): State<Arc<AppState<S>>>) -> Response {
    Json(state.siblings.check().await).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ashurbanipal::{JoinOpts, JoinSpec, QueryOpts, ReferencedBy, SchemaListing, TableInfo};

    // resolve_source itself now lives in ashurbanipal-core (see its own
    // tests there) — only the router()-specific behavior below is
    // axum-adapter-specific and stays here.
    struct NeverQueriedSource;

    impl DbSource for NeverQueriedSource {
        async fn list_schemas(&self) -> Result<SchemaListing, DbError> {
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

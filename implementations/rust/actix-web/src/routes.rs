use actix_web::body::MessageBody;
use actix_web::dev::{ServiceRequest, ServiceResponse};
use actix_web::http::header::{HeaderName, HeaderValue, X_CONTENT_TYPE_OPTIONS};
use actix_web::middleware::{from_fn, Compress, Next};
use actix_web::web::{self, Data};
use actix_web::{Error, HttpResponse, Scope};

use ashurbanipal::protocol_wire::{
    CommonValuesParams, CommonValuesResponse, CountsResponse, DataParams, JoinParams,
    ReferencedByResponse, SchemaParams, SchemasResponse, SourceParams, SourcesResponse,
    TableParams, TablesResponse,
};
use ashurbanipal::{
    resolve_source, Config, DbError, DbSource, JoinData, ProblemDetails, SiblingChecker,
};

const DBVIEWER_HTML: &str = include_str!("../frontend/dbviewer.html");

const PROTOCOL_HEADER: &str = "x-ashurbanipal-protocol";
/// Bumped only for non-additive wire changes; additive optional fields
/// keep the same version.
const PROTOCOL_VERSION: &str = "1";

pub struct AppState<S> {
    pub config: Config,
    /// Ordered `(name, source)` pairs; the first entry is the default a
    /// request with no `source` param resolves to (mirrors `api/sources`'
    /// listing order, which callers can rely on for the same reason).
    pub sources: Vec<(String, S)>,
    pub siblings: SiblingChecker,
}

/// Built once, not per worker — cheap to share via `web::Data`'s `Arc`,
/// unlike [`service`]'s route tree, which Actix rebuilds per worker anyway.
///
/// `sources` MUST be non-empty — a host with nothing to browse should pass
/// `enabled = false` instead, not an empty list. Sibling config is never
/// rejected: `/api/siblings` reports what it corrected in `warnings`.
pub fn app_state<S: DbSource>(config: Config, sources: Vec<(String, S)>) -> Data<AppState<S>> {
    assert!(
        !sources.is_empty(),
        "app_state() requires at least one source"
    );
    let siblings = SiblingChecker::new(&config);
    Data::new(AppState {
        config,
        sources,
        siblings,
    })
}

/// If disabled, no routes are registered — every path under the scope
/// (including HTML) falls through to the host `App`'s 404, same as unmounted.
pub fn service<S: DbSource>(state: Data<AppState<S>>) -> Scope {
    if !state.config.is_enabled() {
        return web::scope("/__ashurbanipal");
    }
    // Version header only applies to /api (separate inner scope). Routes
    // use `web::resource` (not `Scope::route`) so a method mismatch 405s.
    web::scope("/__ashurbanipal")
        .app_data(state)
        .service(
            web::resource("")
                .wrap(Compress::default())
                .route(web::get().to(serve_html)),
        )
        .service(
            web::scope("/api")
                .wrap(from_fn(stamp_api_headers))
                // Actix's default `Query<T>` rejection is its own plain-text
                // body; this routes it through `ApiError` instead so a
                // missing/duplicate/malformed query param still comes back
                // as `application/problem+json` (spec/protocol.md §2) —
                // scoped to this `/api` sub-scope, not host-global.
                .app_data(web::QueryConfig::default().error_handler(query_error_handler))
                .service(web::resource("/sources").route(web::get().to(list_sources::<S>)))
                .service(web::resource("/schemas").route(web::get().to(list_schemas::<S>)))
                .service(web::resource("/tables").route(web::get().to(list_tables::<S>)))
                .service(web::resource("/table-counts").route(web::get().to(table_counts::<S>)))
                .service(web::resource("/tables/data").route(web::get().to(table_data::<S>)))
                .service(
                    web::resource("/tables/common-values").route(web::get().to(common_values::<S>)),
                )
                .service(
                    web::resource("/tables/referenced-by").route(web::get().to(referenced_by::<S>)),
                )
                .service(web::resource("/tables/structure").route(web::get().to(structure::<S>)))
                .service(web::resource("/tables/join").route(web::get().to(table_join::<S>)))
                .service(web::resource("/siblings").route(web::get().to(siblings::<S>))),
        )
}

// nosniff stops a browser from rendering echoed request text in a JSON error as HTML.
async fn stamp_api_headers(
    req: ServiceRequest,
    next: Next<impl MessageBody>,
) -> Result<ServiceResponse<impl MessageBody>, Error> {
    let mut res = next.call(req).await?;
    let headers = res.headers_mut();
    headers.insert(
        HeaderName::from_static(PROTOCOL_HEADER),
        HeaderValue::from_static(PROTOCOL_VERSION),
    );
    headers.insert(X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    Ok(res)
}

/// Bridges `ashurbanipal-core`'s framework-agnostic `DbError` (and this
/// crate's own bad-request cases, e.g. an invalid `order` value) into
/// Actix's `?`-operator error handling via `ResponseError`. A wrapper, not
/// a direct `impl ResponseError for DbError`, because neither `DbError`
/// nor `ResponseError` is defined in this crate — the orphan rule forbids
/// that impl here.
#[derive(Debug)]
enum ApiError {
    Db(DbError),
    BadRequest(String),
}

impl From<DbError> for ApiError {
    fn from(e: DbError) -> Self {
        ApiError::Db(e)
    }
}

/// `(status, code, title)` per `spec/protocol.md` §2 — shared by
/// `status_code()` and `error_response()` so the two can't disagree.
impl ApiError {
    fn problem(&self) -> (u16, &'static str, String) {
        match self {
            ApiError::BadRequest(msg) => (400, "invalid_parameter", msg.clone()),
            ApiError::Db(err) => err.problem(),
        }
    }
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.problem().2)
    }
}

impl actix_web::ResponseError for ApiError {
    fn status_code(&self) -> actix_web::http::StatusCode {
        actix_web::http::StatusCode::from_u16(self.problem().0)
            .expect("problem() only returns valid HTTP statuses")
    }

    fn error_response(&self) -> HttpResponse {
        let (status, code, title) = self.problem();
        // Built from `status` directly rather than calling `self.status_code()`
        // again — that would re-run `self.problem()` a second time for the
        // one response this method is already building.
        let http_status = actix_web::http::StatusCode::from_u16(status)
            .expect("problem() only returns valid HTTP statuses");
        // Never `.json()` alone — `spec/protocol.md` §2 requires
        // `application/problem+json`, not plain `application/json`.
        HttpResponse::build(http_status)
            .content_type("application/problem+json")
            .body(
                serde_json::to_vec(&ProblemDetails::new(status, code, title))
                    .expect("ProblemDetails serialization is infallible"),
            )
    }
}

/// `web::QueryConfig`'s error hook (`spec/protocol.md` §2: every error
/// response is `application/problem+json`, extractor rejections included).
fn query_error_handler(
    err: actix_web::error::QueryPayloadError,
    _req: &actix_web::HttpRequest,
) -> actix_web::Error {
    ApiError::BadRequest(err.to_string()).into()
}

async fn serve_html() -> HttpResponse {
    HttpResponse::Ok()
        .content_type("text/html; charset=utf-8")
        .body(DBVIEWER_HTML)
}

/// Never fails: `sources` is always non-empty (`app_state()` asserts it), so
/// there's no allow-list to check against — this route *is* the allow-list.
async fn list_sources<S: DbSource>(state: Data<AppState<S>>) -> HttpResponse {
    HttpResponse::Ok().json(SourcesResponse::from_sources(&state.sources))
}

async fn list_schemas<S: DbSource>(
    state: Data<AppState<S>>,
    params: web::Query<SourceParams>,
) -> Result<HttpResponse, ApiError> {
    let source = resolve_source(&state.sources, params.source.as_deref())?;
    let schemas: SchemasResponse = source.list_schemas().await?.into();
    Ok(HttpResponse::Ok().json(schemas))
}

async fn list_tables<S: DbSource>(
    state: Data<AppState<S>>,
    params: web::Query<SchemaParams>,
) -> Result<HttpResponse, ApiError> {
    let source = resolve_source(&state.sources, params.source.as_deref())?;
    let tables = source.list_tables(params.schema.as_deref()).await?;
    Ok(HttpResponse::Ok().json(TablesResponse { tables }))
}

async fn table_counts<S: DbSource>(
    state: Data<AppState<S>>,
    params: web::Query<SchemaParams>,
) -> Result<HttpResponse, ApiError> {
    let source = resolve_source(&state.sources, params.source.as_deref())?;
    let counts: CountsResponse = source.table_counts(params.schema.as_deref()).await?.into();
    Ok(HttpResponse::Ok().json(counts))
}

async fn table_data<S: DbSource>(
    state: Data<AppState<S>>,
    params: web::Query<DataParams>,
) -> Result<HttpResponse, ApiError> {
    let source = resolve_source(&state.sources, params.source.as_deref())?;
    let opts = params.query_opts(&state.config.limits)?;
    let data = source
        .query_table(params.schema.as_deref(), &params.table, opts)
        .await?;
    Ok(HttpResponse::Ok().json(data))
}

async fn table_join<S: DbSource>(
    state: Data<AppState<S>>,
    params: web::Query<JoinParams>,
) -> Result<HttpResponse, ApiError> {
    let source = resolve_source(&state.sources, params.source.as_deref())?;
    let (spec, opts) = params.join_request(&state.config.limits)?;
    let data: JoinData = source
        .query_join(params.schema.as_deref(), &spec, opts)
        .await?;
    Ok(HttpResponse::Ok().json(data))
}

async fn common_values<S: DbSource>(
    state: Data<AppState<S>>,
    params: web::Query<CommonValuesParams>,
) -> Result<HttpResponse, ApiError> {
    let source = resolve_source(&state.sources, params.source.as_deref())?;
    let values: CommonValuesResponse = source
        .common_values(params.schema.as_deref(), &params.table, &params.column)
        .await?
        .into();
    Ok(HttpResponse::Ok().json(values))
}

async fn referenced_by<S: DbSource>(
    state: Data<AppState<S>>,
    params: web::Query<TableParams>,
) -> Result<HttpResponse, ApiError> {
    let source = resolve_source(&state.sources, params.source.as_deref())?;
    let referenced_by = source
        .referenced_by(params.schema.as_deref(), &params.table)
        .await?;
    Ok(HttpResponse::Ok().json(ReferencedByResponse { referenced_by }))
}

async fn structure<S: DbSource>(
    state: Data<AppState<S>>,
    params: web::Query<TableParams>,
) -> Result<HttpResponse, ApiError> {
    let source = resolve_source(&state.sources, params.source.as_deref())?;
    let structure = source
        .structure(params.schema.as_deref(), &params.table)
        .await?;
    Ok(HttpResponse::Ok().json(structure))
}

async fn siblings<S: DbSource>(state: Data<AppState<S>>) -> HttpResponse {
    HttpResponse::Ok().json(state.siblings.check().await)
}

#[cfg(test)]
mod kill_switch_tests {
    use actix_web::{test, App};

    use super::*;
    use ashurbanipal::{
        JoinOpts, JoinSpec, QueryOpts, ReferencedBy, SchemaListing, Structure, TableData, TableInfo,
    };

    /// Routing-only double — the disabled-config kill switch must reject
    /// every request before any handler runs, so none of these bodies are
    /// ever reached.
    struct NeverQueried;

    impl DbSource for NeverQueried {
        async fn list_schemas(&self) -> Result<SchemaListing, DbError> {
            unreachable!("kill switch must 404 before reaching the handler")
        }
        async fn list_tables(&self, _schema: Option<&str>) -> Result<Vec<TableInfo>, DbError> {
            unreachable!("kill switch must 404 before reaching the handler")
        }
        async fn table_counts(&self, _schema: Option<&str>) -> Result<Vec<(String, i64)>, DbError> {
            unreachable!("kill switch must 404 before reaching the handler")
        }
        async fn query_table(
            &self,
            _schema: Option<&str>,
            _table: &str,
            _opts: QueryOpts,
        ) -> Result<TableData, DbError> {
            unreachable!("kill switch must 404 before reaching the handler")
        }
        async fn common_values(
            &self,
            _schema: Option<&str>,
            _table: &str,
            _column: &str,
        ) -> Result<Vec<(String, f32)>, DbError> {
            unreachable!("kill switch must 404 before reaching the handler")
        }
        async fn referenced_by(
            &self,
            _schema: Option<&str>,
            _table: &str,
        ) -> Result<Vec<ReferencedBy>, DbError> {
            unreachable!("kill switch must 404 before reaching the handler")
        }
        async fn structure(
            &self,
            _schema: Option<&str>,
            _table: &str,
        ) -> Result<Structure, DbError> {
            unreachable!("kill switch must 404 before reaching the handler")
        }
        async fn query_join(
            &self,
            _schema: Option<&str>,
            _spec: &JoinSpec,
            _opts: JoinOpts,
        ) -> Result<JoinData, DbError> {
            unreachable!("kill switch must 404 before reaching the handler")
        }
    }

    #[actix_web::test]
    async fn disabled_config_404s_html_and_api_routes() {
        let config = Config::from_toml(
            r#"
            enabled = false
        "#,
        )
        .unwrap();
        let state = app_state(config, vec![("primary".to_string(), NeverQueried)]);
        let app = test::init_service(App::new().service(service(state))).await;

        let html = test::call_service(
            &app,
            test::TestRequest::get().uri("/__ashurbanipal").to_request(),
        )
        .await;
        assert_eq!(html.status(), 404);

        let api = test::call_service(
            &app,
            test::TestRequest::get()
                .uri("/__ashurbanipal/api/schemas")
                .to_request(),
        )
        .await;
        assert_eq!(api.status(), 404);
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

    #[actix_web::test]
    async fn siblings_report_this_instance_in_place_without_a_check() {
        let config = Config::from_toml(LABELLED).unwrap();
        let state = app_state(config, vec![("primary".to_string(), NeverQueried)]);
        let app = test::init_service(App::new().service(service(state))).await;
        let json: serde_json::Value = test::call_and_read_body_json(
            &app,
            test::TestRequest::get()
                .uri("/__ashurbanipal/api/siblings")
                .to_request(),
        )
        .await;
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

    #[actix_web::test]
    async fn sibling_config_mistakes_are_kept_and_warned() {
        let config =
            Config::from_toml(&LABELLED.replace("label = \"int\"", "label = \"dev\"")).unwrap();
        let state = app_state(config, vec![("primary".to_string(), NeverQueried)]);
        let app = test::init_service(App::new().service(service(state))).await;
        let json: serde_json::Value = test::call_and_read_body_json(
            &app,
            test::TestRequest::get()
                .uri("/__ashurbanipal/api/siblings")
                .to_request(),
        )
        .await;
        assert_eq!(json["siblings"].as_array().unwrap().len(), 3);
        assert_eq!(
            json["warnings"],
            serde_json::json!(["two siblings share the name \"orders\" and the label \"dev\""])
        );
    }
}

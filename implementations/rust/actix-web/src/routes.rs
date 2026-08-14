use actix_web::body::MessageBody;
use actix_web::dev::{ServiceRequest, ServiceResponse};
use actix_web::http::header::{HeaderName, HeaderValue};
use actix_web::middleware::{from_fn, Next};
use actix_web::web::{self, Data};
use actix_web::{Error, HttpResponse, Scope};
use serde::{Deserialize, Serialize};

use ashurbanipal::filter;
use ashurbanipal::{Config, DbError, DbSource, QueryOpts, TableInfo};

const DBVIEWER_HTML: &str = include_str!("../frontend/dbviewer.html");

const PROTOCOL_HEADER: &str = "x-ashurbanipal-protocol";
/// Bumped only for non-additive wire changes; additive optional fields
/// keep the same version.
const PROTOCOL_VERSION: &str = "1";

pub struct AppState<S> {
    pub config: Config,
    pub source: S,
    pub http: reqwest::Client,
}

/// Built once, not per worker — cheap to share via `web::Data`'s `Arc`,
/// unlike [`service`]'s route tree, which Actix rebuilds per worker anyway.
pub fn app_state<S: DbSource>(config: Config, source: S) -> Data<AppState<S>> {
    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .expect("reqwest client construction only fails on TLS backend misconfiguration");
    Data::new(AppState {
        config,
        source,
        http,
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
        .service(web::resource("").route(web::get().to(serve_html)))
        .service(
            web::scope("/api")
                .wrap(from_fn(stamp_protocol_version))
                .service(web::resource("/schemas").route(web::get().to(list_schemas::<S>)))
                .service(web::resource("/tables").route(web::get().to(list_tables::<S>)))
                .service(web::resource("/table-counts").route(web::get().to(table_counts::<S>)))
                .service(web::resource("/tables/data").route(web::get().to(table_data::<S>)))
                .service(
                    web::resource("/tables/common-values").route(web::get().to(common_values::<S>)),
                )
                .service(web::resource("/siblings").route(web::get().to(siblings::<S>))),
        )
}

async fn stamp_protocol_version(
    req: ServiceRequest,
    next: Next<impl MessageBody>,
) -> Result<ServiceResponse<impl MessageBody>, Error> {
    let mut res = next.call(req).await?;
    res.headers_mut().insert(
        HeaderName::from_static(PROTOCOL_HEADER),
        HeaderValue::from_static(PROTOCOL_VERSION),
    );
    Ok(res)
}

const TEXT_PLAIN: &str = "text/plain; charset=utf-8";

fn error_response(err: DbError) -> HttpResponse {
    match err {
        DbError::NotAllowed(what) => HttpResponse::BadRequest()
            .content_type(TEXT_PLAIN)
            .body(format!("not allowed: {what}")),
        DbError::FilterParse(reason) => HttpResponse::BadRequest()
            .content_type(TEXT_PLAIN)
            .body(format!("invalid filter: {reason}")),
        DbError::Sqlx(e) => HttpResponse::InternalServerError()
            .content_type(TEXT_PLAIN)
            .body(format!("database error: {e}")),
    }
}

async fn serve_html() -> HttpResponse {
    HttpResponse::Ok()
        .content_type("text/html; charset=utf-8")
        .body(DBVIEWER_HTML)
}

#[derive(Serialize)]
struct SchemasResponse {
    schemas: Vec<String>,
}

async fn list_schemas<S: DbSource>(state: Data<AppState<S>>) -> HttpResponse {
    match state.source.list_schemas().await {
        Ok(schemas) => HttpResponse::Ok().json(SchemasResponse { schemas }),
        Err(e) => error_response(e),
    }
}

#[derive(Deserialize)]
struct SchemaParams {
    schema: Option<String>,
}

#[derive(Serialize)]
struct TablesResponse {
    tables: Vec<TableInfo>,
}

async fn list_tables<S: DbSource>(
    state: Data<AppState<S>>,
    params: web::Query<SchemaParams>,
) -> HttpResponse {
    match state.source.list_tables(params.schema.as_deref()).await {
        Ok(tables) => HttpResponse::Ok().json(TablesResponse { tables }),
        Err(e) => error_response(e),
    }
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
    state: Data<AppState<S>>,
    params: web::Query<SchemaParams>,
) -> HttpResponse {
    match state.source.table_counts(params.schema.as_deref()).await {
        Ok(counts) => HttpResponse::Ok().json(CountsResponse {
            counts: counts
                .into_iter()
                .map(|(table, approx_rows)| CountEntry { table, approx_rows })
                .collect(),
        }),
        Err(e) => error_response(e),
    }
}

#[derive(Deserialize)]
struct DataParams {
    schema: Option<String>,
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
/// keeps serde/Actix's `Query` extractor from 400ing before the real
/// clamp/`OFFSET` handling runs; non-numeric input still 400s. Mirrors
/// `ashurbanipal-axum`'s `routes.rs`, same helper duplicated per adapter.
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
    state: Data<AppState<S>>,
    params: web::Query<DataParams>,
) -> HttpResponse {
    let params = params.into_inner();
    // An empty (or whitespace-only) filter param means "no filter", not a
    // deserialization target; a valid-but-empty JSON array means the same
    // (spec/protocol.md §5.4.2).
    let parsed_filter = match params.filter.as_deref() {
        Some(raw) if !raw.trim().is_empty() => match filter::parse(raw) {
            Ok(conditions) if conditions.is_empty() => None,
            Ok(conditions) => Some(conditions),
            Err(e) => return error_response(DbError::FilterParse(e.to_string())),
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
            return HttpResponse::BadRequest()
                .content_type(TEXT_PLAIN)
                .body(format!(
                    "invalid order {other:?} (expected \"asc\" or \"desc\")"
                ))
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
    match state
        .source
        .query_table(params.schema.as_deref(), &params.table, opts)
        .await
    {
        Ok(data) => HttpResponse::Ok().json(data),
        Err(e) => error_response(e),
    }
}

#[derive(Deserialize)]
struct CommonValuesParams {
    schema: Option<String>,
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
    state: Data<AppState<S>>,
    params: web::Query<CommonValuesParams>,
) -> HttpResponse {
    match state
        .source
        .common_values(params.schema.as_deref(), &params.table, &params.column)
        .await
    {
        Ok(values) => HttpResponse::Ok().json(CommonValuesResponse {
            values: values
                .into_iter()
                .map(|(value, freq)| CommonValueEntry { value, freq })
                .collect(),
        }),
        Err(e) => error_response(e),
    }
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

async fn siblings<S: DbSource>(state: Data<AppState<S>>) -> HttpResponse {
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
    HttpResponse::Ok().json(SiblingsResponse { siblings })
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

/// Uses Actix's own runtime spawn (not `tokio::spawn` directly) so the
/// sibling fan-out works regardless of which executor Actix is running on.
async fn futures_join_all<F, T>(futures: impl IntoIterator<Item = F>) -> Vec<T>
where
    F: std::future::Future<Output = T> + Send + 'static,
    T: Send + 'static,
{
    let handles: Vec<_> = futures.into_iter().map(actix_web::rt::spawn).collect();
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
}

#[cfg(test)]
mod kill_switch_tests {
    use actix_web::{test, App};

    use super::*;
    use ashurbanipal::TableData;

    /// Routing-only double — the disabled-config kill switch must reject
    /// every request before any handler runs, so none of these bodies are
    /// ever reached.
    struct NeverQueried;

    impl DbSource for NeverQueried {
        async fn list_schemas(&self) -> Result<Vec<String>, DbError> {
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
    }

    #[actix_web::test]
    async fn disabled_config_404s_html_and_api_routes() {
        let config = Config::from_toml(
            r#"
            environment = "dev"
            enabled_for = ["staging"]
        "#,
        )
        .unwrap();
        let state = app_state(config, NeverQueried);
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
}

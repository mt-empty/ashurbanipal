use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Query, State};
use axum::http::{HeaderValue, StatusCode};
use axum::middleware::map_response;
use axum::response::{Html, IntoResponse, Json, Response};
use axum::routing::get;
use axum::Router;
use serde::{Deserialize, Serialize};

use crate::config::Config;
use crate::db::{DbError, DbSource, QueryOpts, TableInfo};
use crate::filter;

const DBVIEWER_HTML: &str = include_str!("../../../frontend/dbviewer.html");

const PROTOCOL_HEADER: &str = "x-ashurbanipal-protocol";
/// Bumped only for non-additive wire changes; additive optional fields
/// keep the same version.
const PROTOCOL_VERSION: &str = "1";

pub(crate) struct AppState<S> {
    pub config: Config,
    pub source: S,
    pub http: reqwest::Client,
}

/// If the kill switch is off for the current environment, every route
/// (including the HTML one) 404s — indistinguishable from the crate not
/// being mounted at all.
pub fn router<S: DbSource>(config: Config, source: S) -> Router {
    if !config.is_enabled() {
        return Router::new();
    }
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
        .expect("reqwest client construction only fails on TLS backend misconfiguration");
    let state = Arc::new(AppState {
        config,
        source,
        http,
    });
    // The version header goes on every API response (errors included) but
    // not the HTML route, hence the separate layered sub-router.
    let api = Router::new()
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

async fn stamp_protocol_version(mut response: Response) -> Response {
    response
        .headers_mut()
        .insert(PROTOCOL_HEADER, HeaderValue::from_static(PROTOCOL_VERSION));
    response
}

fn error_response(err: DbError) -> Response {
    match err {
        DbError::NotAllowed(what) => {
            (StatusCode::BAD_REQUEST, format!("not allowed: {what}")).into_response()
        }
        DbError::FilterParse(reason) => {
            (StatusCode::BAD_REQUEST, format!("invalid filter: {reason}")).into_response()
        }
        DbError::Sqlx(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("database error: {e}"),
        )
            .into_response(),
    }
}

async fn serve_html<S: DbSource>(State(_): State<Arc<AppState<S>>>) -> Html<&'static str> {
    Html(DBVIEWER_HTML)
}

#[derive(Serialize)]
struct TablesResponse {
    tables: Vec<TableInfo>,
}

async fn list_tables<S: DbSource>(State(state): State<Arc<AppState<S>>>) -> Response {
    match state.source.list_tables().await {
        Ok(tables) => Json(TablesResponse { tables }).into_response(),
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

async fn table_counts<S: DbSource>(State(state): State<Arc<AppState<S>>>) -> Response {
    match state.source.table_counts().await {
        Ok(counts) => Json(CountsResponse {
            counts: counts
                .into_iter()
                .map(|(table, approx_rows)| CountEntry { table, approx_rows })
                .collect(),
        })
        .into_response(),
        Err(e) => error_response(e),
    }
}

#[derive(Deserialize)]
struct DataParams {
    table: String,
    filter: Option<String>,
    limit: Option<u32>,
    offset: Option<u32>,
    sort: Option<String>,
    order: Option<String>,
}

async fn table_data<S: DbSource>(
    State(state): State<Arc<AppState<S>>>,
    Query(params): Query<DataParams>,
) -> Response {
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
            return (
                StatusCode::BAD_REQUEST,
                format!("invalid order {other:?} (expected \"asc\" or \"desc\")"),
            )
                .into_response()
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
    match state.source.query_table(&params.table, opts).await {
        Ok(data) => Json(data).into_response(),
        Err(e) => error_response(e),
    }
}

#[derive(Deserialize)]
struct CommonValuesParams {
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
) -> Response {
    match state
        .source
        .common_values(&params.table, &params.column)
        .await
    {
        Ok(values) => Json(CommonValuesResponse {
            values: values
                .into_iter()
                .map(|(value, freq)| CommonValueEntry { value, freq })
                .collect(),
        })
        .into_response(),
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
}

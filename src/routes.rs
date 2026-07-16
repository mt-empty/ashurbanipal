use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{Html, IntoResponse, Json, Response};
use axum::routing::get;
use axum::Router;
use serde::{Deserialize, Serialize};

use crate::config::Config;
use crate::db::{DbError, DbSource, QueryOpts};

const DBVIEWER_HTML: &str = include_str!("frontend/dbviewer.html");

pub(crate) struct AppState<S> {
    pub config: Config,
    pub source: S,
    pub http: reqwest::Client,
}

/// The crate's public entry point: a self-prefixed `Router` the host merges
/// into its own app. If the kill switch is off for the current environment,
/// every route (including the HTML one) 404s — indistinguishable from the
/// crate not being mounted at all.
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
    Router::new()
        .route("/__ashurbanipal", get(serve_html::<S>))
        .route("/__ashurbanipal/api/tables", get(list_tables::<S>))
        .route("/__ashurbanipal/api/table-counts", get(table_counts::<S>))
        .route("/__ashurbanipal/api/tables/data", get(table_data::<S>))
        .route("/__ashurbanipal/api/siblings", get(siblings::<S>))
        .with_state(state)
}

fn error_response(err: DbError) -> Response {
    match err {
        DbError::NotAllowed(what) => {
            (StatusCode::BAD_REQUEST, format!("not allowed: {what}")).into_response()
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
    tables: Vec<String>,
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
    // Filter DSL is deliberately last in the build order (`filter-dsl.md`):
    // until the parser lands, any non-empty filter is rejected outright —
    // never silently ignored.
    if params
        .filter
        .as_deref()
        .is_some_and(|f| !f.trim().is_empty())
    {
        return (
            StatusCode::BAD_REQUEST,
            "the `filter` parameter is not implemented yet",
        )
            .into_response();
    }

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
    };
    match state.source.query_table(&params.table, opts).await {
        Ok(data) => Json(data).into_response(),
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
    // Parallel checks, per request — no background polling or caching in v1
    // (`design.md` §4). One dead sibling must not delay the others: each
    // check has the client's own timeout and failures map to healthy=false.
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

/// `health_path` resolves against the sibling's origin, not the dbviewer
/// path (`design.md` §7).
fn health_url(dbviewer_url: &str, health_path: &str) -> Option<String> {
    let scheme_end = dbviewer_url.find("://")? + 3;
    let host_end = dbviewer_url[scheme_end..]
        .find('/')
        .map(|i| scheme_end + i)
        .unwrap_or(dbviewer_url.len());
    Some(format!("{}{}", &dbviewer_url[..host_end], health_path))
}

/// Minimal join_all so we don't pull in the `futures` crate for one call site.
async fn futures_join_all<F, T>(futures: impl IntoIterator<Item = F>) -> Vec<T>
where
    F: std::future::Future<Output = T> + Send + 'static,
    T: Send + 'static,
{
    let handles: Vec<_> = futures.into_iter().map(tokio::spawn).collect();
    let mut results = Vec::with_capacity(handles.len());
    for handle in handles {
        // Health-check futures don't panic; if one somehow does, surfacing it
        // is better than fabricating a status.
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

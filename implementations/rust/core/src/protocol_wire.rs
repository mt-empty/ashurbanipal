//! The request and response shapes of `spec/protocol.md` §5's routes, shared by
//! every framework adapter so the wire format can't drift between them.
//! Adapters keep only the framework glue: routing, extractors, and turning a
//! value or a `DbError` into an HTTP response.

use serde::{Deserialize, Serialize};

use crate::config::Limits;
use crate::db::{default_source, DbError, QueryOpts, ReferencedBy, SchemaListing, TableInfo};
use crate::filter;
use crate::join::{JoinOpts, JoinSpec};

#[derive(Debug, Serialize)]
pub struct SourceEntry {
    pub name: String,
}

/// `GET /api/sources` (§5.8).
#[derive(Debug, Serialize)]
pub struct SourcesResponse {
    pub sources: Vec<SourceEntry>,
    pub default: String,
}

impl SourcesResponse {
    /// `sources` must be non-empty, as every adapter's constructor asserts.
    pub fn from_sources<S>(sources: &[(String, S)]) -> Self {
        Self {
            sources: sources
                .iter()
                .map(|(name, _)| SourceEntry { name: name.clone() })
                .collect(),
            default: default_source(sources).0.clone(),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct SchemaEntry {
    pub name: String,
}

/// `GET /api/schemas` (§5.7). `default` serializes as `null` when absent: the
/// field is always present.
#[derive(Debug, Serialize)]
pub struct SchemasResponse {
    pub schemas: Vec<SchemaEntry>,
    pub default: Option<String>,
}

impl From<SchemaListing> for SchemasResponse {
    fn from(listing: SchemaListing) -> Self {
        Self {
            schemas: listing
                .schemas
                .into_iter()
                .map(|name| SchemaEntry { name })
                .collect(),
            default: listing.default,
        }
    }
}

/// `GET /api/tables` (§5.2).
#[derive(Debug, Serialize)]
pub struct TablesResponse {
    pub tables: Vec<TableInfo>,
}

#[derive(Debug, Serialize)]
pub struct CountEntry {
    pub table: String,
    pub approx_rows: i64,
}

/// `GET /api/table-counts` (§5.3).
#[derive(Debug, Serialize)]
pub struct CountsResponse {
    pub counts: Vec<CountEntry>,
}

impl From<Vec<(String, i64)>> for CountsResponse {
    fn from(counts: Vec<(String, i64)>) -> Self {
        Self {
            counts: counts
                .into_iter()
                .map(|(table, approx_rows)| CountEntry { table, approx_rows })
                .collect(),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct CommonValueEntry {
    pub value: String,
    pub freq: f32,
}

/// `GET /api/tables/common-values` (§5.5).
#[derive(Debug, Serialize)]
pub struct CommonValuesResponse {
    pub values: Vec<CommonValueEntry>,
}

impl From<Vec<(String, f32)>> for CommonValuesResponse {
    fn from(values: Vec<(String, f32)>) -> Self {
        Self {
            values: values
                .into_iter()
                .map(|(value, freq)| CommonValueEntry { value, freq })
                .collect(),
        }
    }
}

/// `GET /api/tables/referenced-by` (§5.9).
#[derive(Debug, Serialize)]
pub struct ReferencedByResponse {
    pub referenced_by: Vec<ReferencedBy>,
}

#[derive(Debug, Deserialize)]
pub struct SourceParams {
    pub source: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SchemaParams {
    pub schema: Option<String>,
    pub source: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct TableParams {
    pub schema: Option<String>,
    pub source: Option<String>,
    pub table: String,
}

#[derive(Debug, Deserialize)]
pub struct CommonValuesParams {
    pub schema: Option<String>,
    pub source: Option<String>,
    pub table: String,
    pub column: String,
}

#[derive(Debug, Deserialize)]
pub struct DataParams {
    pub schema: Option<String>,
    pub source: Option<String>,
    pub table: String,
    pub filter: Option<String>,
    #[serde(default, deserialize_with = "deserialize_saturating_u32")]
    pub limit: Option<u32>,
    #[serde(default, deserialize_with = "deserialize_saturating_u32")]
    pub offset: Option<u32>,
    pub sort: Option<String>,
    pub order: Option<String>,
}

impl DataParams {
    /// Validates the paging, sort order and filter of `GET /api/tables/data`
    /// (§5.4) into the options its query runs with.
    pub fn query_opts(&self, limits: &Limits) -> Result<QueryOpts, DbError> {
        let filter = parse_filter(self.filter.as_deref(), filter::parse)?;
        Ok(QueryOpts {
            limit: clamp_limit(self.limit, limits),
            offset: self.offset.unwrap_or(0),
            sort: self.sort.clone(),
            descending: is_descending(self.order.as_deref())?,
            timeout_secs: limits.query_timeout_secs,
            filter,
        })
    }
}

#[derive(Debug, Deserialize)]
pub struct JoinParams {
    pub schema: Option<String>,
    pub source: Option<String>,
    pub join: String,
    pub filter: Option<String>,
    #[serde(default, deserialize_with = "deserialize_saturating_u32")]
    pub limit: Option<u32>,
    #[serde(default, deserialize_with = "deserialize_saturating_u32")]
    pub offset: Option<u32>,
    pub sort: Option<String>,
    pub sort_join: Option<String>,
    pub order: Option<String>,
}

impl JoinParams {
    /// Parses the `join` value and validates the rest of `GET /api/tables/join`
    /// (§5.11) into the join and the options it runs with.
    pub fn join_request(&self, limits: &Limits) -> Result<(JoinSpec, JoinOpts), DbError> {
        let spec = JoinSpec::parse(&self.join).map_err(|e| DbError::BadJoin(e.0))?;
        let filter = parse_filter(self.filter.as_deref(), filter::parse_for_join)?;
        let descending = is_descending(self.order.as_deref())?;
        let sort_join = match self.sort_join.as_deref() {
            None => None,
            Some(raw) => Some(raw.parse::<usize>().map_err(|_| {
                DbError::BadParameter(format!(
                    "invalid sort_join {raw:?} (expected a table position)"
                ))
            })?),
        };
        let opts = JoinOpts {
            limit: clamp_limit(self.limit, limits),
            offset: self.offset.unwrap_or(0),
            sort: self.sort.clone(),
            sort_join,
            descending,
            timeout_secs: limits.query_timeout_secs,
            filter,
        };
        Ok((spec, opts))
    }
}

fn clamp_limit(limit: Option<u32>, limits: &Limits) -> u32 {
    limit
        .unwrap_or(limits.default_page_size)
        .clamp(1, limits.max_page_size)
}

fn is_descending(order: Option<&str>) -> Result<bool, DbError> {
    match order {
        None | Some("asc") => Ok(false),
        Some("desc") => Ok(true),
        Some(other) => Err(DbError::BadParameter(format!(
            "invalid order {other:?} (expected \"asc\" or \"desc\")"
        ))),
    }
}

/// An empty (or whitespace-only) `filter` param, or a valid-but-empty JSON
/// array, means "no filter" (§5.4.2).
fn parse_filter<C, E: std::fmt::Display>(
    raw: Option<&str>,
    parse: impl FnOnce(&str) -> Result<Vec<C>, E>,
) -> Result<Option<Vec<C>>, DbError> {
    match raw {
        Some(raw) if !raw.trim().is_empty() => match parse(raw) {
            Ok(conditions) if conditions.is_empty() => Ok(None),
            Ok(conditions) => Ok(Some(conditions)),
            Err(e) => Err(DbError::FilterParse(e.to_string())),
        },
        _ => Ok(None),
    }
}

/// §5.4 requires `limit`/`offset` to be clamped, never rejected, for
/// out-of-range values — saturating via `i128` (not `u32`) keeps the query
/// extractor from 400ing before the real clamp/`OFFSET` handling runs;
/// non-numeric input still 400s. See
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn data_params(query: serde_json::Value) -> DataParams {
        serde_json::from_value(query).unwrap()
    }

    #[test]
    fn out_of_range_limit_and_offset_saturate_instead_of_failing() {
        let p = data_params(json!({"table": "t", "limit": "-5", "offset": "99999999999"}));
        assert_eq!(p.limit, Some(0));
        assert_eq!(p.offset, Some(u32::MAX));
        assert!(
            serde_json::from_value::<DataParams>(json!({"table": "t", "limit": "ten"})).is_err()
        );
    }

    #[test]
    fn query_opts_clamps_the_limit_and_treats_a_blank_or_empty_filter_as_none() {
        let limits = Limits::default();
        let opts = data_params(json!({"table": "t", "limit": "0", "filter": " "}))
            .query_opts(&limits)
            .unwrap();
        assert_eq!(opts.limit, 1);
        assert!(opts.filter.is_none());
        let opts = data_params(json!({"table": "t", "filter": "[]"}))
            .query_opts(&limits)
            .unwrap();
        assert!(opts.filter.is_none(), "an empty JSON array is no filter");
    }

    #[test]
    fn a_bad_order_or_sort_join_is_a_bad_parameter() {
        let limits = Limits::default();
        assert!(matches!(
            data_params(json!({"table": "t", "order": "up"})).query_opts(&limits),
            Err(DbError::BadParameter(_))
        ));
        let join: JoinParams = serde_json::from_value(json!({
            "join": r#"{"table":"a","joins":[{"type":"left","table":"b","on":[{"left":{"join":0,"column":"id"},"right":"a_id"}]}]}"#,
            "sort_join": "first",
        }))
        .unwrap();
        assert!(matches!(
            join.join_request(&limits),
            Err(DbError::BadParameter(_))
        ));
    }
}

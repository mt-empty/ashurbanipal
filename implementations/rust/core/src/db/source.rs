use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use super::{
    DbError, DbSource, Engine, QueryOpts, ReferencedBy, SchemaListing, Structure, TableData,
    TableInfo,
};
use crate::join::{JoinData, JoinOpts, JoinSpec};

type BoxFut<'a, T> = Pin<Box<dyn Future<Output = Result<T, DbError>> + Send + 'a>>;

/// `DbSource` with boxed futures, so it can sit behind `dyn`.
trait ErasedSource: Send + Sync + 'static {
    fn engine(&self) -> Engine;
    fn list_schemas(&self) -> BoxFut<'_, SchemaListing>;
    fn list_tables<'a>(&'a self, schema: Option<&'a str>) -> BoxFut<'a, Vec<TableInfo>>;
    fn table_counts<'a>(&'a self, schema: Option<&'a str>) -> BoxFut<'a, Vec<(String, i64)>>;
    fn query_table<'a>(
        &'a self,
        schema: Option<&'a str>,
        table: &'a str,
        opts: QueryOpts,
    ) -> BoxFut<'a, TableData>;
    fn common_values<'a>(
        &'a self,
        schema: Option<&'a str>,
        table: &'a str,
        column: &'a str,
    ) -> BoxFut<'a, Vec<(String, f32)>>;
    fn referenced_by<'a>(
        &'a self,
        schema: Option<&'a str>,
        table: &'a str,
    ) -> BoxFut<'a, Vec<ReferencedBy>>;
    fn query_join<'a>(
        &'a self,
        schema: Option<&'a str>,
        spec: &'a JoinSpec,
        opts: JoinOpts,
    ) -> BoxFut<'a, JoinData>;
    fn structure<'a>(&'a self, schema: Option<&'a str>, table: &'a str) -> BoxFut<'a, Structure>;
}

impl<T: DbSource> ErasedSource for T {
    fn engine(&self) -> Engine {
        DbSource::engine(self)
    }
    fn list_schemas(&self) -> BoxFut<'_, SchemaListing> {
        Box::pin(DbSource::list_schemas(self))
    }
    fn list_tables<'a>(&'a self, schema: Option<&'a str>) -> BoxFut<'a, Vec<TableInfo>> {
        Box::pin(DbSource::list_tables(self, schema))
    }
    fn table_counts<'a>(&'a self, schema: Option<&'a str>) -> BoxFut<'a, Vec<(String, i64)>> {
        Box::pin(DbSource::table_counts(self, schema))
    }
    fn query_table<'a>(
        &'a self,
        schema: Option<&'a str>,
        table: &'a str,
        opts: QueryOpts,
    ) -> BoxFut<'a, TableData> {
        Box::pin(DbSource::query_table(self, schema, table, opts))
    }
    fn common_values<'a>(
        &'a self,
        schema: Option<&'a str>,
        table: &'a str,
        column: &'a str,
    ) -> BoxFut<'a, Vec<(String, f32)>> {
        Box::pin(DbSource::common_values(self, schema, table, column))
    }
    fn referenced_by<'a>(
        &'a self,
        schema: Option<&'a str>,
        table: &'a str,
    ) -> BoxFut<'a, Vec<ReferencedBy>> {
        Box::pin(DbSource::referenced_by(self, schema, table))
    }
    fn query_join<'a>(
        &'a self,
        schema: Option<&'a str>,
        spec: &'a JoinSpec,
        opts: JoinOpts,
    ) -> BoxFut<'a, JoinData> {
        Box::pin(DbSource::query_join(self, schema, spec, opts))
    }
    fn structure<'a>(&'a self, schema: Option<&'a str>, table: &'a str) -> BoxFut<'a, Structure> {
        Box::pin(DbSource::structure(self, schema, table))
    }
}

/// Any [`DbSource`] behind one type, so a single router can hold sources of
/// different backends. See `docs/design.md` §5.
#[derive(Clone)]
pub struct Source(Arc<dyn ErasedSource>);

impl Source {
    pub fn new<S: DbSource>(source: S) -> Self {
        Source(Arc::new(source))
    }
}

impl DbSource for Source {
    fn engine(&self) -> Engine {
        self.0.engine()
    }
    async fn list_schemas(&self) -> Result<SchemaListing, DbError> {
        self.0.list_schemas().await
    }
    async fn list_tables(&self, schema: Option<&str>) -> Result<Vec<TableInfo>, DbError> {
        self.0.list_tables(schema).await
    }
    async fn table_counts(&self, schema: Option<&str>) -> Result<Vec<(String, i64)>, DbError> {
        self.0.table_counts(schema).await
    }
    async fn query_table(
        &self,
        schema: Option<&str>,
        table: &str,
        opts: QueryOpts,
    ) -> Result<TableData, DbError> {
        self.0.query_table(schema, table, opts).await
    }
    async fn common_values(
        &self,
        schema: Option<&str>,
        table: &str,
        column: &str,
    ) -> Result<Vec<(String, f32)>, DbError> {
        self.0.common_values(schema, table, column).await
    }
    async fn referenced_by(
        &self,
        schema: Option<&str>,
        table: &str,
    ) -> Result<Vec<ReferencedBy>, DbError> {
        self.0.referenced_by(schema, table).await
    }
    async fn query_join(
        &self,
        schema: Option<&str>,
        spec: &JoinSpec,
        opts: JoinOpts,
    ) -> Result<JoinData, DbError> {
        self.0.query_join(schema, spec, opts).await
    }
    async fn structure(&self, schema: Option<&str>, table: &str) -> Result<Structure, DbError> {
        self.0.structure(schema, table).await
    }
}

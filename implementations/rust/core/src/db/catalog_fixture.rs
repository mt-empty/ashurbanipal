//! Engine-native catalogs from `spec/fixtures/catalogs.json` (schema:
//! `spec/fixtures/README.md`), shared by the join and filter fixture runners.

use std::collections::HashMap;

use serde_json::Value;

use super::Ident;
use crate::join::{self, ColMeta, Dialect, TableMeta, UniqueKey};

const CATALOGS: &str = include_str!("../../../../../spec/fixtures/catalogs.json");

/// One engine's half of the fixture: its catalog key, dialect, and how a
/// catalog column row becomes a [`ColMeta`], as that backend builds it.
pub(crate) struct Engine {
    pub name: &'static str,
    pub dialect: &'static Dialect,
    /// SQLite has no schema above the database, so none is spliced.
    pub splices_schema: bool,
    pub column: fn(&Value) -> ColMeta,
}

/// This engine's catalog: `schemas`, `default_schema` and `tables`.
pub(crate) fn catalog(engine: &Engine) -> Value {
    let mut file: Value = serde_json::from_str(CATALOGS).unwrap();
    file["catalogs"][engine.name].take()
}

/// Every catalog table as the backend's lookup would build it, keyed `schema.table`.
pub(crate) fn tables(engine: &Engine, catalog: &Value) -> HashMap<String, TableMeta> {
    let tables = catalog["tables"].as_object().expect("catalog tables");
    tables
        .iter()
        .map(|(key, t)| {
            let (schema, name) = key.split_once('.').expect("tables are keyed schema.table");
            let columns: Vec<ColMeta> = t["columns"]
                .as_array()
                .expect("columns")
                .iter()
                .map(engine.column)
                .collect();
            let keys: Vec<UniqueKey> = t["unique_keys"]
                .as_array()
                .expect("unique_keys")
                .iter()
                .map(|k| UniqueKey {
                    name: k["name"].as_str().unwrap().to_string(),
                    primary: k["primary"].as_bool().unwrap(),
                    columns: k["columns"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|c| c.as_str().unwrap().to_string())
                        .collect(),
                })
                .collect();
            let meta = TableMeta {
                schema: engine.splices_schema.then(|| Ident::for_test(schema)),
                name: Ident::for_test(name),
                order_keys: join::tie_break_keys(&columns, &keys),
                columns,
            };
            (key.clone(), meta)
        })
        .collect()
}

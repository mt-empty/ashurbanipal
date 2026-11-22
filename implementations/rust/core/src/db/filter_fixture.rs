//! Runner over `spec/fixtures/filter-builder-tests.json` (schema:
//! `spec/fixtures/README.md`), shared by each backend's test module.

use serde_json::Value;

use super::catalog_fixture::{self, Engine};
use super::{DbError, NotAllowedDetail};
use crate::filter;
use crate::join;

const FIXTURES: &str = include_str!("../../../../../spec/fixtures/filter-builder-tests.json");

/// `(where clause, values)`, or the rejection's kind. Structural kinds all
/// fail the parse before any schema access, so they compare as one.
type Outcome = Result<(String, Vec<String>), String>;

const STRUCTURAL: &str = "structural";

fn kind(kind: &str) -> String {
    match kind {
        "unknown_column" | "invalid_value" => kind.to_string(),
        // Both are the builder's own 400 invalid_filter.
        "path_not_json" => "invalid_value".to_string(),
        _ => STRUCTURAL.to_string(),
    }
}

fn run_case(engine: &Engine, table: &join::TableMeta, case: &Value) -> Outcome {
    let raw = match (case.get("raw"), case.get("conditions")) {
        (Some(raw), None) => raw.as_str().unwrap().to_string(),
        (None, Some(conditions)) => conditions.to_string(),
        _ => panic!(
            "case {}: needs exactly one of raw and conditions",
            case["name"]
        ),
    };
    let conditions = filter::parse(&raw).map_err(|_| STRUCTURAL.to_string())?;
    match join::table_where_clause(&conditions, table, engine.dialect) {
        Ok(built) => Ok(built),
        Err(DbError::NotAllowed(NotAllowedDetail { kind, .. })) => Err(kind.code().to_string()),
        Err(DbError::FilterParse(_)) => Err("invalid_value".to_string()),
        Err(other) => panic!("case {}: unexpected error {other:?}", case["name"]),
    }
}

fn expected(case: &Value, engine: &str) -> Option<Outcome> {
    let e = match (case.get("expect_error"), case.get("expect")) {
        (Some(k), None) => return Some(Err(kind(k.as_str().unwrap()))),
        (None, Some(expect)) => expect.get(engine)?,
        _ => panic!(
            "case {}: needs exactly one of expect and expect_error",
            case["name"]
        ),
    };
    if let Some(k) = e.get("error") {
        return Some(Err(kind(k.as_str().unwrap())));
    }
    let values = e["values"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s.as_str().unwrap().to_string())
        .collect();
    let clause = match e["where"].as_str().unwrap() {
        "" => String::new(),
        fragment => format!(" where {fragment}"),
    };
    Some(Ok((clause, values)))
}

pub(crate) fn run(engine: &Engine) {
    let file: Value = serde_json::from_str(FIXTURES).unwrap();
    let catalog = catalog_fixture::catalog(engine);
    let tables = catalog_fixture::tables(engine, &catalog);
    let schema = catalog["default_schema"].as_str().unwrap();
    let cases = file["cases"].as_array().unwrap();
    let mut failures = Vec::new();
    let mut ran = 0;
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let Some(want) = expected(case, engine.name) else {
            continue;
        };
        let key = format!("{schema}.{}", case["table"].as_str().unwrap());
        let table = tables
            .get(&key)
            .unwrap_or_else(|| panic!("case {name}: no {key} in the {} catalog", engine.name));
        let actual = run_case(engine, table, case);
        ran += 1;
        if actual != want {
            failures.push(format!("case {name}:\n  want {want:?}\n  got  {actual:?}"));
        }
    }
    assert!(ran > 0, "no cases ran for {}", engine.name);
    assert!(
        failures.is_empty(),
        "{} of {ran} {} filter fixture cases failed:\n{}",
        failures.len(),
        engine.name,
        failures.join("\n")
    );
}

//! Runner over `spec/fixtures/join-builder-tests.json` (schema:
//! `spec/fixtures/README.md`), shared by each backend's test module.

use std::collections::HashMap;

use serde_json::Value;

use super::catalog_fixture::{self, Engine};
use super::DbError;
use crate::config::Limits;
use crate::join::{self, TableMeta};
use crate::protocol_wire::JoinParams;

const FIXTURES: &str = include_str!("../../../../../spec/fixtures/join-builder-tests.json");

/// `(sql, values, labels)`, or the `spec/protocol.md` §2 code of the rejection.
type Outcome = Result<(String, Vec<String>, Vec<String>), String>;

fn code(e: &DbError) -> String {
    e.problem().1.to_string()
}

fn run_case(
    engine: &Engine,
    catalog: &Value,
    tables: &HashMap<String, TableMeta>,
    case: &Value,
) -> Outcome {
    let join = match (case.get("join_raw"), case.get("join")) {
        (Some(raw), _) => raw.as_str().unwrap().to_string(),
        (None, Some(j)) => j.to_string(),
        (None, None) => panic!("case {}: neither join nor join_raw", case["name"]),
    };
    let params = JoinParams {
        schema: None,
        source: None,
        join,
        filter: case.get("filter").map(Value::to_string),
        limit: None,
        offset: None,
        sort: case.get("sort").map(|s| s.as_str().unwrap().to_string()),
        sort_join: case.get("sort_join").map(Value::to_string),
        order: case.get("order").map(|o| o.as_str().unwrap().to_string()),
    };
    let (spec, opts) = params
        .join_request(&Limits::default())
        .map_err(|e| code(&e))?;
    let listed: Vec<String> = catalog["schemas"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s.as_str().unwrap().to_string())
        .collect();
    let request = case
        .get("schema")
        .or(catalog.get("default_schema"))
        .and_then(Value::as_str)
        .unwrap()
        .to_string();
    assert!(
        listed.contains(&request),
        "case {}: request schema {request:?} is not in the {} catalog",
        case["name"],
        engine.name
    );
    let refs = spec.table_refs();
    let schemas = join::table_schemas(&refs, &request, &listed).map_err(|e| code(&e))?;
    let metas = schemas
        .iter()
        .zip(&refs)
        .map(|(schema, &(_, name))| {
            tables
                .get(&format!("{schema}.{name}"))
                .cloned()
                .ok_or_else(|| "invalid_join".to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    let plan = join::plan(&spec, metas, &opts).map_err(|e| code(&e))?;
    let (sql, values) = join::build_select(&plan, engine.dialect);
    Ok((sql, values, plan.labels().to_vec()))
}

fn expected(case: &Value, engine: &str) -> Option<Outcome> {
    if let Some(code) = case.get("expect_error") {
        return Some(Err(code.as_str().unwrap().to_string()));
    }
    let e = case["expect"].get(engine)?;
    if let Some(code) = e.get("error") {
        return Some(Err(code.as_str().unwrap().to_string()));
    }
    let strings = |v: &Value| -> Vec<String> {
        v.as_array()
            .unwrap()
            .iter()
            .map(|s| s.as_str().unwrap().to_string())
            .collect()
    };
    Some(Ok((
        e["sql"].as_str().unwrap().to_string(),
        strings(&e["values"]),
        strings(&e["labels"]),
    )))
}

pub(crate) fn run(engine: &Engine) {
    let file: Value = serde_json::from_str(FIXTURES).unwrap();
    let catalog = &catalog_fixture::catalog(engine);
    let tables = catalog_fixture::tables(engine, catalog);
    let cases = file["cases"].as_array().unwrap();
    assert!(!cases.is_empty());
    let mut failures = Vec::new();
    let mut ran = 0;
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let applies =
            case.get("expect_error").is_some() || case["expect"].get(engine.name).is_some();
        if !applies {
            continue;
        }
        let actual = run_case(engine, catalog, &tables, case);
        ran += 1;
        let want = expected(case, engine.name).unwrap();
        if actual != want {
            failures.push(format!("case {name}:\n  want {want:?}\n  got  {actual:?}"));
        }
    }
    assert!(ran > 0, "no cases ran for {}", engine.name);
    assert!(
        failures.is_empty(),
        "{} of {ran} {} join fixture cases failed:\n{}",
        failures.len(),
        engine.name,
        failures.join("\n")
    );
}

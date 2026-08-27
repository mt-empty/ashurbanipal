//! Ashurbanipal conformance kit — behavior conformance (`docs/design.md`
//! §4.2 layer 3): golden fixtures replayed over seeded, known data. See
//! `conformance/runner/COVERAGE.md` for the requirement-ID → test mapping,
//! and `common.rs`'s module docs for the spawned-vs-external target
//! selection.

mod assert;
mod common;
mod common_values;
mod filter_dsl;
mod html_and_siblings;
mod protocol;
mod schemas;
mod sources;
mod table_data;
mod tables;
mod two_source;

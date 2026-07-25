rootProject.name = "ashurbanipal-spring-boot-starter"

// A minimal, real Spring Boot app that depends on this starter, purely to
// prove "merge the starter into a host app and boot it" end-to-end and to
// give the conformance kit (conformance/runner, schema-check.sh) a live
// HTTP target — the same role implementations/rust/examples/demo.rs plays
// for the Rust reference. Never published; not part of the starter's own
// artifact.
include("demo")

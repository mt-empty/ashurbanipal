plugins {
    id("com.gradleup.nmcp.settings") version "1.6.1"
}

rootProject.name = "ashurbanipal-spring-boot-starter"

// A minimal, real Spring Boot app that depends on this starter, purely to
// prove "merge the starter into a host app and boot it" end-to-end and to
// give the conformance kit (conformance/runner, schema-check.sh) a live
// HTTP target — the same role implementations/rust/axum/examples/demo.rs
// plays for the Rust reference. Never published; not part of the
// starter's own artifact.
include("demo")

// Publishes implementations/spring-boot-starter's "maven" publication
// (build.gradle.kts) to Maven Central via the Central Portal publisher
// API — the legacy OSSRH staging endpoint is retired. `demo` has no
// maven-publish publications, so nmcp's lenient aggregation ignores it.
// Credentials only need to resolve when a publish task actually runs
// (spring-boot-starter-publish.yml); ./gradlew build/test never touches
// this extension.
nmcpSettings {
    centralPortal {
        username = providers.environmentVariable("MAVEN_CENTRAL_USERNAME")
        password = providers.environmentVariable("MAVEN_CENTRAL_PASSWORD")
        // AUTOMATIC: Central validates and releases without a second manual
        // step on the portal UI — the one human checkpoint is the GitHub
        // Environment approval gate in spring-boot-starter-publish.yml,
        // mirroring the crates.io publish jobs' single-approval pattern
        // rather than stacking two manual gates.
        publishingType = "AUTOMATIC"
    }
}

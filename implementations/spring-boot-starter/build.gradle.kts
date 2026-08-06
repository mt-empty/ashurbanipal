import java.security.MessageDigest

plugins {
    kotlin("jvm") version "2.2.20"
    kotlin("plugin.spring") version "2.2.20"
    `maven-publish`
}

group = "io.github.mtempty"
version = "0.1.0-SNAPSHOT"

// Toolchain pinned to whatever JDK is actually installed in this devcontainer
// (JDK 21 via mise — no JDK 17 available to auto-detect or download here).
// The starter's own source targets the JDK 17+ baseline implementation.md
// §5.1 asks for; nothing here uses a 21-only language feature.
java {
    toolchain {
        languageVersion.set(JavaLanguageVersion.of(21))
    }
}

kotlin {
    jvmToolchain(21)
}

repositories {
    mavenCentral()
}

dependencies {
    val springBootBom = platform("org.springframework.boot:spring-boot-dependencies:4.0.7")
    implementation(springBootBom)
    compileOnly(springBootBom)

    // Starter-lean per implementation.md §5.1: only what every Spring Boot
    // host already has on its classpath. No JDBC driver, no HTTP client
    // dependency (siblings health checks use java.net.http). spring-webmvc
    // is compileOnly: we need its annotation/response types (@RestController,
    // ResponseEntity, ...) to compile against, but the actual jar always
    // comes from the host's own spring-boot-starter-web at runtime — adding
    // it as `implementation` would make this "starter-lean" module drag in
    // the full servlet stack for hosts that provide their own.
    implementation("org.springframework.boot:spring-boot-autoconfigure")
    implementation("org.springframework:spring-jdbc")
    implementation("tools.jackson.module:jackson-module-kotlin")
    implementation("org.jetbrains.kotlin:kotlin-reflect")
    compileOnly("org.springframework:spring-webmvc")
    compileOnly("jakarta.servlet:jakarta.servlet-api")

    // Test-only: a host app's web stack, JDBC driver, and JSON-Kotlin glue
    // to actually boot the starter against a live database.
    testImplementation("org.springframework.boot:spring-boot-starter-web")
    testImplementation("org.springframework.boot:spring-boot-starter-jdbc")
    testImplementation("org.springframework.boot:spring-boot-starter-test") {
        exclude(group = "org.junit.vintage", module = "junit-vintage-engine")
    }
    testImplementation("org.postgresql:postgresql")
    // Gradle's own test worker bundles an older junit-platform-launcher than
    // Spring Boot's BOM-managed junit-jupiter needs; without this explicit
    // version-aligned one, test discovery fails with an
    // "OutputDirectoryProvider not available" platform-version mismatch.
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

tasks.withType<Test> {
    useJUnitPlatform()
    // Integration/kill-switch tests hit the devcontainer's live Postgres
    // (no Testcontainers/Docker available here, see PORTING.md and the
    // Phase 5 brief) — DATABASE_URL is set by the devcontainer.
    environment("DATABASE_URL", System.getenv("DATABASE_URL") ?: "")
    // Fixture and seed files live at the repo root, shared with every other
    // implementation's test suite (implementation.md §5.3) rather than
    // duplicated into src/test/resources.
    systemProperty("ashurbanipal.repoRoot", rootDir.parentFile.parentFile.absolutePath)
}

// ---- Frontend vendoring (implementation.md §5.5 item 3 / PORTING.md) ----
//
// dbviewer.html is copied into generated (not checked-in) resources at
// every build, and its hash re-verified against the pinned value every
// time — a Gradle resource-processing step that silently mangled the file
// would otherwise go unnoticed until someone diffed bytes by hand. In a
// real release this hash would pin a tagged frontend/dbviewer.html release
// artifact (PORTING.md's vendoring contract); here it pins this repo's own
// copy since there is no separate tagged release to vendor from.
val repoRoot = rootDir.parentFile.parentFile
val frontendSource = repoRoot.resolve("frontend/dbviewer.html")
val pinnedFrontendSha256 = "aaaf4e3dcf9b73c97408e918f8ba4105445d36a96b3055d678792941ed5fe83d"

val vendorFrontend = tasks.register("vendorFrontend") {
    description = "Copies frontend/dbviewer.html into generated resources, re-verifying its sha256."
    // Resource root added to the main source set below is
    // "generated-resources" (no "/ashurbanipal" suffix) — the classpath
    // resource path is "ashurbanipal/dbviewer.html", matching
    // ClassPathResource("ashurbanipal/dbviewer.html") in DbViewerController.
    val outputDir = layout.buildDirectory.dir("generated-resources")
    inputs.file(frontendSource)
    outputs.dir(outputDir)
    doLast {
        val bytes = frontendSource.readBytes()
        val actual = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        if (actual != pinnedFrontendSha256) {
            throw GradleException(
                "frontend/dbviewer.html sha256 mismatch: expected $pinnedFrontendSha256, got $actual " +
                    "(the vendored frontend changed upstream — re-pin deliberately, don't silently accept a mangled copy)"
            )
        }
        val destDir = outputDir.get().asFile.resolve("ashurbanipal")
        destDir.mkdirs()
        frontendSource.copyTo(destDir.resolve("dbviewer.html"), overwrite = true)
    }
}

sourceSets {
    main {
        resources {
            srcDir(layout.buildDirectory.dir("generated-resources"))
        }
    }
}

tasks.named("processResources") {
    dependsOn(vendorFrontend)
}

publishing {
    publications {
        create<MavenPublication>("maven") {
            from(components["java"])
            artifactId = "ashurbanipal-spring-boot-starter"
        }
    }
    // Inert on purpose (implementation.md §5.4 / the brief's "no real
    // publishing" instruction): shape only, no credentials wired, never
    // executed by CI in this repo.
    repositories {
        maven {
            name = "placeholder"
            url = uri(layout.buildDirectory.dir("repo"))
        }
    }
}

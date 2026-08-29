import java.security.MessageDigest

plugins {
    kotlin("jvm") version "2.4.10"
    kotlin("plugin.spring") version "2.4.10"
    `maven-publish`
    signing
}

group = "io.github.mt-empty"
version = "0.3.0"

// Toolchain pinned to whatever JDK is actually installed in this devcontainer
// (JDK 21 via mise — no JDK 17 available to auto-detect or download here).
// The starter's own source targets a JDK 17+ baseline for broadest reach
// as an embedded library; nothing here uses a 21-only language feature.
java {
    toolchain {
        languageVersion.set(JavaLanguageVersion.of(21))
    }
    // Central requires a -sources.jar and -javadoc.jar alongside the main
    // jar for every published artifact (placeholder content is fine —
    // there's no Kotlin source in the standard `javadoc` task's input, so
    // this produces an empty-but-present javadoc jar rather than a real one).
    withSourcesJar()
    withJavadocJar()
}

kotlin {
    jvmToolchain(21)
}

repositories {
    mavenCentral()
}

dependencyLocking {
    lockAllConfigurations()
}

dependencies {
    val springBootBom = platform("org.springframework.boot:spring-boot-dependencies:4.1.0")
    implementation(springBootBom)
    compileOnly(springBootBom)

    // Starter-lean: only what every Spring Boot host already has on its
    // classpath. No JDBC driver, no HTTP client
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
    // SqliteSource needs Xerial's own org.sqlite.ProgressHandler class at
    // compile time — the real sqlite3_progress_handler binding, since plain
    // JDBC Statement.setQueryTimeout only maps to SQLiteConnection's *busy*
    // timeout on this driver (file-lock waits, not query execution — see
    // docs/adapter-decisions.md §6). compileOnly for the same reason as
    // spring-webmvc above: a host opting into ashurbanipal.backend=sqlite
    // already needs this driver on its own runtime classpath to build a
    // working SQLite DataSource in the first place.
    compileOnly("org.xerial:sqlite-jdbc:3.53.2.1")

    // Test-only: a host app's web stack, JDBC driver, and JSON-Kotlin glue
    // to actually boot the starter against a live database.
    testImplementation("org.springframework.boot:spring-boot-starter-web")
    testImplementation("org.springframework.boot:spring-boot-starter-jdbc")
    testImplementation("org.springframework.boot:spring-boot-starter-test") {
        exclude(group = "org.junit.vintage", module = "junit-vintage-engine")
    }
    testImplementation("org.postgresql:postgresql")
    // Test-only JDBC drivers for the opt-in MySqlSource/SqliteSource backends
    // — like the Postgres driver above, these are the host's responsibility
    // to provide at runtime (via their own DataSource bean), never a main
    // dependency of this starter (mirrors the Rust crate's mysql/sqlite
    // Cargo features being opt-in, not always-linked).
    testImplementation("com.mysql:mysql-connector-j:26.7.0")
    testImplementation("org.xerial:sqlite-jdbc:3.53.2.1")
    // Gradle's own test worker bundles an older junit-platform-launcher than
    // Spring Boot's BOM-managed junit-jupiter needs; without this explicit
    // version-aligned one, test discovery fails with an
    // "OutputDirectoryProvider not available" platform-version mismatch.
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

tasks.withType<Test> {
    useJUnitPlatform()
    // Integration/kill-switch tests hit the devcontainer's live Postgres
    // (no Testcontainers/Docker available here, see PORTING.md) —
    // DATABASE_URL is set by the devcontainer.
    environment("DATABASE_URL", System.getenv("DATABASE_URL") ?: "")
    // MySqlSourceTest skips cleanly (JUnit5 Assumptions) when neither is set.
    environment("MYSQL_TEST_URL", System.getenv("MYSQL_TEST_URL") ?: "")
    environment("MARIADB_TEST_URL", System.getenv("MARIADB_TEST_URL") ?: "")
    // Fixture and seed files live at the repo root, shared with every other
    // implementation's test suite rather than duplicated into
    // src/test/resources.
    systemProperty("ashurbanipal.repoRoot", rootDir.parentFile.parentFile.absolutePath)
}

// ---- Frontend vendoring (PORTING.md hardening item 3) ----
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
val pinnedFrontendSha256 = "8546113f378eb0892308913c8e4b2a0fa32e91d13988d20b550150d910e12649"

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

// sourcesJar also packages main.resources' srcDirs (including
// generated-resources), so it needs the same dependency processResources
// already declares — withSourcesJar() surfaced this as a missing-task-input
// validation failure that predates it going unnoticed.
tasks.named("sourcesJar") {
    dependsOn(vendorFrontend)
}

publishing {
    publications {
        create<MavenPublication>("maven") {
            from(components["java"])
            artifactId = "ashurbanipal-spring-boot-starter"
            // Central Portal requires name/description/url/licenses/developers/scm
            // on every published POM; filled in ahead of the actual namespace
            // verification + signing setup (docs/publishing-checklist.md).
            pom {
                name.set("Ashurbanipal Spring Boot Starter")
                description.set("Kotlin/Spring Boot autoconfiguration starter implementing spec/protocol.md — an embeddable, read-only web UI for browsing a service's own database tables.")
                url.set("https://github.com/mt-empty/ashurbanipal/tree/main/implementations/spring-boot-starter")
                licenses {
                    license {
                        name.set("MIT")
                        url.set("https://github.com/mt-empty/ashurbanipal/blob/main/LICENSE")
                    }
                }
                developers {
                    developer {
                        id.set("mt-empty")
                        name.set("mt-empty")
                        // GitHub-provided noreply address (id+username@users.noreply.github.com)
                        // rather than a real inbox — this is published publicly and
                        // permanently once released.
                        email.set("59728838+mt-empty@users.noreply.github.com")
                        url.set("https://github.com/mt-empty")
                    }
                }
                scm {
                    url.set("https://github.com/mt-empty/ashurbanipal")
                    connection.set("scm:git:https://github.com/mt-empty/ashurbanipal.git")
                    developerConnection.set("scm:git:ssh://github.com/mt-empty/ashurbanipal.git")
                }
            }
        }
    }
    // Inert on purpose: shape only, no credentials wired, never executed
    // by CI in this repo. Actual publishing goes through nmcp (settings.gradle.kts)
    // instead, which reads the "maven" publication directly rather than via
    // `publish`/`PublishToMavenRepository` — this placeholder just keeps
    // the `publishing {}` block's `repositories` non-empty, which Gradle
    // otherwise warns about.
    repositories {
        maven {
            name = "placeholder"
            url = uri(layout.buildDirectory.dir("repo"))
        }
    }
}

// Central Portal rejects unsigned artifacts outright. Signing only needs
// to resolve when a publish task actually runs — build/test never touch
// this — so an absent GPG_PRIVATE_KEY/GPG_PASSPHRASE (any non-publish CI
// job, any local dev build) leaves signing un-configured rather than
// failing the build.
val signingKey = providers.environmentVariable("GPG_PRIVATE_KEY").orNull
val signingPassphrase = providers.environmentVariable("GPG_PASSPHRASE").orNull
if (signingKey != null && signingPassphrase != null) {
    signing {
        useInMemoryPgpKeys(signingKey, signingPassphrase)
        sign(publishing.publications["maven"])
    }
}

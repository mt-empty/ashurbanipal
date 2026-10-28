plugins {
    kotlin("jvm") version "2.4.21"
    kotlin("plugin.spring") version "2.4.21"
    id("org.springframework.boot") version "4.1.2"
}

group = "io.github.mt-empty.ashurbanipal.demo"
version = "0.0.1"

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

dependencyLocking {
    lockAllConfigurations()
}

dependencies {
    implementation(platform("org.springframework.boot:spring-boot-dependencies:4.1.2"))
    // Newer than Spring Boot 4.1.2's managed Jackson; the higher platform wins.
    implementation(platform("tools.jackson:jackson-bom:3.2.4"))

    implementation(project(":"))
    implementation("org.springframework.boot:spring-boot-starter-web")
    implementation("org.springframework.boot:spring-boot-starter-jdbc")
    implementation("org.jetbrains.kotlin:kotlin-reflect")
    runtimeOnly("org.postgresql:postgresql")
    // For the backend-mysql and backend-sqlite profiles.
    runtimeOnly("com.mysql:mysql-connector-j:26.10.0")
    runtimeOnly("org.xerial:sqlite-jdbc:3.53.4.0")
}

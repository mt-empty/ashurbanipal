plugins {
    kotlin("jvm") version "2.4.21"
    kotlin("plugin.spring") version "2.4.21"
    id("org.springframework.boot") version "4.1.1"
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
    implementation(platform("org.springframework.boot:spring-boot-dependencies:4.1.1"))
    // Newer than Spring Boot 4.1.1's managed Jackson and Tomcat; the higher version wins.
    implementation(platform("tools.jackson:jackson-bom:3.1.7"))
    constraints {
        implementation("org.apache.tomcat.embed:tomcat-embed-core:11.0.25")
        implementation("org.apache.tomcat.embed:tomcat-embed-el:11.0.25")
        implementation("org.apache.tomcat.embed:tomcat-embed-websocket:11.0.25")
    }

    implementation(project(":"))
    implementation("org.springframework.boot:spring-boot-starter-web")
    implementation("org.springframework.boot:spring-boot-starter-jdbc")
    implementation("org.jetbrains.kotlin:kotlin-reflect")
    runtimeOnly("org.postgresql:postgresql")
}

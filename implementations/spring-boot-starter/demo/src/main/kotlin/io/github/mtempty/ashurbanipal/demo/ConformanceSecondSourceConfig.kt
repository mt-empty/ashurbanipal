package io.github.mtempty.ashurbanipal.demo

import org.springframework.boot.jdbc.autoconfigure.DataSourceProperties
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.context.annotation.Primary
import org.springframework.context.annotation.Profile
import javax.sql.DataSource

/**
 * Only active under the `conformance-second-source` Spring profile —
 * `application.yml`'s matching profile document adds the
 * `ashurbanipal.sources[1]` entry that references [otherSchemaDataSource]
 * by name. This is `conformance/runner/two_source.rs`'s target (see that
 * file's module doc), not something a real host needs: same connection as
 * the primary `DataSource`, pinned to `other_schema` (already part of
 * `conformance/seed/seed.sql`) instead of a second database — mirrors
 * `implementations/rust/axum/examples/demo.rs`'s
 * `CONFORMANCE_SECOND_SOURCE` mode for the same purpose.
 *
 * [primaryDataSource] has to be defined here too, explicitly `@Primary`,
 * rather than left to Spring Boot's own `DataSourceAutoConfiguration`:
 * that auto-configuration is `@ConditionalOnMissingBean(DataSource::class)`,
 * and user `@Configuration` classes are registered before auto-configuration
 * classes run — so the moment [otherSchemaDataSource] alone existed, Boot's
 * auto-configured primary bean was never created at all, and the "default"
 * source (`dataSourceBean: null` → the one unqualified `DataSource` bean)
 * silently resolved to the *other_schema*-pinned pool for both entries.
 * Built from the injected [DataSourceProperties] (still registered here —
 * its own `@EnableConfigurationProperties` isn't gated on a missing
 * `DataSource`) rather than hand-wired `@Value` fields, so it stays the
 * same construction path Boot's own auto-configuration would have used —
 * any future `spring.datasource.*`/Hikari tuning in `application.yml`
 * keeps applying here too, instead of silently diverging.
 */
@Configuration
@Profile("conformance-second-source")
class ConformanceSecondSourceConfig {

    @Bean
    @Primary
    fun primaryDataSource(properties: DataSourceProperties): DataSource =
        properties.initializeDataSourceBuilder().build()

    @Bean(name = ["otherSchemaDataSource"])
    fun otherSchemaDataSource(properties: DataSourceProperties): DataSource {
        val url = requireNotNull(properties.url) { "spring.datasource.url must be set" }
        val separator = if (url.contains("?")) "&" else "?"
        return properties.initializeDataSourceBuilder()
            .url("$url${separator}currentSchema=other_schema")
            .build()
    }
}

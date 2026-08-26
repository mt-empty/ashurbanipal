package io.github.mtempty.ashurbanipal.demo

import org.springframework.boot.jdbc.autoconfigure.DataSourceProperties
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.context.annotation.Primary
import org.springframework.context.annotation.Profile
import javax.sql.DataSource

/**
 * Only active under the `conformance-second-source` Spring profile — not
 * something a real host needs. `application.yml`'s matching profile
 * document adds `ashurbanipal.sources[1]`, referencing
 * [otherSchemaDataSource] by name, as `conformance/runner/two_source.rs`'s
 * target: the primary connection again, pinned to `other_schema`, instead
 * of a second database.
 *
 * [primaryDataSource] must be redefined here, explicitly `@Primary`,
 * because defining [otherSchemaDataSource] alone would suppress Boot's own
 * `DataSourceAutoConfiguration` (`@ConditionalOnMissingBean(DataSource::class)`
 * backs off once any user `@Configuration` bean of that type exists) — the
 * "default" source would then silently resolve to the *other_schema*-pinned
 * pool for both entries. Built from the injected [DataSourceProperties]
 * rather than hand-wired `@Value` fields, so any `spring.datasource.*`/Hikari
 * tuning in `application.yml` keeps applying here too.
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

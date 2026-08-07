package io.github.mtempty.ashurbanipal

import org.springframework.boot.autoconfigure.AutoConfiguration
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication
import org.springframework.boot.context.properties.EnableConfigurationProperties
import org.springframework.context.ApplicationContext
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Conditional
import java.net.http.HttpClient
import java.time.Duration
import javax.sql.DataSource

/**
 * Fail-closed exactly like the Rust `Config::validate()`/`is_enabled()`
 * pair (implementation.md §5.2): [AshurbanipalEnabledCondition] gates this
 * whole class, so a disabled or unconfigured environment registers zero
 * beans — indistinguishable from the starter never being on the classpath —
 * and a production-like `enabled-for` value fails context startup instead
 * of silently disabling at request time.
 */
@AutoConfiguration
@ConditionalOnWebApplication(type = ConditionalOnWebApplication.Type.SERVLET)
@EnableConfigurationProperties(AshurbanipalProperties::class)
@Conditional(AshurbanipalEnabledCondition::class)
class AshurbanipalAutoConfiguration {

    @Bean
    fun ashurbanipalFilterValidator(): FilterValidator = FilterValidator()

    /**
     * Which [DbSource] gets constructed is chosen by [AshurbanipalProperties.backend]
     * alone — an explicit opt-in property, never classpath/driver detection
     * (`PORTING.md`'s hardening checklist item 2). [AshurbanipalProperties]'s
     * own init block already rejects an unrecognized value at config-parse
     * time, so the `else` branch below is unreachable, not a silent fallback.
     */
    @Bean
    fun ashurbanipalDbSource(
        properties: AshurbanipalProperties,
        applicationContext: ApplicationContext,
        filterValidator: FilterValidator,
    ): DbSource {
        val dataSource = properties.dataSourceBean
            ?.let { applicationContext.getBean(it, DataSource::class.java) }
            ?: applicationContext.getBean(DataSource::class.java)
        val queryTimeoutSecs = properties.limits.queryTimeoutSecs
        return when (properties.backend.lowercase()) {
            "postgres" -> PostgresSource(dataSource, queryTimeoutSecs, filterValidator)
            "mysql" -> MySqlSource(dataSource, queryTimeoutSecs)
            "sqlite" -> SqliteSource(dataSource, queryTimeoutSecs)
            else -> error("unreachable: AshurbanipalProperties validates backend at construction")
        }
    }

    @Bean
    fun ashurbanipalHttpClient(): HttpClient =
        HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3)).build()

    @Bean
    fun ashurbanipalDbViewerController(
        properties: AshurbanipalProperties,
        dbSource: DbSource,
        filterValidator: FilterValidator,
        httpClient: HttpClient,
    ): DbViewerController = DbViewerController(properties, dbSource, filterValidator, httpClient)
}

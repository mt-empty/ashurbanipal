package io.github.mtempty.ashurbanipal

import org.springframework.beans.factory.ObjectProvider
import org.springframework.boot.autoconfigure.AutoConfiguration
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication
import org.springframework.boot.context.properties.EnableConfigurationProperties
import org.springframework.boot.web.servlet.FilterRegistrationBean
import org.springframework.context.ApplicationContext
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Conditional
import org.springframework.core.env.Environment
import org.springframework.core.Ordered
import org.springframework.web.servlet.handler.HandlerMappingIntrospector
import java.net.http.HttpClient
import java.time.Duration
import javax.sql.DataSource

/**
 * Fail-closed: [AshurbanipalEnabledCondition] gates this whole class, so
 * `enabled` defaulting to false or being unset registers zero beans —
 * indistinguishable from the starter never being on the classpath.
 */
@AutoConfiguration
@ConditionalOnWebApplication(type = ConditionalOnWebApplication.Type.SERVLET)
@EnableConfigurationProperties(AshurbanipalProperties::class)
@Conditional(AshurbanipalEnabledCondition::class)
class AshurbanipalAutoConfiguration {

    @Bean
    fun ashurbanipalFilterValidator(): FilterValidator = FilterValidator()

    /**
     * One [DbSource] per [AshurbanipalProperties.resolvedSources] entry, keyed
     * by its `name` — which concrete implementation gets constructed for each
     * is chosen by that entry's own `backend` alone, an explicit opt-in
     * property, never classpath/driver detection (`PORTING.md`'s hardening
     * checklist item 2). [AshurbanipalProperties]'s own init block already
     * rejects an unrecognized backend value or a duplicate/blank name at
     * config-parse time, so the `else` branch below is unreachable, not a
     * silent fallback. `LinkedHashMap` preserves config order, since that
     * order is also `api/sources`' listing order and `source`-param-absent's
     * default (`AshurbanipalController.resolveSource`).
     */
    @Bean
    fun ashurbanipalDbSources(
        properties: AshurbanipalProperties,
        applicationContext: ApplicationContext,
    ): Map<String, DbSource> {
        val queryTimeoutSecs = properties.limits.queryTimeoutSecs
        val result = LinkedHashMap<String, DbSource>()
        for (source in properties.resolvedSources) {
            val dataSource = source.dataSourceBean
                ?.let { applicationContext.getBean(it, DataSource::class.java) }
                ?: applicationContext.getBean(DataSource::class.java)
            result[source.name] = when (source.backend.lowercase()) {
                "postgres" -> PostgresSource(dataSource, queryTimeoutSecs)
                "mysql" -> MySqlSource(dataSource, queryTimeoutSecs)
                "sqlite" -> SqliteSource(dataSource, queryTimeoutSecs)
                else -> error("unreachable: AshurbanipalProperties validates backend at construction")
            }
        }
        return result
    }

    @Bean
    fun ashurbanipalHttpClient(): HttpClient =
        HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3)).build()

    @Bean
    fun ashurbanipalMultipartExceptionResolver(
        properties: AshurbanipalProperties,
        environment: Environment,
    ): MultipartExceptionResolver = MultipartExceptionResolver(ViewerMount.of(environment, properties.basePath))

    /** Runs ahead of Spring's own filters, so a rejected request reaches nothing else. */
    @Bean
    fun ashurbanipalHostAllowListFilter(
        properties: AshurbanipalProperties,
        environment: Environment,
        introspector: ObjectProvider<HandlerMappingIntrospector>,
    ): FilterRegistrationBean<HostAllowListFilter> {
        val mount = ViewerMount.of(environment, properties.basePath)
        val hosts = HostAllowList(properties.allowedHosts)
        val hostRoutes = HostRouteLookup { introspector.ifAvailable?.handlerMappings }
        return FilterRegistrationBean(HostAllowListFilter(hosts, hostRoutes)).apply {
            addUrlPatterns(*mount.paths.toTypedArray())
            order = Ordered.HIGHEST_PRECEDENCE
            // Built either way so the filter logs the missing-list warning.
            isEnabled = hosts.active
        }
    }

    @Bean
    fun ashurbanipalController(
        properties: AshurbanipalProperties,
        dbSources: Map<String, DbSource>,
        filterValidator: FilterValidator,
        httpClient: HttpClient,
    ): AshurbanipalController = AshurbanipalController(properties, dbSources, filterValidator, httpClient)
}

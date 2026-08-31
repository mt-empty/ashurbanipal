package io.github.mtempty.ashurbanipal

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.mockito.Mockito
import org.springframework.boot.test.context.runner.WebApplicationContextRunner
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import javax.sql.DataSource

/** A mock DataSource is enough: the enabled-path beans only construct a `JdbcTemplate` from it, never connect. */
@Configuration
class TestDataSourceConfig {
    @Bean
    fun dataSource(): DataSource = Mockito.mock(DataSource::class.java)
}

/** Tests fail-closed configuration through bean registration without a live database. */
class AshurbanipalKillSwitchTest {
    private fun runner(): WebApplicationContextRunner =
        WebApplicationContextRunner()
            .withUserConfiguration(AshurbanipalAutoConfiguration::class.java, TestDataSourceConfig::class.java)

    /** PORTING.md hardening item 2: absent config MUST mean disabled, never "enabled with defaults". */
    @Test
    fun `no config at all means disabled`() {
        runner().run { context ->
            assertThat(context).hasNotFailed()
            assertThat(context).doesNotHaveBean(AshurbanipalController::class.java)
            assertThat(context).doesNotHaveBean("ashurbanipalDbSources")
        }
    }

    @Test
    fun `enabled=false means disabled`() {
        runner()
            .withPropertyValues("ashurbanipal.enabled=false")
            .run { context ->
                assertThat(context).hasNotFailed()
                assertThat(context).doesNotHaveBean(AshurbanipalController::class.java)
            }
    }

    @Test
    fun `enabled=true registers the routes`() {
        runner()
            .withPropertyValues("ashurbanipal.enabled=true")
            .run { context ->
                assertThat(context).hasNotFailed()
                assertThat(context).hasSingleBean(AshurbanipalController::class.java)
                assertThat(context).hasBean("ashurbanipalDbSources")
            }
    }

    @Suppress("UNCHECKED_CAST")
    private fun dbSourcesBean(context: org.springframework.context.ApplicationContext): Map<String, DbSource> =
        context.getBean("ashurbanipalDbSources") as Map<String, DbSource>

    /** No `ashurbanipal.sources` at all MUST mean one implicit `default` source on Postgres (today's only pre-existing behavior), never a startup failure — absent config must not accidentally read as an invalid value. */
    @Test
    fun `no backend configured defaults to postgres`() {
        runner()
            .withPropertyValues("ashurbanipal.enabled=true")
            .run { context ->
                assertThat(context).hasNotFailed()
                assertThat(dbSourcesBean(context)["default"]).isInstanceOf(PostgresSource::class.java)
            }
    }

    /** An unrecognized `backend` value MUST be rejected at config load, the same fail-fast treatment as an invalid config value elsewhere — never silently falling back to Postgres. */
    @Test
    fun `unrecognized backend value fails startup`() {
        runner()
            .withPropertyValues(
                "ashurbanipal.enabled=true",
                "ashurbanipal.sources[0].name=default",
                "ashurbanipal.sources[0].backend=oracle",
            )
            .run { context ->
                assertThat(context).hasFailed()
                assertThat(context.startupFailure).hasRootCauseInstanceOf(InvalidBackendException::class.java)
            }
    }

    @Test
    fun `explicit mysql backend constructs MySqlSource`() {
        runner()
            .withPropertyValues(
                "ashurbanipal.enabled=true",
                "ashurbanipal.sources[0].name=default",
                "ashurbanipal.sources[0].backend=mysql",
            )
            .run { context ->
                assertThat(context).hasNotFailed()
                assertThat(dbSourcesBean(context)["default"]).isInstanceOf(MySqlSource::class.java)
            }
    }

    @Test
    fun `explicit sqlite backend constructs SqliteSource`() {
        runner()
            .withPropertyValues(
                "ashurbanipal.enabled=true",
                "ashurbanipal.sources[0].name=default",
                "ashurbanipal.sources[0].backend=sqlite",
            )
            .run { context ->
                assertThat(context).hasNotFailed()
                assertThat(dbSourcesBean(context)["default"]).isInstanceOf(SqliteSource::class.java)
            }
    }
}

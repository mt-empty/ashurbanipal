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

/**
 * Ports the Rust reference's fail-closed guarantee
 * (implementations/rust/core/src/config.rs's tests) at the level this port
 * can actually observe it: config-time bean registration, since a Spring
 * context that fails to start is process-startup behavior, not an HTTP
 * response the conformance kit could ever see (PORTING.md hardening item
 * 5). Uses a mock `DataSource` — the enabled-path beans only need one to
 * construct a `JdbcTemplate`, never to actually connect, so no live
 * database is needed for these tests.
 */
class AshurbanipalKillSwitchTest {
    private fun runner(): WebApplicationContextRunner =
        WebApplicationContextRunner()
            .withUserConfiguration(AshurbanipalAutoConfiguration::class.java, TestDataSourceConfig::class.java)

    /** PORTING.md hardening item 2: absent config MUST mean disabled, never "enabled with defaults". */
    @Test
    fun `no config at all means disabled`() {
        runner().run { context ->
            assertThat(context).hasNotFailed()
            assertThat(context).doesNotHaveBean(DbViewerController::class.java)
            assertThat(context).doesNotHaveBean(DbSource::class.java)
        }
    }

    @Test
    fun `enabled=false means disabled`() {
        runner()
            .withPropertyValues("ashurbanipal.enabled=false")
            .run { context ->
                assertThat(context).hasNotFailed()
                assertThat(context).doesNotHaveBean(DbViewerController::class.java)
            }
    }

    @Test
    fun `enabled=true registers the routes`() {
        runner()
            .withPropertyValues("ashurbanipal.enabled=true")
            .run { context ->
                assertThat(context).hasNotFailed()
                assertThat(context).hasSingleBean(DbViewerController::class.java)
                assertThat(context).hasSingleBean(DbSource::class.java)
            }
    }

    /** No `ashurbanipal.backend` at all MUST mean Postgres (today's only pre-existing behavior), never a startup failure — absent config must not accidentally read as an invalid value. */
    @Test
    fun `no backend configured defaults to postgres`() {
        runner()
            .withPropertyValues("ashurbanipal.enabled=true")
            .run { context ->
                assertThat(context).hasNotFailed()
                assertThat(context.getBean(DbSource::class.java)).isInstanceOf(PostgresSource::class.java)
            }
    }

    /** An unrecognized `backend` value MUST be rejected at config load, the same fail-fast treatment as an invalid config value elsewhere — never silently falling back to Postgres. */
    @Test
    fun `unrecognized backend value fails startup`() {
        runner()
            .withPropertyValues("ashurbanipal.enabled=true", "ashurbanipal.backend=oracle")
            .run { context ->
                assertThat(context).hasFailed()
                assertThat(context.startupFailure).hasRootCauseInstanceOf(InvalidBackendException::class.java)
            }
    }

    @Test
    fun `explicit mysql backend constructs MySqlSource`() {
        runner()
            .withPropertyValues("ashurbanipal.enabled=true", "ashurbanipal.backend=mysql")
            .run { context ->
                assertThat(context).hasNotFailed()
                assertThat(context.getBean(DbSource::class.java)).isInstanceOf(MySqlSource::class.java)
            }
    }

    @Test
    fun `explicit sqlite backend constructs SqliteSource`() {
        runner()
            .withPropertyValues("ashurbanipal.enabled=true", "ashurbanipal.backend=sqlite")
            .run { context ->
                assertThat(context).hasNotFailed()
                assertThat(context.getBean(DbSource::class.java)).isInstanceOf(SqliteSource::class.java)
            }
    }
}

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
 * Ports the Rust reference's fail-closed guarantees
 * (implementations/rust/src/config.rs's tests) at the level this port can
 * actually observe them: config-time bean registration, since a Spring
 * context that fails to start is process-startup behavior, not an HTTP
 * response the conformance kit could ever see (implementation.md §5.5 item
 * 5 / docs/design.md §4.2's third paragraph). Uses a mock `DataSource` — the
 * enabled-path beans only need one to construct a `JdbcTemplate`, never to
 * actually connect, so no live database is needed for these tests.
 */
class AshurbanipalKillSwitchTest {
    private fun runner(): WebApplicationContextRunner =
        WebApplicationContextRunner()
            .withUserConfiguration(AshurbanipalAutoConfiguration::class.java, TestDataSourceConfig::class.java)

    /** implementation.md §5.5 item 2: absent config MUST mean disabled, never "enabled with defaults". */
    @Test
    fun `no config at all means disabled`() {
        runner().run { context ->
            assertThat(context).hasNotFailed()
            assertThat(context).doesNotHaveBean(DbViewerController::class.java)
            assertThat(context).doesNotHaveBean(DbSource::class.java)
        }
    }

    @Test
    fun `environment not present in enabled-for is disabled`() {
        runner()
            .withPropertyValues("ashurbanipal.environment=staging", "ashurbanipal.enabled-for=dev")
            .run { context ->
                assertThat(context).hasNotFailed()
                assertThat(context).doesNotHaveBean(DbViewerController::class.java)
            }
    }

    @Test
    fun `matching environment registers the routes`() {
        runner()
            .withPropertyValues("ashurbanipal.environment=dev", "ashurbanipal.enabled-for=dev,integration")
            .run { context ->
                assertThat(context).hasNotFailed()
                assertThat(context).hasSingleBean(DbViewerController::class.java)
                assertThat(context).hasSingleBean(DbSource::class.java)
            }
    }

    @Test
    fun `any matches every non-production environment`() {
        runner()
            .withPropertyValues("ashurbanipal.environment=qa-eu-1", "ashurbanipal.enabled-for=any")
            .run { context ->
                assertThat(context).hasNotFailed()
                assertThat(context).hasSingleBean(DbViewerController::class.java)
            }
    }

    /** spec/protocol.md §4: a production-like name in `enabled-for` MUST be rejected at config load — startup fails, not a runtime 404. */
    @Test
    fun `production-like enabled-for value fails startup`() {
        for (alias in listOf("production", "prod", "PROD", "Production", "PRD", "live")) {
            runner()
                .withPropertyValues("ashurbanipal.environment=dev", "ashurbanipal.enabled-for=dev,$alias")
                .run { context ->
                    assertThat(context).hasFailed()
                    val failure = context.startupFailure
                    assertThat(failure).hasRootCauseInstanceOf(ProductionEnabledException::class.java)
                }
        }
    }

    /** Running *in* production disables regardless of `enabled-for` (even `any`) — but this is a plain disable, not a startup failure, since `enabled-for` itself names no production-like value here. */
    @Test
    fun `running environment itself being production-like disables without failing startup`() {
        for (prodEnv in listOf("production", "PROD", "live")) {
            runner()
                .withPropertyValues("ashurbanipal.environment=$prodEnv", "ashurbanipal.enabled-for=any")
                .run { context ->
                    assertThat(context).hasNotFailed()
                    assertThat(context).doesNotHaveBean(DbViewerController::class.java)
                }
        }
    }

    /** No `ashurbanipal.backend` at all MUST mean Postgres (today's only pre-existing behavior), never a startup failure — absent config must not accidentally read as an invalid value. */
    @Test
    fun `no backend configured defaults to postgres`() {
        runner()
            .withPropertyValues("ashurbanipal.environment=dev", "ashurbanipal.enabled-for=dev")
            .run { context ->
                assertThat(context).hasNotFailed()
                assertThat(context.getBean(DbSource::class.java)).isInstanceOf(PostgresSource::class.java)
            }
    }

    /** An unrecognized `backend` value MUST be rejected at config load, the same fail-fast treatment as a production-like `enabled-for` value — never silently falling back to Postgres. */
    @Test
    fun `unrecognized backend value fails startup`() {
        runner()
            .withPropertyValues("ashurbanipal.environment=dev", "ashurbanipal.enabled-for=dev", "ashurbanipal.backend=oracle")
            .run { context ->
                assertThat(context).hasFailed()
                assertThat(context.startupFailure).hasRootCauseInstanceOf(InvalidBackendException::class.java)
            }
    }

    @Test
    fun `explicit mysql backend constructs MySqlSource`() {
        runner()
            .withPropertyValues("ashurbanipal.environment=dev", "ashurbanipal.enabled-for=dev", "ashurbanipal.backend=mysql")
            .run { context ->
                assertThat(context).hasNotFailed()
                assertThat(context.getBean(DbSource::class.java)).isInstanceOf(MySqlSource::class.java)
            }
    }

    @Test
    fun `explicit sqlite backend constructs SqliteSource`() {
        runner()
            .withPropertyValues("ashurbanipal.environment=dev", "ashurbanipal.enabled-for=dev", "ashurbanipal.backend=sqlite")
            .run { context ->
                assertThat(context).hasNotFailed()
                assertThat(context.getBean(DbSource::class.java)).isInstanceOf(SqliteSource::class.java)
            }
    }
}

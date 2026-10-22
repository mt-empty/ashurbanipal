package io.github.mtempty.ashurbanipal

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.springframework.boot.test.context.runner.WebApplicationContextRunner
import tools.jackson.databind.ObjectMapper

/** `/api/siblings` instance and label handling (`spec/protocol.md` §5.6); port 9 refuses at once, so every check is a fast `healthy: false`. */
class SiblingsConfigTest {
    private val unreachable = "http://127.0.0.1:9/__ashurbanipal"

    private fun runner(vararg extra: String): WebApplicationContextRunner =
        WebApplicationContextRunner()
            .withUserConfiguration(AshurbanipalAutoConfiguration::class.java, TestDataSourceConfig::class.java)
            .withPropertyValues(
                "ashurbanipal.enabled=true",
                "ashurbanipal.instance.name=orders",
                "ashurbanipal.instance.label=dev",
                "ashurbanipal.siblings[0].name=orders",
                "ashurbanipal.siblings[0].label=dev",
                "ashurbanipal.siblings[0].base-url=$unreachable",
                "ashurbanipal.siblings[0].health-path=/health",
                "ashurbanipal.siblings[1].name=orders",
                "ashurbanipal.siblings[1].label=int",
                "ashurbanipal.siblings[1].base-url=$unreachable",
                "ashurbanipal.siblings[1].health-path=/health",
                "ashurbanipal.siblings[2].name=billing",
                "ashurbanipal.siblings[2].base-url=$unreachable",
                "ashurbanipal.siblings[2].health-path=/health",
                *extra,
            )

    @Test
    fun `reports this instance in place without a check`() {
        runner().run { context ->
            assertThat(context).hasNotFailed()
            val body = context.getBean(AshurbanipalController::class.java).siblings().body
            val mapper = ObjectMapper()
            assertThat(mapper.readTree(mapper.writeValueAsString(body))).isEqualTo(
                mapper.readTree(
                    """
                    {
                      "instance": { "name": "orders", "label": "dev" },
                      "siblings": [
                        { "name": "orders", "label": "dev", "base_url": "$unreachable", "healthy": true },
                        { "name": "orders", "label": "int", "base_url": "$unreachable", "healthy": false },
                        { "name": "billing", "base_url": "$unreachable", "healthy": false }
                      ]
                    }
                    """,
                ),
            )
        }
    }

    private fun assertInvalidConfig(vararg extra: String) {
        runner(*extra).run { context ->
            assertThat(context).hasNotFailed()
            val response = context.getBean(AshurbanipalController::class.java).siblings()
            assertThat(response.statusCode.value()).isEqualTo(500)
            val problem = response.body as ProblemDetails
            assertThat(problem.code).isEqualTo("invalid_config")
            assertThat(problem.title).startsWith("invalid sibling configuration: ")
        }
    }

    @Test
    fun `an instance without a label is reported by siblings only`() =
        assertInvalidConfig("ashurbanipal.instance.label=")

    @Test
    fun `a duplicate name and label is reported by siblings only`() =
        assertInvalidConfig("ashurbanipal.siblings[1].label=dev")

    @Test
    fun `a disabled starter never validates siblings`() {
        runner("ashurbanipal.enabled=false", "ashurbanipal.instance.label=").run { context ->
            assertThat(context).hasNotFailed()
        }
        assertThat(AshurbanipalProperties(instance = Instance(name = "orders", label = "")).siblingsConfigError).isNull()
    }
}

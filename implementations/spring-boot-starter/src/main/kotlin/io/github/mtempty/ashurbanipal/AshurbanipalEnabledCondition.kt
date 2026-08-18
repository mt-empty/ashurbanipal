package io.github.mtempty.ashurbanipal

import org.springframework.boot.context.properties.bind.Binder
import org.springframework.context.annotation.Condition
import org.springframework.context.annotation.ConditionContext
import org.springframework.core.type.AnnotatedTypeMetadata

/**
 * Binds `ashurbanipal.*` straight from the `Environment` (not from the
 * `AshurbanipalProperties` bean — conditions are evaluated before bean
 * creation) so a `false` result here means the whole
 * [AshurbanipalAutoConfiguration] class, including
 * `@EnableConfigurationProperties`, is skipped: zero beans registered, every
 * route 404s exactly as if the starter weren't on the classpath at all.
 */
class AshurbanipalEnabledCondition : Condition {
    override fun matches(context: ConditionContext, metadata: AnnotatedTypeMetadata): Boolean {
        val properties = Binder.get(context.environment)
            .bind("ashurbanipal", AshurbanipalProperties::class.java)
            .orElseGet { AshurbanipalProperties() }
        return properties.isEnabled
    }
}

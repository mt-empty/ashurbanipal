package io.github.mtempty.ashurbanipal.demo

import org.springframework.boot.autoconfigure.SpringBootApplication
import org.springframework.boot.runApplication

/**
 * A minimal host app that merges the starter in, exactly the way a real
 * consumer would (implementation.md §5.4's README snippet): add the
 * dependency, set `ashurbanipal.*` config, done — no code beyond this. Plays
 * the same role `implementations/rust/examples/demo.rs` plays for the Rust
 * reference: a live HTTP target for the conformance kit
 * (`conformance/runner`, `conformance/runner/schema-check.sh`) via
 * `ASHURBANIPAL_CONFORMANCE_URL`.
 */
@SpringBootApplication
class DemoApplication

fun main(args: Array<String>) {
    runApplication<DemoApplication>(*args)
}

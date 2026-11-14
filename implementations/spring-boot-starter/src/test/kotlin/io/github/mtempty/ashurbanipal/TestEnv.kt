package io.github.mtempty.ashurbanipal

/**
 * The named database URL, or null so the caller skips locally. Under CI a
 * missing URL fails the test instead, so a CI job that loses the variable
 * can't turn it into a skip. Gradle forwards an unset variable as "", so
 * blank counts as missing.
 */
internal fun requireTestEnv(name: String): String? {
    val value = System.getenv(name)
    if (!value.isNullOrBlank()) return value
    check(System.getenv("CI").isNullOrBlank()) { "$name is not set; CI must provide it" }
    return null
}

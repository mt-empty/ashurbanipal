package io.github.mtempty.ashurbanipal

import java.io.ByteArrayOutputStream
import java.util.zip.Deflater
import java.util.zip.GZIPOutputStream

/**
 * Reads `Accept-Encoding` per RFC 9110 §12.5.3: an explicit gzip (or x-gzip)
 * entry wins over `*`, and q=0 means not acceptable.
 */
internal fun acceptsGzip(headerValues: List<String>): Boolean {
    var gzipQ = -1.0
    var starQ = -1.0
    for (entry in headerValues.flatMap { it.split(',') }) {
        val params = entry.split(';')
        var q = 1.0
        for (param in params.drop(1)) {
            val (name, value) = param.split('=', limit = 2).let { it[0].trim() to it.getOrElse(1) { "" }.trim() }
            if (name.equals("q", ignoreCase = true)) q = value.toDoubleOrNull() ?: 0.0
        }
        when (params[0].trim().lowercase()) {
            "gzip", "x-gzip" -> gzipQ = q
            "*" -> starQ = q
        }
    }
    return if (gzipQ >= 0) gzipQ > 0 else starQ > 0
}

internal fun gzip(bytes: ByteArray): ByteArray {
    val out = ByteArrayOutputStream()
    object : GZIPOutputStream(out) {
        init {
            def.setLevel(Deflater.BEST_COMPRESSION)
        }
    }.use { it.write(bytes) }
    return out.toByteArray()
}

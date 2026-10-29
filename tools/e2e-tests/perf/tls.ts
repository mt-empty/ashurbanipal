import { execFileSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DIR = fileURLToPath(new URL("../perf-results/tls/", import.meta.url));

/** A throwaway self-signed certificate for the proxy, made once per checkout. */
export function perfCertificate(): { key: Buffer; cert: Buffer } {
  const key = `${DIR}key.pem`;
  const cert = `${DIR}cert.pem`;
  if (!existsSync(cert)) {
    mkdirSync(DIR, { recursive: true });
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:prime256v1",
        "-nodes",
        "-keyout",
        key,
        "-out",
        cert,
        "-days",
        "365",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=IP:127.0.0.1,DNS:localhost",
      ],
      { stdio: "ignore" },
    );
  }
  return { key: readFileSync(key), cert: readFileSync(cert) };
}

// Chromium's --ignore-certificate-errors-spki-list takes this hash. Trusting the
// one key, rather than ignoring certificate errors, keeps the HTTP cache on:
// Chromium caches nothing from a connection whose certificate it rejected.
export function perfCertificateSpki(): string {
  const der = new X509Certificate(perfCertificate().cert).publicKey.export({ type: "spki", format: "der" });
  return createHash("sha256").update(der).digest("base64");
}

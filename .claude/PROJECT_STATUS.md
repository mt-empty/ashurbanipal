# Project status: alpha

Ashurbanipal is alpha software. Breaking changes — to the HTTP protocol
(`spec/protocol.md`/`spec/openapi.yaml`), the `DbSource` trait, config
shape, or any other surface — are expected and acceptable while the
project is in this phase. Don't over-invest in backward compatibility,
deprecation shims, or additive-only API changes unless the user asks for
that specifically; prefer the cleanest design over preserving old
behavior.

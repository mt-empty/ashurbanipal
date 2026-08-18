# ashurbanipal (go-nethttp)

A `net/http`-native Go port of [Ashurbanipal](../../readme.md) — implements
the same `spec/protocol.md` + `spec/openapi.yaml` contract as the Rust
reference and the Kotlin/Spring Boot starter, targeting the standard
library's `http.Handler` directly rather than any specific router, so it
mounts into a plain `net/http.ServeMux`, Chi, or anything else that speaks
`http.Handler`.

Not tagged/released — this module is only "published" in the sense of
being a well-formed Go module in this repository. Once a release tag
exists, the intended usage is:

```sh
go get github.com/mt-empty/ashurbanipal/implementations/go-nethttp@vX.Y.Z
```

## Usage

```go
import ashurbanipal "github.com/mt-empty/ashurbanipal/implementations/go-nethttp"

cfg := ashurbanipal.Config{Enabled: true}
source := ashurbanipal.NewPostgresSource(db, cfg.Limits.WithDefaults().QueryTimeoutSecs)
viewer := ashurbanipal.Router(cfg, source)
mux.Handle("/", viewer) // or nest it under any net/http-compatible router
```

`Config{}` (the zero value) is disabled by construction: `Enabled` is
`false`. A host that forgets to configure anything gets a 404'd viewer,
never one silently enabled with defaults. Ashurbanipal has no opinion on
which environment it's running in — that's entirely the host's call.

## Database support

Postgres by default. MySQL/MariaDB and SQLite are supported behind the
`mysql`/`sqlite` build tags (some fields — comments, common-values stats
— degrade to empty on those backends, see `docs/adapter-decisions.md`) —
swap in `NewSQLiteSource`/`NewMySQLSource` in place of
`NewPostgresSource`, everything else stays the same:

```sh
go build -tags sqlite ./...   # or -tags mysql, or -tags sqlite,mysql for both
```

```go
source := ashurbanipal.NewSQLiteSource(db, cfg.Limits.WithDefaults().QueryTimeoutSecs)
viewer := ashurbanipal.Router(cfg, source)
```

Full API/config reference:
[docs/design.md](https://github.com/mt-empty/ashurbanipal/blob/main/docs/design.md).

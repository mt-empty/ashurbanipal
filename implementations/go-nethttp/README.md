# ashurbanipal (go-nethttp)

A `net/http`-native Go port of [Ashurbanipal](../../readme.md) — implements
the same `spec/protocol.md` + `spec/openapi.yaml` contract as the Rust
reference and the Kotlin/Spring Boot, Node/Express, and Flask ports,
targeting the standard
library's `http.Handler` directly rather than any specific router, so it
mounts into a plain `net/http.ServeMux`, Chi, or anything else that speaks
`http.Handler`.

Released via a subdirectory-module tag (`implementations/go-nethttp/vX.Y.Z`);
`proxy.golang.org` serves it, no registry account involved. Install:

```sh
go get github.com/mt-empty/ashurbanipal/implementations/go-nethttp@latest
```

## Usage

```go
import ashurbanipal "github.com/mt-empty/ashurbanipal/implementations/go-nethttp"

cfg := ashurbanipal.Config{Enabled: true}
source := ashurbanipal.NewPostgresSource(db, cfg.Limits.WithDefaults().QueryTimeoutSecs)
viewer := ashurbanipal.Router(cfg, []ashurbanipal.NamedSource{{Name: "primary", Source: source}})
mux.Handle("/", viewer) // or nest it under any net/http-compatible router
```

`Router` takes an ordered, non-empty list of named sources rather than a
single one — a host can register more than one `DbSource` (e.g. two
Postgres databases) and a request's `source` query param selects which one
it targets (`spec/protocol.md` §1, §5.8); the first entry is the default
used when `source` is absent. A single-source deployment just registers
one entry, as above.

`Config` has no config-file format of its own (`docs/design.md` §7) — the
host populates the struct however it likes, e.g. env vars or flags. The
optional fields, shown here at their defaults/example values:

```go
cfg := ashurbanipal.Config{
	Enabled:  true,
	BasePath: "/__ashurbanipal", // empty also means this
	Limits:   ashurbanipal.Limits{DefaultPageSize: 50, MaxPageSize: 100, QueryTimeoutSecs: 5},
	Instance: &ashurbanipal.Instance{Name: "orders", Label: "dev"}, // spec/protocol.md §5.6
	// One shared list, in the same order, on every instance keeps the grid the same everywhere.
	// Label is optional; typically an environment (dev, int) or a region (eu, us).
	Siblings: []ashurbanipal.Sibling{
		{Name: "orders", Label: "int", BaseURL: "https://orders-int.internal.vpn/__ashurbanipal", HealthPath: "/health"},
		{Name: "billing", BaseURL: "https://billing.internal.vpn/__ashurbanipal", HealthPath: "/health"},
	},
}
```

`Config{}` (the zero value) is disabled by construction: `Enabled` is
`false`. A host that forgets to configure anything gets a 404'd viewer,
never one silently enabled with defaults. Ashurbanipal has no opinion on
which environment it's running in — that's entirely the host's call.

## Compression

The UI page is sent gzipped when the browser accepts gzip (`spec/protocol.md` §5.1); it is compressed once, at start-up. API responses are sent uncompressed. A host compression handler such as `gzhttp` leaves the page alone, because it already carries `Content-Encoding`.

## Behind your own auth

Ashurbanipal ships no authentication ([`docs/design.md`](https://github.com/mt-empty/ashurbanipal/blob/main/docs/design.md) §6); guard the mount prefix with your host's own. Cover the whole prefix, UI included, and check a role rather than just a login — otherwise every signed-in user can read every table the database role can.

Register the wrapped handler at the mount prefix (or `cfg.BasePath`) instead of `/`, so the guard doesn't cover the rest of your mux. The UI is served at the bare prefix, so register both the exact path and the subtree:

```go
func requireAdmin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !isAdmin(r) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}

guarded := requireAdmin(viewer)
mux.Handle("/__ashurbanipal", guarded)
mux.Handle("/__ashurbanipal/", guarded)
```

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
viewer := ashurbanipal.Router(cfg, []ashurbanipal.NamedSource{{Name: "primary", Source: source}})
```

Full API/config reference:
[docs/design.md](https://github.com/mt-empty/ashurbanipal/blob/main/docs/design.md).

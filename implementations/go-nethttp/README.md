# ashurbanipal (Go, net/http)

A read-only database browser you mount inside your own Go app. It reuses your app's `*sql.DB`, so there are no extra credentials and nothing extra to deploy. It is a plain `http.Handler`, so it works with `http.ServeMux`, Chi, or any router that accepts one. Part of [Ashurbanipal](https://github.com/mt-empty/ashurbanipal).

Requires Go 1.26+.

## Install

```sh
go get github.com/mt-empty/ashurbanipal/implementations/go-nethttp@latest
go get github.com/jackc/pgx/v5
```

## Quick start

```go
package main

import (
	"database/sql"
	"log"
	"net/http"
	"os"

	_ "github.com/jackc/pgx/v5/stdlib" // registers the "pgx" driver

	ashurbanipal "github.com/mt-empty/ashurbanipal/implementations/go-nethttp"
)

func main() {
	db, err := sql.Open("pgx", os.Getenv("DATABASE_URL"))
	if err != nil {
		log.Fatal(err)
	}

	cfg := ashurbanipal.Config{Enabled: true}
	source := ashurbanipal.NewPostgresSource(db, cfg.Limits.WithDefaults().QueryTimeoutSecs)
	viewer := ashurbanipal.Router(cfg, []ashurbanipal.NamedSource{{Name: "primary", Source: source}})

	mux := http.NewServeMux()
	// mux.Handle(...) your own routes
	mux.Handle("/__ashurbanipal", viewer)
	mux.Handle("/__ashurbanipal/", viewer)

	log.Fatal(http.ListenAndServe(":3000", mux))
}
```

Open <http://localhost:3000/__ashurbanipal>.

## Turn it on only where you want it

`Enabled` defaults to `false`, so the zero `Config{}` is off and every viewer path returns 404. Decide where to enable it, for example from an environment variable:

```go
cfg := ashurbanipal.Config{Enabled: os.Getenv("ASHURBANIPAL_ENABLED") == "true"}
```

## Protect it

Ashurbanipal has no login. Anyone who can reach `/__ashurbanipal` can read every table your app's database user can read. Put your own auth in front, and check a role, not just a login:

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

Register both paths: the UI is served at the bare path, and the API under it. If you changed `BasePath`, use that path instead.

## MySQL, MariaDB, or SQLite

These backends are behind build tags, so a Postgres-only app doesn't compile their drivers. Add the tag to **your app's** build:

```sh
go build -tags sqlite ./...   # or -tags mysql, or -tags sqlite,mysql
```

SQLite uses the pure-Go `modernc.org/sqlite` driver:

```go
import _ "modernc.org/sqlite" // registers the "sqlite" driver

db, err := sql.Open("sqlite", "app.db")
source := ashurbanipal.NewSQLiteSource(db, cfg.Limits.WithDefaults().QueryTimeoutSecs)
```

MySQL and MariaDB use `github.com/go-sql-driver/mysql`. The `mysql` tag registers it for you. It takes a DSN, not a URL:

```go
db, err := sql.Open("mysql", "user:pass@tcp(localhost:3306)/app")
source := ashurbanipal.NewMySQLSource(db, cfg.Limits.WithDefaults().QueryTimeoutSecs)
```

Column comments and common-value stats are empty on MySQL and SQLite.

## More than one database

Pass more than one source. The first one is the default, and the UI lets you switch between them:

```go
viewer := ashurbanipal.Router(cfg, []ashurbanipal.NamedSource{
	{Name: "orders", Source: ordersSource},
	{Name: "billing", Source: billingSource},
})
```

## Configuration

There is no config file. Fill in the struct however you like, for example from flags or environment variables:

```go
cfg := ashurbanipal.Config{
	Enabled:  true,
	BasePath: "/__ashurbanipal", // optional; change the URL path
	Limits:   ashurbanipal.Limits{DefaultPageSize: 50, MaxPageSize: 100, QueryTimeoutSecs: 5}, // optional; the defaults
}
```

The [configuration table](https://github.com/mt-empty/ashurbanipal#configuration) lists every option, including `Instance` and `Siblings`. Those let the UI show which of your other services are reachable.

## See also

- [API reference on pkg.go.dev](https://pkg.go.dev/github.com/mt-empty/ashurbanipal/implementations/go-nethttp)
- [Live demo](https://mt-empty.github.io/ashurbanipal/demo/live/)

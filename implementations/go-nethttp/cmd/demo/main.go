// Command demo is the host-service usage example and conformance harness.
//
// Run against the devcontainer's seeded Postgres:
//
//	go run ./cmd/demo
//	# then open http://localhost:4000/__ashurbanipal
//
// To demo sibling health-polling, run a second instance:
//
//	PORT=4001 SIBLING_PORT=4000 go run ./cmd/demo
//
// DB_BACKEND picks the source: postgres (default, DATABASE_URL), mysql
// (MYSQL_URL, a mysql:// URL; MariaDB too) or sqlite (SQLITE_PATH). The last
// two need their build tag: go run -tags sqlite,mysql ./cmd/demo
//
// CONFORMANCE_SECOND_SOURCE=1 (postgres only) registers a second source,
// pinned to the other_schema schema via an AfterConnect hook, for
// conformance/runner/two_source.rs — see that file's module doc.
package main

import (
	"context"
	"database/sql"
	"fmt"
	"log"
	"net/http"
	"os"
	"strconv"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/stdlib"

	ashurbanipal "github.com/mt-empty/ashurbanipal/implementations/go-nethttp"
)

// backends maps DB_BACKEND to an opener; the tagged backend_*.go files add theirs.
var backends = map[string]func(timeout int) (ashurbanipal.DbSource, *sql.DB){
	"postgres": func(timeout int) (ashurbanipal.DbSource, *sql.DB) {
		db := openDB("pgx", requireEnv("DATABASE_URL", "postgres"))
		return ashurbanipal.NewPostgresSource(db, timeout), db
	},
}

func main() {
	port := envInt("PORT", 4000)
	backend := os.Getenv("DB_BACKEND")
	if backend == "" {
		backend = "postgres"
	}

	cfg := ashurbanipal.Config{
		Enabled: true,
	}
	if siblingPort, ok := os.LookupEnv("SIBLING_PORT"); ok {
		cfg.Siblings = []ashurbanipal.Sibling{{
			Name:       fmt.Sprintf("demo-%s", siblingPort),
			BaseURL:    fmt.Sprintf("http://localhost:%s/__ashurbanipal", siblingPort),
			HealthPath: "/health",
		}}
	}
	if os.Getenv("CONFORMANCE_LABELLED_SIBLINGS") != "" {
		cfg.Instance, cfg.Siblings = conformanceLabelledSiblings()
	}

	timeout := cfg.Limits.WithDefaults().QueryTimeoutSecs
	source, db := openSource(backend, timeout)
	defer db.Close()
	sources := []ashurbanipal.NamedSource{{Name: "primary", Source: source}}

	if os.Getenv("CONFORMANCE_SECOND_SOURCE") != "" && backend == "postgres" {
		connConfig, err := pgx.ParseConfig(requireEnv("DATABASE_URL", backend))
		if err != nil {
			log.Fatalf("parsing DATABASE_URL: %v", err)
		}
		connConfig.AfterConnect = func(ctx context.Context, pc *pgconn.PgConn) error {
			_, err := pc.Exec(ctx, "set search_path = other_schema").ReadAll()
			return err
		}
		connStr := stdlib.RegisterConnConfig(connConfig)
		secondaryDB, err := sql.Open("pgx", connStr)
		if err != nil {
			log.Fatalf("opening secondary database: %v", err)
		}
		defer secondaryDB.Close()
		secondaryDB.SetMaxOpenConns(5)
		sources = append(sources, ashurbanipal.NamedSource{
			Name:   "other_schema",
			Source: ashurbanipal.NewPostgresSource(secondaryDB, timeout),
		})
	}

	viewer := ashurbanipal.Router(cfg, sources)

	uiPath := "/__ashurbanipal"
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, uiPath, http.StatusTemporaryRedirect)
	})
	mux.Handle("/", viewer)

	addr := fmt.Sprintf("0.0.0.0:%d", port)
	log.Printf("demo host on http://localhost:%d — browser at http://localhost:%d%s", port, port, uiPath)
	log.Fatal(http.ListenAndServe(addr, mux))
}

// openSource opens the database DB_BACKEND names; the caller closes it.
func openSource(backend string, timeout int) (ashurbanipal.DbSource, *sql.DB) {
	open, ok := backends[backend]
	if !ok {
		log.Fatalf("DB_BACKEND %q is not built in (postgres always; mysql and sqlite need -tags mysql,sqlite)", backend)
	}
	return open(timeout)
}

func openDB(driver, dsn string) *sql.DB {
	db, err := sql.Open(driver, dsn)
	if err != nil {
		log.Fatalf("opening %s database: %v", driver, err)
	}
	db.SetMaxOpenConns(5)
	return db
}

func requireEnv(name, backend string) string {
	value := os.Getenv(name)
	if value == "" {
		log.Fatalf("%s must be set for DB_BACKEND=%s", name, backend)
	}
	return value
}

func envInt(name string, def int) int {
	raw, ok := os.LookupEnv(name)
	if !ok {
		return def
	}
	v, err := strconv.Atoi(raw)
	if err != nil {
		log.Fatalf("%s must be an integer, got %q", name, raw)
	}
	return v
}

// conformanceLabelledSiblings is the fixed config
// conformance/runner/labelled_siblings.rs expects. Port 9 refuses at once,
// so every health check is a fast healthy=false.
func conformanceLabelledSiblings() (*ashurbanipal.Instance, []ashurbanipal.Sibling) {
	const unreachable = "http://127.0.0.1:9/__ashurbanipal"
	return &ashurbanipal.Instance{Name: "conformance", Label: "a"}, []ashurbanipal.Sibling{
		{Name: "conformance", Label: "a", BaseURL: unreachable, HealthPath: "/health"},
		{Name: "conformance", Label: "b", BaseURL: unreachable, HealthPath: "/health"},
		{Name: "other", Label: "a", BaseURL: unreachable, HealthPath: "/health"},
		{Name: "other", Label: "a", BaseURL: unreachable, HealthPath: "/health"},
	}
}

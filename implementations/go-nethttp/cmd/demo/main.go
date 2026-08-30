// Command demo is the living usage example and conformance harness for
// the go-nethttp port — the host service embedding Ashurbanipal, mirroring
// implementations/rust/examples/demo.rs and the Spring Boot starter's
// integration test app.
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
// CONFORMANCE_SECOND_SOURCE=1 registers a second source, pinned to the
// other_schema schema via an AfterConnect hook, for
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

func main() {
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		log.Fatal("DATABASE_URL must be set (the devcontainer sets it automatically)")
	}
	port := envInt("PORT", 4000)

	db, err := sql.Open("pgx", databaseURL)
	if err != nil {
		log.Fatalf("opening database: %v", err)
	}
	defer db.Close()
	db.SetMaxOpenConns(5)

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

	timeout := cfg.Limits.WithDefaults().QueryTimeoutSecs
	source := ashurbanipal.NewPostgresSource(db, timeout)
	sources := []ashurbanipal.NamedSource{{Name: "primary", Source: source}}

	if os.Getenv("CONFORMANCE_SECOND_SOURCE") != "" {
		connConfig, err := pgx.ParseConfig(databaseURL)
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

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
package main

import (
	"database/sql"
	"fmt"
	"log"
	"net/http"
	"os"
	"strconv"

	_ "github.com/jackc/pgx/v5/stdlib"

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
		Environment: "dev",
		EnabledFor:  []string{"dev"},
	}
	if siblingPort, ok := os.LookupEnv("SIBLING_PORT"); ok {
		cfg.Siblings = []ashurbanipal.Sibling{{
			Name:        fmt.Sprintf("demo-%s", siblingPort),
			DBViewerURL: fmt.Sprintf("http://localhost:%s/__ashurbanipal", siblingPort),
			HealthPath:  "/health",
		}}
	}

	// Router returns a non-nil error for a production-like EnabledFor
	// value (spec/protocol.md §4) — the fail-closed guarantee is only
	// real if a host's own startup actually observes and acts on it, so
	// this demo does exactly what a real host must: check the error and
	// refuse to start rather than silently swallowing it.
	viewer, err := ashurbanipal.Router(cfg, db)
	if err != nil {
		log.Fatalf("ashurbanipal.Router: %v", err)
	}

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

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
		Enabled: true,
	}
	if siblingPort, ok := os.LookupEnv("SIBLING_PORT"); ok {
		cfg.Siblings = []ashurbanipal.Sibling{{
			Name:        fmt.Sprintf("demo-%s", siblingPort),
			DBViewerURL: fmt.Sprintf("http://localhost:%s/__ashurbanipal", siblingPort),
			HealthPath:  "/health",
		}}
	}

	source := ashurbanipal.NewPostgresSource(db, cfg.Limits.WithDefaults().QueryTimeoutSecs)
	viewer := ashurbanipal.Router(cfg, []ashurbanipal.NamedSource{{Name: "primary", Source: source}})

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

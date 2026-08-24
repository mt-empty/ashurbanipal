package ashurbanipal

import (
	"context"
	"database/sql"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/stdlib"
)

// DB-backed coverage of resolveSource/api/sources against the
// devcontainer's seeded Postgres. Distinct from integration_test.go's
// shared single-source server: telling "which source did this request
// actually hit" apart requires at least two sources with genuinely
// different table sets, so this file builds its own two-source Router(...)
// once, lazily, and shares it across the tests below.
//
// "primary" is the default search_path (schema public — 15 seeded
// tables). "secondary" is a second pool whose connections pin
// search_path to other_schema (schema_integration_test.go confirms it
// holds exactly one table, decoy_items) — chosen because it's already
// part of the seed data, so no extra fixture setup is needed.

var (
	sourceServerOnce sync.Once
	sourceServerURL  string
)

func sourceTestServer(t *testing.T) string {
	t.Helper()
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		t.Skip("DATABASE_URL not set (the devcontainer sets it automatically)")
	}
	// Deliberately never closed: the server and its two pools must outlive
	// every individual test function that shares them, so they're left to
	// the test binary's own process exit rather than scoped to whichever
	// test happens to trigger sync.Once first (a t.Cleanup here would tie
	// their lifetime to that one test, killing the server out from under
	// every test that runs after it — the same hazard integration_test.go's
	// doc comment on TestMain calls out for the single-source case).
	sourceServerOnce.Do(func() {
		cfg := Config{Enabled: true}
		timeout := cfg.Limits.WithDefaults().QueryTimeoutSecs

		primaryDB, err := sql.Open("pgx", databaseURL)
		if err != nil {
			t.Fatalf("opening primary database: %v", err)
		}

		connConfig, err := pgx.ParseConfig(databaseURL)
		if err != nil {
			t.Fatalf("parsing DATABASE_URL: %v", err)
		}
		connConfig.AfterConnect = func(ctx context.Context, pc *pgconn.PgConn) error {
			_, err := pc.Exec(ctx, "set search_path = other_schema").ReadAll()
			return err
		}
		connStr := stdlib.RegisterConnConfig(connConfig)
		secondaryDB, err := sql.Open("pgx", connStr)
		if err != nil {
			t.Fatalf("opening secondary database: %v", err)
		}

		sources := []NamedSource{
			{Name: "primary", Source: NewPostgresSource(primaryDB, timeout)},
			{Name: "secondary", Source: NewPostgresSource(secondaryDB, timeout)},
		}
		srv := httptest.NewServer(Router(cfg, sources))
		sourceServerURL = srv.URL
	})
	if sourceServerURL == "" {
		t.Skip("source test server failed to start")
	}
	return sourceServerURL
}

func TestSourcesEndpointListsRegisteredNamesInOrder(t *testing.T) {
	body := getJSON(t, sourceTestServer(t), "/api/sources")
	sources, _ := body["sources"].([]interface{})
	if len(sources) != 2 {
		t.Fatalf("got %d sources, want 2: %v", len(sources), sources)
	}
	want := []string{"primary", "secondary"}
	for i, s := range sources {
		name := s.(map[string]interface{})["name"]
		if name != want[i] {
			t.Errorf("source[%d].name = %v, want %q", i, name, want[i])
		}
	}
}

func TestOmittedSourceResolvesToFirstRegistered(t *testing.T) {
	base := sourceTestServer(t)
	implicit := getJSON(t, base, "/api/tables")
	explicitPrimary := getJSON(t, base, "/api/tables?source=primary")
	implicitTables, _ := implicit["tables"].([]interface{})
	primaryTables, _ := explicitPrimary["tables"].([]interface{})
	if len(implicitTables) != len(primaryTables) || len(implicitTables) == 0 {
		t.Fatalf("implicit %v tables, source=primary %v tables", implicitTables, primaryTables)
	}
	for i := range implicitTables {
		if implicitTables[i].(map[string]interface{})["name"] != primaryTables[i].(map[string]interface{})["name"] {
			t.Errorf("table[%d]: implicit %v != source=primary %v", i, implicitTables[i], primaryTables[i])
		}
	}

	secondary := getJSON(t, base, "/api/tables?source=secondary")
	secondaryTables, _ := secondary["tables"].([]interface{})
	if len(secondaryTables) != 1 || secondaryTables[0].(map[string]interface{})["name"] != "decoy_items" {
		t.Errorf("source=secondary tables = %v, want exactly [decoy_items]", secondaryTables)
	}

	if len(implicitTables) == len(secondaryTables) {
		t.Fatal("implicit source and source=secondary returned the same table count — test fixture isn't distinguishing sources")
	}
}

func TestUnrecognizedSourceIsRejectedWith400OnEverySourceAwareRoute(t *testing.T) {
	base := sourceTestServer(t)
	evilValues := []string{"", "nonexistent_source", `primary"; drop schema public cascade; --`, "primary' OR '1'='1"}
	for _, evil := range evilValues {
		q := url.QueryEscape(evil)
		paths := []string{
			"/api/schemas?source=" + q,
			"/api/tables?source=" + q,
			"/api/table-counts?source=" + q,
			"/api/tables/data?source=" + q + "&table=users",
			"/api/tables/common-values?source=" + q + "&table=users&column=email",
		}
		for _, path := range paths {
			resp, err := http.Get(base + "/__ashurbanipal" + path)
			if err != nil {
				t.Fatalf("GET %s: %v", path, err)
			}
			resp.Body.Close()
			if resp.StatusCode != http.StatusBadRequest {
				t.Errorf("GET %s: status %d, want 400", path, resp.StatusCode)
			}
		}
	}
}

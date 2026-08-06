package ashurbanipal

import (
	"context"
	"database/sql"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/stdlib"
)

// DB-backed coverage of resolveSchema against the devcontainer's seeded
// Postgres (schemas: public, other_schema, warehouse — see
// .devcontainer/db/init/01-seed.sql). Reuses the shared server built once
// in TestMain (see integration_test.go) rather than booting its own.

func TestListSchemasExcludesSystemNamespaces(t *testing.T) {
	body := getJSON(t, testServer(t), "/api/schemas")
	schemas, _ := body["schemas"].([]interface{})
	want := map[string]bool{"public": true, "other_schema": true, "warehouse": true}
	seen := map[string]bool{}
	for _, s := range schemas {
		name := s.(string)
		seen[name] = true
		if name == "pg_catalog" || name == "information_schema" || len(name) >= 3 && name[:3] == "pg_" {
			t.Errorf("system namespace %q leaked into /api/schemas", name)
		}
	}
	for name := range want {
		if !seen[name] {
			t.Errorf("expected schema %q not found in %v", name, schemas)
		}
	}
}

func TestExplicitSchemaPublicMatchesImplicitDefault(t *testing.T) {
	base := testServer(t)
	implicit := getJSON(t, base, "/api/tables")
	explicit := getJSON(t, base, "/api/tables?schema=public")
	implicitTables, _ := implicit["tables"].([]interface{})
	explicitTables, _ := explicit["tables"].([]interface{})
	if len(implicitTables) != len(explicitTables) || len(implicitTables) == 0 {
		t.Fatalf("implicit %v tables, explicit %v tables", implicitTables, explicitTables)
	}
	for i := range implicitTables {
		if implicitTables[i].(map[string]interface{})["name"] != explicitTables[i].(map[string]interface{})["name"] {
			t.Errorf("table[%d]: implicit %v != explicit %v", i, implicitTables[i], explicitTables[i])
		}
	}
}

func TestExplicitOtherSchemaSelectsOnlyItsOwnTables(t *testing.T) {
	body := getJSON(t, testServer(t), "/api/tables?schema=other_schema")
	tables, _ := body["tables"].([]interface{})
	if len(tables) != 1 || tables[0].(map[string]interface{})["name"] != "decoy_items" {
		t.Errorf("got tables %v, want exactly [decoy_items]", tables)
	}
}

func TestUnrecognizedSchemaIsRejectedWith400OnEverySchemaAwareRoute(t *testing.T) {
	base := testServer(t)
	evilValues := []string{"", "nonexistent_schema", `public"; drop schema public cascade; --`, "public' OR '1'='1"}
	for _, evil := range evilValues {
		q := url.QueryEscape(evil)
		paths := []string{
			"/api/tables?schema=" + q,
			"/api/table-counts?schema=" + q,
			"/api/tables/data?schema=" + q + "&table=users",
			"/api/tables/common-values?schema=" + q + "&table=users&column=email",
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

func TestCrossSchemaFKReferenceIncludesReferencedTablesSchema(t *testing.T) {
	body := getJSON(t, testServer(t), "/api/tables/data?schema=warehouse&table=shipments&limit=1")
	columns, _ := body["columns"].([]interface{})
	for _, c := range columns {
		col := c.(map[string]interface{})
		if col["name"] != "order_id" {
			continue
		}
		if col["key"] != "fk" {
			t.Fatalf("order_id key = %v, want fk", col["key"])
		}
		ref, _ := col["references"].(map[string]interface{})
		if ref["table"] != "orders" || ref["schema"] != "public" {
			t.Errorf("order_id references = %v, want {table: orders, schema: public}", ref)
		}
		return
	}
	t.Fatal("order_id column not found")
}

func TestSameSchemaFKReferenceOmitsSchemaField(t *testing.T) {
	body := getJSON(t, testServer(t), "/api/tables/data?table=orders&limit=1")
	columns, _ := body["columns"].([]interface{})
	for _, c := range columns {
		col := c.(map[string]interface{})
		if col["name"] != "user_id" {
			continue
		}
		ref, _ := col["references"].(map[string]interface{})
		if _, ok := ref["schema"]; ok {
			t.Errorf("user_id references.schema = %v, want absent", ref["schema"])
		}
		return
	}
	t.Fatal("user_id column not found")
}

const (
	schemaIsolationSchemaA = "ashb_test_schema_isolation_a"
	schemaIsolationSchemaB = "ashb_test_schema_isolation_b"
)

func mustExecIsolation(t *testing.T, db *sql.DB, stmt string) {
	t.Helper()
	if _, err := db.Exec(stmt); err != nil {
		t.Fatalf("exec %q: %v", stmt, err)
	}
}

// Regression test for the "connection pool sessions with different
// search_path settings must not let a request's schema resolution drift
// mid-flight" guarantee (spec/protocol.md §1, §5) — Go equivalent of
// implementations/rust/tests/schema_isolation.rs's
// query_table_never_mixes_schemas_across_pooled_connections.
//
// Builds its own 2-connection pool (separate from TestMain's shared one)
// whose physical connections alternate search_path between two schemas
// that each hold a same-named probe table with a different column shape.
// QueryTable resolves+validates the schema and later selects columns from
// it inside one BeginTx (catalog.go's resolveSchema doc comment) — if those
// steps could ever land on different pooled connections, a response would
// mix shapes/values across schemas or fail outright.
func TestQueryTableNeverMixesSchemasAcrossPooledConnections(t *testing.T) {
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		t.Skip("DATABASE_URL not set (the devcontainer sets it automatically)")
	}

	setupDB, err := sql.Open("pgx", databaseURL)
	if err != nil {
		t.Fatalf("opening setup connection: %v", err)
	}
	defer setupDB.Close()

	for _, schema := range []string{schemaIsolationSchemaA, schemaIsolationSchemaB} {
		mustExecIsolation(t, setupDB, fmt.Sprintf("drop schema if exists %s cascade", schema))
		mustExecIsolation(t, setupDB, fmt.Sprintf("create schema %s", schema))
	}
	mustExecIsolation(t, setupDB, fmt.Sprintf("create table %s.probe_isolation (id int primary key, marker text)", schemaIsolationSchemaA))
	mustExecIsolation(t, setupDB, fmt.Sprintf("insert into %s.probe_isolation values (1, 'A'), (2, 'A')", schemaIsolationSchemaA))
	mustExecIsolation(t, setupDB, fmt.Sprintf("create table %s.probe_isolation (id int primary key, marker text, extra text)", schemaIsolationSchemaB))
	mustExecIsolation(t, setupDB, fmt.Sprintf("insert into %s.probe_isolation values (1, 'B', 'X'), (2, 'B', 'X')", schemaIsolationSchemaB))
	t.Cleanup(func() {
		for _, schema := range []string{schemaIsolationSchemaA, schemaIsolationSchemaB} {
			setupDB.Exec(fmt.Sprintf("drop schema if exists %s cascade", schema))
		}
	})

	// Alternates each newly-opened physical connection's search_path
	// between the two schemas, simulating a host pool whose sessions don't
	// all agree on which schema current_schema() resolves to.
	connConfig, err := pgx.ParseConfig(databaseURL)
	if err != nil {
		t.Fatalf("parsing DATABASE_URL: %v", err)
	}
	var connCount int64
	connConfig.AfterConnect = func(ctx context.Context, pc *pgconn.PgConn) error {
		n := atomic.AddInt64(&connCount, 1) - 1
		schema := schemaIsolationSchemaA
		if n%2 != 0 {
			schema = schemaIsolationSchemaB
		}
		_, err := pc.Exec(ctx, fmt.Sprintf("set search_path = %s", schema)).ReadAll()
		return err
	}
	connStr := stdlib.RegisterConnConfig(connConfig)
	defer stdlib.UnregisterConnConfig(connStr)

	db, err := sql.Open("pgx", connStr)
	if err != nil {
		t.Fatalf("opening pool under test: %v", err)
	}
	defer db.Close()
	db.SetMaxOpenConns(2)
	db.SetMaxIdleConns(2)

	// Acquire both connections while both are still checked out (neither
	// idle yet), forcing the pool to dial two distinct physical
	// connections; only then release them both back to the idle set, so
	// both schemas are represented once the concurrent calls below begin.
	ctx := context.Background()
	c1, err := db.Conn(ctx)
	if err != nil {
		t.Fatalf("acquiring conn 1: %v", err)
	}
	c2, err := db.Conn(ctx)
	if err != nil {
		t.Fatalf("acquiring conn 2: %v", err)
	}
	c1.Close()
	c2.Close()

	catalog := newCatalog(db, 5)
	opts := QueryOpts{Limit: 10, Offset: 0, Descending: false}

	var wg sync.WaitGroup
	errs := make(chan error, 40)
	for i := 0; i < 40; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			data, err := catalog.QueryTable(ctx, nil, "probe_isolation", opts)
			if err != nil {
				errs <- fmt.Errorf("query_table must not error from a mid-request schema drift: %w", err)
				return
			}
			names := make([]string, len(data.Columns))
			for i, c := range data.Columns {
				names[i] = c.Name
			}
			switch {
			case len(names) == 2 && names[0] == "id" && names[1] == "marker":
				for _, row := range data.Rows {
					if row["marker"] == nil || *row["marker"] != "A" {
						errs <- fmt.Errorf("schema_a shape must only ever contain schema_a's rows, got %v", row["marker"])
					}
				}
			case len(names) == 3 && names[0] == "id" && names[1] == "marker" && names[2] == "extra":
				for _, row := range data.Rows {
					if row["marker"] == nil || *row["marker"] != "B" {
						errs <- fmt.Errorf("schema_b shape must only ever contain schema_b's rows, got %v", row["marker"])
					}
					if row["extra"] == nil || *row["extra"] != "X" {
						errs <- fmt.Errorf("schema_b shape must carry extra=X, got %v", row["extra"])
					}
				}
			default:
				errs <- fmt.Errorf("response mixed columns from both schemas — mid-request schema drift: %v", names)
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Error(err)
	}
}

package ashurbanipal

import (
	"database/sql"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"
	"testing"

	_ "github.com/jackc/pgx/v5/stdlib"
)

// Regression tests for spec/protocol.md §5.10 against Postgres catalog
// quirks: partitioned tables (parent rejected, child reports its own copies)
// and index shapes (INCLUDE columns, expression entries). Each test uses its
// own schema so they cannot race each other's "create schema".

func setupSchemaDDL(t *testing.T, schema, ddl string) {
	t.Helper()
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		t.Skip("DATABASE_URL not set (the devcontainer sets it automatically)")
	}
	db, err := sql.Open("pgx", databaseURL)
	if err != nil {
		t.Fatalf("opening admin connection: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	if _, err := db.Exec(fmt.Sprintf("drop schema if exists %[1]s cascade; create schema %[1]s; ", schema) + ddl); err != nil {
		t.Fatalf("setup schema: %v", err)
	}
	t.Cleanup(func() { db.Exec(fmt.Sprintf("drop schema if exists %s cascade", schema)) })
}

func TestStructureRejectsPartitionedParentAndChildReportsItsOwnCopies(t *testing.T) {
	const schema = "ashb_test_go_structure_partitions"
	setupSchemaDDL(t, schema, fmt.Sprintf(
		`create table %[1]s.users (id int primary key);
		 create table %[1]s.events (
		     id bigint not null,
		     user_id int references %[1]s.users(id)
		 ) partition by range (id);
		 create index events_user_idx on %[1]s.events (user_id);
		 create table %[1]s.events_p1 partition of %[1]s.events for values from (1) to (1000);`, schema))
	srv := testServer(t)

	resp, err := http.Get(srv + "/__ashurbanipal/api/tables/structure?schema=" + url.QueryEscape(schema) + "&table=events")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("partitioned parent: status %d, want 400", resp.StatusCode)
	}

	body := getJSON(t, srv, "/api/tables/structure?schema="+url.QueryEscape(schema)+"&table=events_p1")
	idx, _ := body["indexes"].([]interface{})
	foundIndex := false
	for _, i := range idx {
		cols, _ := i.(map[string]interface{})["columns"].([]interface{})
		if len(cols) == 1 && cols[0] == "user_id" {
			foundIndex = true
		}
	}
	if !foundIndex {
		t.Errorf("child must report its own inherited index: %+v", idx)
	}
	fks, _ := body["constraints"].(map[string]interface{})["foreign_keys"].([]interface{})
	if len(fks) != 1 || fks[0].(map[string]interface{})["table"] != "users" {
		t.Errorf("child must report its inherited FK to users: %+v", fks)
	}
}

func TestStructureIndexColumnsExcludeIncludeAndKeepExpressionEntries(t *testing.T) {
	const schema = "ashb_test_go_structure_indexes"
	setupSchemaDDL(t, schema, fmt.Sprintf(
		`create table %[1]s.items (id int primary key, email text, a int, b int, status text);
		 create index items_cover_idx on %[1]s.items (a) include (b);
		 create index items_expr_only_idx on %[1]s.items (lower(email));
		 create index items_mixed_idx on %[1]s.items (lower(email), a);
		 create index items_partial_idx on %[1]s.items (a) where status = 'open';`, schema))

	body := getJSON(t, testServer(t), "/api/tables/structure?schema="+url.QueryEscape(schema)+"&table=items")
	byName := map[string]map[string]interface{}{}
	for _, i := range body["indexes"].([]interface{}) {
		m := i.(map[string]interface{})
		byName[m["name"].(string)] = m
	}
	cols := func(name string) []interface{} {
		idx, ok := byName[name]
		if !ok {
			t.Fatalf("index %s missing: %+v", name, byName)
		}
		return idx["columns"].([]interface{})
	}
	if c := cols("items_cover_idx"); len(c) != 1 || c[0] != "a" {
		t.Errorf("INCLUDE column leaked: %v", c)
	}
	if c := cols("items_expr_only_idx"); len(c) != 1 || !strings.Contains(c[0].(string), "lower") {
		t.Errorf("expression-only index must keep its entry: %v", c)
	}
	if c := cols("items_mixed_idx"); len(c) != 2 || !strings.Contains(c[0].(string), "lower") || c[1] != "a" {
		t.Errorf("expression entry must keep its position: %v", c)
	}
	if p, _ := byName["items_partial_idx"]["predicate"].(string); !strings.Contains(p, "open") {
		t.Errorf("partial index predicate = %q", p)
	}
	if _, has := byName["items_cover_idx"]["predicate"]; has {
		t.Errorf("non-partial index must omit predicate")
	}
}

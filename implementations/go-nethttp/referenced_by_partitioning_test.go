package ashurbanipal

import (
	"database/sql"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"testing"

	_ "github.com/jackc/pgx/v5/stdlib"
)

// Regression tests for spec/protocol.md §5.9 on partitioned tables: Postgres
// copies an inherited FK constraint onto every partition, and ListTables'
// information_schema gate is broader than the relkind = 'r' filter §5.2
// (and so §5.9's own table-gate) is meant to enforce. Each test creates its
// own schema — disjoint names, since Go tests in one file may run in
// parallel with each other via t.Parallel elsewhere in the package, and a
// shared schema would race two "create schema" calls.

func setupPartitionedSchema(t *testing.T, schema string) {
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

	// events is range-partitioned with two partitions and one FK to users;
	// Postgres inherits that constraint onto each partition, so
	// pg_constraint holds three rows (parent + 2 children) for what is, to
	// the API, a single relationship.
	if _, err := db.Exec(fmt.Sprintf(
		`drop schema if exists %[1]s cascade;
		 create schema %[1]s;
		 create table %[1]s.users (id int primary key);
		 create table %[1]s.events (
		     id bigint not null,
		     user_id int references %[1]s.users(id)
		 ) partition by range (id);
		 create table %[1]s.events_p1 partition of %[1]s.events for values from (1) to (1000);
		 create table %[1]s.events_p2 partition of %[1]s.events for values from (1000) to (2000);`,
		schema)); err != nil {
		t.Fatalf("setup schema: %v", err)
	}
	t.Cleanup(func() {
		if _, err := db.Exec(fmt.Sprintf("drop schema if exists %s cascade", schema)); err != nil {
			t.Logf("cleanup: drop schema %s: %v", schema, err)
		}
	})
}

func TestReferencedByExcludesPartitionedReferrerAndItsPartitionCopies(t *testing.T) {
	// Two predicates do independent work here: conparentid = 0 collapses
	// events_p1/events_p2's inherited constraint copies onto the parent
	// (else one logical FK fans out into one entry per partition); rc.relkind
	// = 'r' then drops that parent too, since events itself is relkind = 'p'
	// and every other endpoint (query_table, common_values, referenced_by-
	// as-target) already rejects it as NotAllowed the same way an unlisted
	// table is rejected. A referrer name the frontend can't drill into is
	// worse than not reporting it. Asserting zero rather than one keeps both
	// predicates covered: losing either one reintroduces an events* entry.
	const schema = "ashb_test_go_referenced_by_partitioning_dup"
	setupPartitionedSchema(t, schema)

	path := "/api/tables/referenced-by?schema=" + url.QueryEscape(schema) + "&table=users"
	body := getJSON(t, testServer(t), path)
	raw, _ := body["referenced_by"].([]interface{})
	var events []map[string]interface{}
	for _, e := range raw {
		m := e.(map[string]interface{})
		if name, _ := m["table"].(string); name == "events" || name == "events_p1" || name == "events_p2" {
			events = append(events, m)
		}
	}
	if len(events) != 0 {
		t.Fatalf("a partitioned referrer must be excluded entirely, got %d entries: %+v", len(events), events)
	}
}

func TestReferencedByRejectsPartitionedTableAsTargetSameAsAnyUnlistedTable(t *testing.T) {
	const schema = "ashb_test_go_referenced_by_partitioning_gate"
	setupPartitionedSchema(t, schema)

	// spec/protocol.md §5.9 requires table to match a §5.2 (list_tables)
	// entry, and list_tables' relkind = 'r' filter excludes partitioned
	// tables — so this must reject the same way an unknown table name
	// does, not silently answer [].
	path := "/api/tables/referenced-by?schema=" + url.QueryEscape(schema) + "&table=events"
	resp, err := http.Get(testServer(t) + "/__ashurbanipal" + path)
	if err != nil {
		t.Fatalf("GET %s: %v", path, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("GET %s: status %d, want 400 (partitioned table rejected as NotAllowed)", path, resp.StatusCode)
	}
}

func TestQueryTableRejectsPartitionedTableSameAsReferencedByDoes(t *testing.T) {
	const schema = "ashb_test_go_query_table_partitioning_gate"
	setupPartitionedSchema(t, schema)

	// allowedTables gates table via list_tables' own relkind = 'r'
	// predicate — a partitioned table must reject the same way
	// ReferencedBy already does.
	path := "/api/tables/data?schema=" + url.QueryEscape(schema) + "&table=events"
	resp, err := http.Get(testServer(t) + "/__ashurbanipal" + path)
	if err != nil {
		t.Fatalf("GET %s: %v", path, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("GET %s: status %d, want 400 (partitioned table rejected as NotAllowed)", path, resp.StatusCode)
	}
}

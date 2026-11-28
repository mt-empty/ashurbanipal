package ashurbanipal

import (
	"database/sql"
	"math"
	"net/url"
	"strings"
	"testing"

	_ "github.com/jackc/pgx/v5/stdlib"
)

// A plain select on a table with inheritance children returns their rows too,
// so its row estimate, keys and common values must describe those rows.
func TestInheritanceParentDescribesItsChildrensRowsToo(t *testing.T) {
	const schema = "ashb_test_go_inheritance_parent"
	databaseURL := requireTestEnv(t, "DATABASE_URL")
	db, err := sql.Open("pgx", databaseURL)
	if err != nil {
		t.Fatalf("opening admin connection: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	exec := func(stmt string) {
		t.Helper()
		if _, err := db.Exec(strings.ReplaceAll(stmt, "$s", schema)); err != nil {
			t.Fatalf("%s: %v", stmt, err)
		}
	}
	// Three levels: tickets (30 rows: open/pending/closed), tickets_archive
	// (70: archived/closed) and tickets_purged (20: purged). Ids repeat across
	// them, so the parent's primary key does not hold. Autovacuum is off so
	// each table's statistics change only when the test analyzes it.
	exec(`drop schema if exists $s cascade;
		 create schema $s;
		 create table $s.tickets (id int primary key, status text not null)
		     with (autovacuum_enabled = false);
		 create table $s.tickets_archive (id int not null, status text not null)
		     with (autovacuum_enabled = false);
		 create table $s.tickets_purged () inherits ($s.tickets_archive)
		     with (autovacuum_enabled = false);
		 create table $s.lone (id int primary key);
		 insert into $s.tickets
		     select g, (array['open','pending','closed'])[g % 3 + 1] from generate_series(1, 30) g;
		 insert into $s.tickets_archive
		     select g, (array['archived','closed'])[g % 2 + 1] from generate_series(1, 70) g;
		 insert into $s.tickets_purged select g, 'purged' from generate_series(1, 20) g;`)
	t.Cleanup(func() {
		if _, err := db.Exec("drop schema if exists " + schema + " cascade"); err != nil {
			t.Logf("cleanup: drop schema %s: %v", schema, err)
		}
	})
	srv := testServer(t)
	q := "schema=" + url.QueryEscape(schema)
	estimates := func() (float64, map[string]float64) {
		t.Helper()
		total := getJSON(t, srv, "/api/tables/data?"+q+"&table=tickets")["total_approx"].(float64)
		counts := map[string]float64{}
		for _, c := range getJSON(t, srv, "/api/table-counts?"+q)["counts"].([]interface{}) {
			m := c.(map[string]interface{})
			counts[m["table"].(string)] = m["approx_rows"].(float64)
		}
		return total, counts
	}

	// The parent is analyzed while it has no children, so it has only its own
	// statistics row; then the archive (and its child) is attached.
	exec(`analyze $s.tickets; alter table $s.tickets_archive inherit $s.tickets;`)
	total, counts := estimates()
	if total != 30 || counts["tickets_archive"] != -1 {
		t.Errorf("before the children are analyzed: got total %v and archive %v, want 30 (they add nothing) and -1", total, counts["tickets_archive"])
	}
	if got := commonValues(t, srv, q+"&table=tickets&column=status"); len(got) != 0 {
		t.Errorf("no with-children statistics row yet: got %v, want no common values", got)
	}

	exec(`analyze $s.tickets; analyze $s.tickets_archive; analyze $s.tickets_purged;`)
	data := getJSON(t, srv, "/api/tables/data?"+q+"&table=tickets&limit=100")
	rest := getJSON(t, srv, "/api/tables/data?"+q+"&table=tickets&limit=100&offset=100")
	if n := len(data["rows"].([]interface{})) + len(rest["rows"].([]interface{})); n != 120 {
		t.Errorf("rows: got %d, want all three levels' 120", n)
	}
	if key := columnKey(data, "id"); key != nil {
		t.Errorf("tickets.id key: got %v, want none: the parent's primary key does not hold over its children", key)
	}
	lone := getJSON(t, srv, "/api/tables/data?"+q+"&table=lone")
	if key := columnKey(lone, "id"); key != "pk" {
		t.Errorf("lone.id key: got %v, want pk", key)
	}
	total, counts = estimates()
	if total != 120 || counts["tickets"] != 120 || counts["tickets_archive"] != 90 || counts["tickets_purged"] != 20 {
		t.Errorf("estimates: got total %v and counts %v, want every descendant summed", total, counts)
	}

	parent := commonValues(t, srv, q+"&table=tickets&column=status")
	if len(parent) != 5 || math.Abs(parent["closed"]-0.375) > 0.001 {
		t.Errorf("parent common values: got %v, want every level's 5 values, closed 0.375", parent)
	}
	if got := commonValues(t, srv, q+"&table=tickets_purged&column=status"); len(got) != 1 {
		t.Errorf("grandchild common values: got %v, want purged only", got)
	}
}

func columnKey(data map[string]interface{}, name string) interface{} {
	for _, c := range data["columns"].([]interface{}) {
		m := c.(map[string]interface{})
		if m["name"] == name {
			return m["key"]
		}
	}
	return nil
}

func commonValues(t *testing.T, srv, query string) map[string]float64 {
	t.Helper()
	out := map[string]float64{}
	values, _ := getJSON(t, srv, "/api/tables/common-values?"+query)["values"].([]interface{})
	for _, v := range values {
		m := v.(map[string]interface{})
		out[m["value"].(string)] = m["freq"].(float64)
	}
	return out
}

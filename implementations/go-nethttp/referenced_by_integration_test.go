package ashurbanipal

import (
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"testing"
)

// GET /api/tables/referenced-by (spec/protocol.md §5.9) against the
// devcontainer's live Postgres with conformance/seed/seed.sql. Mirrors the
// Rust P5.9-* conformance checks (conformance/runner/referenced_by.rs):
// public.users is referenced by several tables incl. cross-schema
// warehouse.shipment_events; inventory_locations by exactly one composite
// FK; feature_flags by nothing. Presence-based for users, since its exact
// referrer set is large.

func referencedBy(t *testing.T, table string) []map[string]interface{} {
	t.Helper()
	body := getJSON(t, testServer(t), "/api/tables/referenced-by?table="+url.QueryEscape(table))
	raw, _ := body["referenced_by"].([]interface{})
	out := make([]map[string]interface{}, 0, len(raw))
	for _, e := range raw {
		out = append(out, e.(map[string]interface{}))
	}
	return out
}

func entriesFor(entries []map[string]interface{}, table string) []map[string]interface{} {
	var out []map[string]interface{}
	for _, e := range entries {
		if e["table"] == table {
			out = append(out, e)
		}
	}
	return out
}

// onlyPair asserts the entry carries exactly one {from, to} pair and returns it.
func onlyPair(t *testing.T, entry map[string]interface{}) (string, string) {
	t.Helper()
	cols, _ := entry["columns"].([]interface{})
	if len(cols) != 1 {
		t.Fatalf("expected exactly one column pair, got %v", entry["columns"])
	}
	c := cols[0].(map[string]interface{})
	return c["from"].(string), c["to"].(string)
}

func TestReferencedByListsIncomingFKConstraintsWithExplicitColumnPairs(t *testing.T) {
	entries := referencedBy(t, "users")

	orders := entriesFor(entries, "orders")
	if len(orders) != 1 {
		t.Fatalf("expected exactly one orders entry, got %d", len(orders))
	}
	if from, to := onlyPair(t, orders[0]); from != "user_id" || to != "id" {
		t.Errorf("orders pair = {%s, %s}, want {user_id, id}", from, to)
	}
	if s, _ := orders[0]["constraint"].(string); s == "" {
		t.Error("orders entry has an empty constraint")
	}
	if _, present := orders[0]["schema"]; present {
		t.Error("a same-schema referrer must omit schema")
	}

	// support_tickets has two separate FKs into users -> two entries.
	tickets := entriesFor(entries, "support_tickets")
	if len(tickets) != 2 {
		t.Fatalf("expected two support_tickets entries, got %d", len(tickets))
	}
	gotPairs := map[string]bool{}
	for _, e := range tickets {
		from, to := onlyPair(t, e)
		gotPairs[from+"->"+to] = true
		if _, present := e["schema"]; present {
			t.Error("support_tickets referrer must omit schema")
		}
	}
	if !gotPairs["user_id->id"] || !gotPairs["assigned_admin_id->id"] {
		t.Errorf("support_tickets pairs = %v, want user_id->id and assigned_admin_id->id", gotPairs)
	}

	// (table, constraint) is unique within one response.
	seen := map[string]bool{}
	for _, e := range entries {
		key := e["table"].(string) + "\x00" + e["constraint"].(string)
		if seen[key] {
			t.Errorf("duplicate (table, constraint): %s", key)
		}
		seen[key] = true
	}
}

func TestReferencedByIncludesCompositeForeignKeysWithEveryColumnPair(t *testing.T) {
	entries := referencedBy(t, "inventory_locations")
	if len(entries) != 1 {
		t.Fatalf("inventory_locations has exactly one referrer, got %d: %v", len(entries), entries)
	}
	e := entries[0]
	if e["table"] != "inventory_counts" {
		t.Errorf("referrer table = %v, want inventory_counts", e["table"])
	}
	cols, _ := e["columns"].([]interface{})
	var pairs [][2]string
	for _, c := range cols {
		m := c.(map[string]interface{})
		pairs = append(pairs, [2]string{m["from"].(string), m["to"].(string)})
	}
	want := [][2]string{{"warehouse_code", "warehouse_code"}, {"bin_code", "bin_code"}}
	if len(pairs) != len(want) {
		t.Fatalf("column pairs = %v, want %v", pairs, want)
	}
	for i := range want {
		if pairs[i] != want[i] {
			t.Errorf("column pair %d = %v, want %v (constraint order)", i, pairs[i], want[i])
		}
	}
}

func TestReferencedByReturnsEmptyListWhenNothingReferencesTheTable(t *testing.T) {
	if entries := referencedBy(t, "feature_flags"); len(entries) != 0 {
		t.Errorf("referenced_by(feature_flags) = %v, want []", entries)
	}
}

func TestReferencedByCarriesSchemaForCrossSchemaReferrers(t *testing.T) {
	se := entriesFor(referencedBy(t, "users"), "shipment_events")
	if len(se) != 1 {
		t.Fatalf("expected one shipment_events entry, got %d", len(se))
	}
	if se[0]["schema"] != "warehouse" {
		t.Errorf("shipment_events schema = %v, want warehouse", se[0]["schema"])
	}
	if from, to := onlyPair(t, se[0]); from != "handled_by_user_id" || to != "id" {
		t.Errorf("shipment_events pair = {%s, %s}, want {handled_by_user_id, id}", from, to)
	}
}

func TestReferencedByExplicitPublicSchemaMatchesImplicitDefault(t *testing.T) {
	implicit := getJSON(t, testServer(t), "/api/tables/referenced-by?table=users")
	explicit := getJSON(t, testServer(t), "/api/tables/referenced-by?schema=public&table=users")
	a, _ := json.Marshal(implicit["referenced_by"])
	b, _ := json.Marshal(explicit["referenced_by"])
	if string(a) != string(b) {
		t.Errorf("explicit schema=public differs from implicit:\n%s\n%s", a, b)
	}
}

func TestReferencedByRejectsUnknownOrMaliciousInputCleanly(t *testing.T) {
	base := testServer(t)
	bad := []string{
		"/api/tables/referenced-by?table=" + url.QueryEscape(""),
		"/api/tables/referenced-by?table=" + url.QueryEscape("no_such_table"),
		"/api/tables/referenced-by?table=" + url.QueryEscape(`users"; drop table users; --`),
		"/api/tables/referenced-by?table=" + url.QueryEscape("users' OR '1'='1"),
		"/api/tables/referenced-by", // table param missing
		"/api/tables/referenced-by?schema=no_such_schema&table=users",
		"/api/tables/referenced-by?source=no_such_source&table=users",
	}
	for _, path := range bad {
		resp, err := http.Get(base + "/__ashurbanipal" + path)
		if err != nil {
			t.Fatalf("GET %s: %v", path, err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Errorf("GET %s: status %d, want 400", path, resp.StatusCode)
		}
		if got := resp.Header.Get("x-ashurbanipal-protocol"); got != "1" {
			t.Errorf("GET %s: protocol header = %q, want \"1\"", path, got)
		}
	}
}

func TestReferencedByCarriesProtocolHeaderOn200(t *testing.T) {
	resp, err := http.Get(testServer(t) + "/__ashurbanipal/api/tables/referenced-by?table=users")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status %d, want 200", resp.StatusCode)
	}
	if got := resp.Header.Get("x-ashurbanipal-protocol"); got != "1" {
		t.Errorf("protocol header = %q, want \"1\"", got)
	}
}

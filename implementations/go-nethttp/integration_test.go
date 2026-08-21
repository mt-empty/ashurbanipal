package ashurbanipal

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strconv"
	"strings"
	"testing"

	_ "github.com/jackc/pgx/v5/stdlib"
)

// Boots a real httptest.Server wrapping Router(...) against the
// devcontainer's live Postgres with conformance/seed/seed.sql applied
// (no Testcontainers/Docker available in this environment — see
// PORTING.md). This is a spot-check of the JSON shapes with a real HTTP
// client; the actual conformance bar is the golden-fixture runner and
// schemathesis run externally against a demo binary using this same
// Router.
//
// The server is built once in TestMain, not lazily per-test: a lazily
// built server torn down via the first test's own t.Cleanup would close
// out from under every test that runs after it — package-scoped setup in
// TestMain is the only sound way to share one long-lived server across
// every test function in the file.
var integrationServerURL string

func TestMain(m *testing.M) {
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		os.Exit(m.Run()) // every test using testServer(t) skips individually
	}
	db, err := sql.Open("pgx", databaseURL)
	if err != nil {
		fmt.Fprintf(os.Stderr, "opening database: %v\n", err)
		os.Exit(1)
	}
	cfg := Config{Enabled: true}
	source := NewPostgresSource(db, cfg.Limits.WithDefaults().QueryTimeoutSecs)
	srv := httptest.NewServer(Router(cfg, []NamedSource{{Name: "primary", Source: source}}))
	integrationServerURL = srv.URL
	code := m.Run()
	srv.Close()
	db.Close()
	os.Exit(code)
}

func testServer(t *testing.T) string {
	t.Helper()
	if integrationServerURL == "" {
		t.Skip("DATABASE_URL not set (the devcontainer sets it automatically)")
	}
	return integrationServerURL
}

func getJSON(t *testing.T, base, path string) map[string]interface{} {
	t.Helper()
	resp, err := http.Get(base + "/__ashurbanipal" + path)
	if err != nil {
		t.Fatalf("GET %s: %v", path, err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("reading body: %v", err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET %s: status %d: %s", path, resp.StatusCode, body)
	}
	var out map[string]interface{}
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatalf("GET %s: invalid JSON: %v\nbody: %s", path, err, body)
	}
	return out
}

func TestListsExactlySeededTablesInAlphabeticalOrder(t *testing.T) {
	body := getJSON(t, testServer(t), "/api/tables")
	tables, _ := body["tables"].([]interface{})
	var names []string
	for _, tbl := range tables {
		names = append(names, tbl.(map[string]interface{})["name"].(string))
	}
	expected := []string{
		"_conformance_meta", "audit_log", "events", "feature_flags", "inventory_counts",
		"inventory_locations", "order_extra", "orders", "payments", "products", "reviews",
		"saved_reports", "sessions", "support_tickets", "users",
	}
	if len(names) != len(expected) {
		t.Fatalf("got %v tables, want %v", names, expected)
	}
	for i := range expected {
		if names[i] != expected[i] {
			t.Errorf("table[%d] = %q, want %q", i, names[i], expected[i])
		}
	}
}

func TestTableCommentsPresentOnlyWhereSeeded(t *testing.T) {
	body := getJSON(t, testServer(t), "/api/tables")
	tables, _ := body["tables"].([]interface{})
	byName := func(name string) map[string]interface{} {
		for _, tbl := range tables {
			m := tbl.(map[string]interface{})
			if m["name"] == name {
				return m
			}
		}
		t.Fatalf("table %q not found", name)
		return nil
	}
	if _, ok := byName("users")["comment"]; !ok {
		t.Errorf("users should have a comment")
	}
	if _, ok := byName("products")["comment"]; ok {
		t.Errorf("products should have no comment")
	}
}

func TestTableCountsReportsMinusOneForNeverAnalyzedTable(t *testing.T) {
	body := getJSON(t, testServer(t), "/api/table-counts")
	counts, _ := body["counts"].([]interface{})
	for _, c := range counts {
		m := c.(map[string]interface{})
		if m["table"] == "feature_flags" {
			if m["approx_rows"].(float64) != -1 {
				t.Errorf("feature_flags approx_rows = %v, want -1", m["approx_rows"])
			}
			return
		}
	}
	t.Fatal("feature_flags not found in table-counts")
}

func TestPKAndFKColumnMetadataIsCorrect(t *testing.T) {
	body := getJSON(t, testServer(t), "/api/tables/data?table=orders&limit=1")
	columns, _ := body["columns"].([]interface{})
	byName := func(name string) map[string]interface{} {
		for _, c := range columns {
			m := c.(map[string]interface{})
			if m["name"] == name {
				return m
			}
		}
		t.Fatalf("column %q not found", name)
		return nil
	}
	if k := byName("id")["key"]; k != "pk" {
		t.Errorf("orders.id key = %v, want pk", k)
	}
	userID := byName("user_id")
	if k := userID["key"]; k != "fk" {
		t.Errorf("orders.user_id key = %v, want fk", k)
	}
	ref, _ := userID["references"].(map[string]interface{})
	if ref["table"] != "users" || ref["column"] != "id" {
		t.Errorf("orders.user_id references = %v, want {users id}", ref)
	}
}

// docs/feature-backlog/13-pk-that-is-also-fk-loses-references.md:
// order_extra.order_id is both its own table's PK and an FK into
// orders(id) — key MUST still report pk, but references MUST be
// populated too, not omitted the way a plain PK's is.
func TestPKAndFKColumnReportsBoth(t *testing.T) {
	body := getJSON(t, testServer(t), "/api/tables/data?table=order_extra&limit=1")
	columns, _ := body["columns"].([]interface{})
	byName := func(name string) map[string]interface{} {
		for _, c := range columns {
			m := c.(map[string]interface{})
			if m["name"] == name {
				return m
			}
		}
		t.Fatalf("column %q not found", name)
		return nil
	}
	orderID := byName("order_id")
	if k := orderID["key"]; k != "pk" {
		t.Errorf("order_extra.order_id key = %v, want pk", k)
	}
	ref, _ := orderID["references"].(map[string]interface{})
	if ref["table"] != "orders" || ref["column"] != "id" {
		t.Errorf("order_extra.order_id references = %v, want {orders id}", ref)
	}
}

func TestCompositeForeignKeyColumnsOmitKeyMetadataEntirely(t *testing.T) {
	body := getJSON(t, testServer(t), "/api/tables/data?table=inventory_counts&limit=1")
	columns, _ := body["columns"].([]interface{})
	byName := func(name string) map[string]interface{} {
		for _, c := range columns {
			m := c.(map[string]interface{})
			if m["name"] == name {
				return m
			}
		}
		t.Fatalf("column %q not found", name)
		return nil
	}
	for _, composite := range []string{"warehouse_code", "bin_code"} {
		col := byName(composite)
		if _, ok := col["key"]; ok {
			t.Errorf("%s should have no key field, got %v", composite, col["key"])
		}
		if _, ok := col["references"]; ok {
			t.Errorf("%s should have no references field", composite)
		}
	}
	if k := byName("product_id")["key"]; k != "fk" {
		t.Errorf("inventory_counts.product_id key = %v, want fk", k)
	}
}

func TestEveryCellValueIsJSONStringOrNull(t *testing.T) {
	body := getJSON(t, testServer(t), "/api/tables/data?table=users&limit=10")
	rows, _ := body["rows"].([]interface{})
	for _, r := range rows {
		row := r.(map[string]interface{})
		for _, field := range []string{"login_count", "is_active", "metadata", "id", "created_at"} {
			v, present := row[field]
			if !present {
				continue
			}
			if v == nil {
				continue
			}
			if _, ok := v.(string); !ok {
				t.Errorf("users.%s = %v (%T) is not a string or null", field, v, v)
			}
		}
	}
}

func TestLimitClampsToConfiguredRange(t *testing.T) {
	base := testServer(t)
	rowsLen := func(path string) int {
		body := getJSON(t, base, path)
		rows, _ := body["rows"].([]interface{})
		return len(rows)
	}
	if n := rowsLen("/api/tables/data?table=events"); n != 50 {
		t.Errorf("default limit: got %d rows, want 50", n)
	}
	if n := rowsLen("/api/tables/data?table=events&limit=1000"); n != 100 {
		t.Errorf("limit=1000: got %d rows, want 100 (clamped to max)", n)
	}
	if n := rowsLen("/api/tables/data?table=events&limit=0"); n != 1 {
		t.Errorf("limit=0: got %d rows, want 1 (clamped to min)", n)
	}
}

func TestOffsetBeyondTableSizeReturnsEmptyRowsNotAnError(t *testing.T) {
	body := getJSON(t, testServer(t), "/api/tables/data?table=users&offset=10000")
	rows, _ := body["rows"].([]interface{})
	if len(rows) != 0 {
		t.Errorf("got %d rows, want 0", len(rows))
	}
}

func TestSortOnNumericColumnIsNumericNotLexicographic(t *testing.T) {
	body := getJSON(t, testServer(t), "/api/tables/data?table=products&sort=price&order=asc&limit=100")
	rows, _ := body["rows"].([]interface{})
	var prices []float64
	for _, r := range rows {
		row := r.(map[string]interface{})
		p, err := strconv.ParseFloat(row["price"].(string), 64)
		if err != nil {
			t.Fatalf("price %v is not numeric: %v", row["price"], err)
		}
		prices = append(prices, p)
	}
	for i := 1; i < len(prices); i++ {
		if prices[i-1] > prices[i] {
			t.Errorf("prices not sorted ascending: %v", prices)
			break
		}
	}
}

func TestEqualityFilterNarrowsRows(t *testing.T) {
	filter := `[{"column":"status","op":"=","value":"completed"}]`
	q := url.Values{"table": {"orders"}, "filter": {filter}}
	body := getJSON(t, testServer(t), "/api/tables/data?"+q.Encode())
	rows, _ := body["rows"].([]interface{})
	if len(rows) == 0 {
		t.Fatal("expected at least one completed order")
	}
	for _, r := range rows {
		row := r.(map[string]interface{})
		if row["status"] != "completed" {
			t.Errorf("row status = %v, want completed", row["status"])
		}
	}
}

func TestTotalApproxIsUnaffectedByFilter(t *testing.T) {
	base := testServer(t)
	unfiltered := getJSON(t, base, "/api/tables/data?table=orders")
	filter := `[{"column":"status","op":"=","value":"pending"}]`
	q := url.Values{"table": {"orders"}, "filter": {filter}}
	filtered := getJSON(t, base, "/api/tables/data?"+q.Encode())
	if unfiltered["total_approx"] != filtered["total_approx"] {
		t.Errorf("total_approx changed with filter: %v vs %v", unfiltered["total_approx"], filtered["total_approx"])
	}
	filteredRows, _ := filtered["rows"].([]interface{})
	unfilteredRows, _ := unfiltered["rows"].([]interface{})
	if len(filteredRows) >= len(unfilteredRows) {
		t.Errorf("filtered rows (%d) should be fewer than unfiltered (%d)", len(filteredRows), len(unfilteredRows))
	}
}

func TestUnknownTableIsRejectedWith400(t *testing.T) {
	resp, err := http.Get(testServer(t) + "/__ashurbanipal/api/tables/data?table=nonexistent")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("got status %d, want 400", resp.StatusCode)
	}
}

func TestCommonValuesOnNeverAnalyzedColumnYieldsEmptyListNotAnError(t *testing.T) {
	body := getJSON(t, testServer(t), "/api/tables/common-values?table=feature_flags&column=enabled")
	values, _ := body["values"].([]interface{})
	if len(values) != 0 {
		t.Errorf("got %d values, want 0", len(values))
	}
}

func TestCommonValuesRendersBooleansAsTrueFalseNotPgArrayLiterals(t *testing.T) {
	body := getJSON(t, testServer(t), "/api/tables/common-values?table=users&column=is_active")
	values, _ := body["values"].([]interface{})
	sawBool := false
	for _, v := range values {
		val := v.(map[string]interface{})["value"]
		if val == "t" || val == "f" {
			t.Errorf("value %v is a raw pg array literal, want true/false", val)
		}
		if val == "true" || val == "false" {
			sawBool = true
		}
	}
	if !sawBool {
		t.Errorf("expected at least one true/false value")
	}
}

func TestSiblingsEndpointReturnsEmptyListByDefault(t *testing.T) {
	body := getJSON(t, testServer(t), "/api/siblings")
	siblings, _ := body["siblings"].([]interface{})
	if len(siblings) != 0 {
		t.Errorf("got %d siblings, want 0", len(siblings))
	}
}

func TestEveryAPIResponseCarriesTheProtocolVersionHeader(t *testing.T) {
	resp, err := http.Get(testServer(t) + "/__ashurbanipal/api/tables")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()
	if got := resp.Header.Get(protocolHeader); got != "1" {
		t.Errorf("protocol header = %q, want \"1\"", got)
	}
}

func TestHTMLRouteHasNoProtocolHeaderAndServesTheVendoredFrontend(t *testing.T) {
	resp, err := http.Get(testServer(t) + "/__ashurbanipal")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()
	if got := resp.Header.Get(protocolHeader); got != "" {
		t.Errorf("UI route carries protocol header %q, want none", got)
	}
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), `id="tables"`) {
		t.Errorf("UI route body does not look like the vendored frontend")
	}
}

func TestSchemaScopingExcludesOtherSchemas(t *testing.T) {
	body := getJSON(t, testServer(t), "/api/tables")
	tables, _ := body["tables"].([]interface{})
	for _, tbl := range tables {
		if tbl.(map[string]interface{})["name"] == "decoy_items" {
			t.Errorf("decoy_items from another schema leaked into /api/tables")
		}
	}
}

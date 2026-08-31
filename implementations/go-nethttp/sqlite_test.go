//go:build sqlite

package ashurbanipal

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"testing"
	"time"

	_ "modernc.org/sqlite"
)

// seededDB opens a fresh on-disk SQLite file (not :memory: — a real file is
// what the live-verification brief asks for, and matters for the timeout
// test: an in-process :memory: db shares no meaningfully different code
// path here, but a file is the more representative "real instance").
func seededDB(t *testing.T) *sql.DB {
	t.Helper()
	path := filepath.Join(t.TempDir(), "seed.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatalf("opening sqlite db: %v", err)
	}
	t.Cleanup(func() { db.Close() })

	schema := `
		create table users (
			id integer primary key,
			email text not null,
			age integer
		);
		create table orders (
			id integer primary key,
			user_id integer references users(id),
			status text not null
		);
		create table order_extra (
			order_id integer primary key references orders(id),
			gift_message text
		);`
	if _, err := db.Exec(schema); err != nil {
		t.Fatalf("creating schema: %v", err)
	}
	for _, row := range []struct {
		email string
		age   int
	}{{"a@x.com", 30}, {"b@x.com", 30}, {"c@x.com", 40}} {
		if _, err := db.Exec("insert into users (email, age) values (?, ?)", row.email, row.age); err != nil {
			t.Fatalf("seeding users: %v", err)
		}
	}
	if _, err := db.Exec("insert into orders (user_id, status) values (1, 'open')"); err != nil {
		t.Fatalf("seeding orders: %v", err)
	}
	if _, err := db.Exec("insert into order_extra (order_id, gift_message) values (1, 'enjoy!')"); err != nil {
		t.Fatalf("seeding order_extra: %v", err)
	}
	return db
}

func TestSQLiteListTablesAndQueryTableRoundTrip(t *testing.T) {
	source := NewSQLiteSource(seededDB(t), 5)
	ctx := context.Background()

	tables, err := source.ListTables(ctx, nil)
	if err != nil {
		t.Fatalf("ListTables: %v", err)
	}
	if len(tables) != 3 || tables[0].Name != "order_extra" || tables[1].Name != "orders" || tables[2].Name != "users" {
		t.Fatalf("got tables %+v, want [order_extra orders users]", tables)
	}
	for _, tbl := range tables {
		if tbl.Comment != nil {
			t.Errorf("table %q has a comment, want none (no mechanism on SQLite)", tbl.Name)
		}
	}

	schemas, err := source.ListSchemas(ctx)
	if err != nil || len(schemas) != 1 || schemas[0] != "main" {
		t.Fatalf("ListSchemas = %v, %v, want [main]", schemas, err)
	}

	other := "other"
	if _, err := source.ListTables(ctx, &other); !errors.As(err, new(*NotAllowedError)) {
		t.Fatalf("ListTables(other) = %v, want NotAllowedError", err)
	}

	sortCol := "age"
	data, err := source.QueryTable(ctx, nil, "users", QueryOpts{Limit: 10, Sort: &sortCol})
	if err != nil {
		t.Fatalf("QueryTable: %v", err)
	}
	if data.TotalApprox != -1 {
		t.Errorf("TotalApprox = %d, want -1 (no estimate sentinel)", data.TotalApprox)
	}
	if len(data.Rows) != 3 {
		t.Errorf("got %d rows, want 3", len(data.Rows))
	}
	var idKey KeyKind
	for _, c := range data.Columns {
		if c.Name == "id" {
			idKey = c.Key
		}
	}
	if idKey != KeyPK {
		t.Errorf("users.id key = %q, want pk", idKey)
	}
	for _, row := range data.Rows {
		for _, v := range row {
			_ = v // every value is *string or nil by construction (map[string]*string)
		}
	}
}

func TestSQLiteForeignKeyColumnReportsKeyAndReferences(t *testing.T) {
	source := NewSQLiteSource(seededDB(t), 5)
	data, err := source.QueryTable(context.Background(), nil, "orders", QueryOpts{Limit: 10})
	if err != nil {
		t.Fatalf("QueryTable: %v", err)
	}
	var userID *ColumnInfo
	for i := range data.Columns {
		if data.Columns[i].Name == "user_id" {
			userID = &data.Columns[i]
		}
	}
	if userID == nil || userID.Key != KeyFK {
		t.Fatalf("orders.user_id = %+v, want key=fk", userID)
	}
	if userID.References == nil || userID.References.Table != "users" || userID.References.Column != "id" {
		t.Errorf("orders.user_id.references = %+v, want {users id}", userID.References)
	}
}

func TestSQLitePKAndFKColumnReportsBoth(t *testing.T) {
	source := NewSQLiteSource(seededDB(t), 5)
	data, err := source.QueryTable(context.Background(), nil, "order_extra", QueryOpts{Limit: 10})
	if err != nil {
		t.Fatalf("QueryTable: %v", err)
	}
	var orderID *ColumnInfo
	for i := range data.Columns {
		if data.Columns[i].Name == "order_id" {
			orderID = &data.Columns[i]
		}
	}
	if orderID == nil || orderID.Key != KeyPK {
		t.Fatalf("order_extra.order_id = %+v, want key=pk", orderID)
	}
	if orderID.References == nil || orderID.References.Table != "orders" || orderID.References.Column != "id" {
		t.Errorf("order_extra.order_id.references = %+v, want {orders id}", orderID.References)
	}
}

func TestSQLiteTableCountsReportsNoEstimateSentinel(t *testing.T) {
	source := NewSQLiteSource(seededDB(t), 5)
	counts, err := source.TableCounts(context.Background(), nil)
	if err != nil {
		t.Fatalf("TableCounts: %v", err)
	}
	for _, c := range counts {
		if c.ApproxRows != -1 {
			t.Errorf("table %q approx_rows = %d, want -1", c.Table, c.ApproxRows)
		}
	}
}

func TestSQLiteCommonValuesIsAlwaysEmpty(t *testing.T) {
	source := NewSQLiteSource(seededDB(t), 5)
	values, err := source.CommonValues(context.Background(), nil, "users", "age")
	if err != nil {
		t.Fatalf("CommonValues: %v", err)
	}
	if len(values) != 0 {
		t.Errorf("got %d values, want 0 (no pg_stats analog on SQLite)", len(values))
	}

	if _, err := source.CommonValues(context.Background(), nil, "users", "nope"); !errors.As(err, new(*NotAllowedError)) {
		t.Errorf("CommonValues(nope) = %v, want NotAllowedError", err)
	}
}

// slowQueryIsAbortedNotLeftToRun is the empirical proof this port's brief
// asked for: a real SQLite file, a real slow query, a real timeout — not
// an inference from modernc.org/sqlite's documentation. Uses its own
// single-connection *sql.DB so the probe shares the slow query's physical
// connection. A mere wait cancellation would leave it busy and stall the probe.
func TestSQLiteSlowQueryIsAbortedNotLeftToRun(t *testing.T) {
	path := filepath.Join(t.TempDir(), "slow.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatalf("opening sqlite db: %v", err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)

	source := NewSQLiteSource(db, 1)
	slowCtx, cancel := source.bounded(context.Background())
	defer cancel()
	slowStart := time.Now()
	var n int64
	err = db.QueryRowContext(slowCtx, `with recursive slow(x) as (
		select 1 union all select x + 1 from slow where x < 100000000
	) select count(*) from slow`).Scan(&n)
	elapsed := time.Since(slowStart)
	if err == nil {
		t.Fatalf("expected the slow query to be interrupted by the 1s timeout, got n=%d after %v", n, elapsed)
	}
	if elapsed > 3*time.Second {
		t.Fatalf("slow query took %v to error, want close to the 1s deadline (abandoned wait, not real cancellation)", elapsed)
	}

	// The same physical connection (pool size 1) must be immediately
	// usable afterward — proves the query was actually interrupted
	// server-side, not left running while Go merely stopped waiting on it.
	probeStart := time.Now()
	var ok int64
	if err := db.QueryRowContext(context.Background(), "select 1").Scan(&ok); err != nil {
		t.Fatalf("probe query after cancellation failed: %v", err)
	}
	if probeElapsed := time.Since(probeStart); probeElapsed > 200*time.Millisecond {
		t.Errorf("probe query took %v, want near-instant — suggests the slow query was still running", probeElapsed)
	}
}

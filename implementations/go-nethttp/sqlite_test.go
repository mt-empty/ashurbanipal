//go:build sqlite

package ashurbanipal

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"regexp"
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

func TestSQLiteReferencedByListsIncomingFKsWithSynthesizedConstraintNames(t *testing.T) {
	source := NewSQLiteSource(seededDB(t), 5)
	ctx := context.Background()

	toUsers, err := source.ReferencedBy(ctx, nil, "users")
	if err != nil {
		t.Fatalf("ReferencedBy(users): %v", err)
	}
	if len(toUsers) != 1 || toUsers[0].Table != "orders" {
		t.Fatalf("ReferencedBy(users) = %+v, want one orders entry", toUsers)
	}
	if toUsers[0].Schema != "" {
		t.Errorf("single-schema referrer must omit schema, got %q", toUsers[0].Schema)
	}
	if len(toUsers[0].Columns) != 1 || toUsers[0].Columns[0] != (ColumnPair{From: "user_id", To: "id"}) {
		t.Errorf("orders columns = %+v, want [{user_id id}]", toUsers[0].Columns)
	}
	// SQLite FKs are unnamed — the label is synthesized fk_<id>.
	if m, _ := regexp.MatchString(`^fk_\d+$`, toUsers[0].Constraint); !m {
		t.Errorf("constraint = %q, want /^fk_\\d+$/", toUsers[0].Constraint)
	}

	toOrders, err := source.ReferencedBy(ctx, nil, "orders")
	if err != nil {
		t.Fatalf("ReferencedBy(orders): %v", err)
	}
	if len(toOrders) != 1 || toOrders[0].Table != "order_extra" {
		t.Errorf("ReferencedBy(orders) = %+v, want one order_extra entry", toOrders)
	}

	if leaf, err := source.ReferencedBy(ctx, nil, "order_extra"); err != nil || len(leaf) != 0 {
		t.Errorf("ReferencedBy(order_extra) = %+v, %v, want []", leaf, err)
	}

	if _, err := source.ReferencedBy(ctx, nil, "no_such_table"); !errors.As(err, new(*NotAllowedError)) {
		t.Errorf("ReferencedBy(no_such_table) = %v, want NotAllowedError", err)
	}
	other := "other"
	if _, err := source.ReferencedBy(ctx, &other, "users"); !errors.As(err, new(*NotAllowedError)) {
		t.Errorf("ReferencedBy(other, users) = %v, want NotAllowedError", err)
	}
}

// "REFERENCES parent" with no parenthesised column list is valid DDL
// meaning "the parent's primary key", but pragma_foreign_key_list reports
// "to" as NULL for that form rather than filling in the PK name — the
// query must resolve it itself.
func TestSQLiteReferencedByResolvesShorthandFKWithNoNamedParentColumn(t *testing.T) {
	path := filepath.Join(t.TempDir(), "shorthand.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatalf("opening sqlite db: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	if _, err := db.Exec(`
		create table users (id integer primary key, email text not null);
		create table pets (id integer primary key, owner_id integer references users);
	`); err != nil {
		t.Fatalf("creating schema: %v", err)
	}

	source := NewSQLiteSource(db, 5)
	refs, err := source.ReferencedBy(context.Background(), nil, "users")
	if err != nil {
		t.Fatalf("ReferencedBy(users): %v", err)
	}
	var pets *ReferencedByEntry
	for i := range refs {
		if refs[i].Table == "pets" {
			pets = &refs[i]
		}
	}
	if pets == nil {
		t.Fatalf("ReferencedBy(users) = %+v, want a pets entry", refs)
	}
	if len(pets.Columns) != 1 || pets.Columns[0] != (ColumnPair{From: "owner_id", To: "id"}) {
		t.Errorf("pets columns = %+v, want [{owner_id id}] — an unnamed parent column must resolve to users' primary key, not empty", pets.Columns)
	}
}

// Same shorthand-FK bug, forward direction: keyMetadata (which supplies
// QueryTable's per-column References) shares ReferencedBy's pre-fix bug —
// pragma_foreign_key_list.to is NULL for "REFERENCES parent" with no named
// column, and until fixed keyMetadata doesn't resolve it the way
// ReferencedBy now does.
func TestSQLiteQueryTableResolvesShorthandFKWithNoNamedParentColumn(t *testing.T) {
	path := filepath.Join(t.TempDir(), "shorthand_forward.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatalf("opening sqlite db: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	if _, err := db.Exec(`
		create table users (id integer primary key, email text not null);
		create table pets (id integer primary key, owner_id integer references users);
	`); err != nil {
		t.Fatalf("creating schema: %v", err)
	}

	source := NewSQLiteSource(db, 5)
	data, err := source.QueryTable(context.Background(), nil, "pets", QueryOpts{Limit: 10})
	if err != nil {
		t.Fatalf("QueryTable: %v", err)
	}
	var ownerID *ColumnInfo
	for i := range data.Columns {
		if data.Columns[i].Name == "owner_id" {
			ownerID = &data.Columns[i]
		}
	}
	if ownerID == nil || ownerID.Key != KeyFK {
		t.Fatalf("pets.owner_id = %+v, want key=fk", ownerID)
	}
	if ownerID.References == nil || ownerID.References.Table != "users" || ownerID.References.Column != "id" {
		t.Errorf("pets.owner_id.references = %+v, want {users id} — an unnamed parent column must resolve to users' primary key, not empty", ownerID.References)
	}
}

func TestSQLiteReferencedByResolvesShorthandFKAgainstCompositePrimaryKey(t *testing.T) {
	path := filepath.Join(t.TempDir(), "shorthand_composite.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatalf("opening sqlite db: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	if _, err := db.Exec(`
		create table warehouse_bins (
			warehouse_code text not null,
			bin_code text not null,
			primary key (warehouse_code, bin_code)
		);
		create table bin_counts (
			id integer primary key,
			warehouse_code text not null,
			bin_code text not null,
			qty integer not null,
			foreign key (warehouse_code, bin_code) references warehouse_bins
		);
	`); err != nil {
		t.Fatalf("creating schema: %v", err)
	}

	source := NewSQLiteSource(db, 5)
	refs, err := source.ReferencedBy(context.Background(), nil, "warehouse_bins")
	if err != nil {
		t.Fatalf("ReferencedBy(warehouse_bins): %v", err)
	}
	var binCounts *ReferencedByEntry
	for i := range refs {
		if refs[i].Table == "bin_counts" {
			binCounts = &refs[i]
		}
	}
	if binCounts == nil || len(binCounts.Columns) != 2 {
		t.Fatalf("ReferencedBy(warehouse_bins) = %+v, want a bin_counts entry with 2 column pairs", refs)
	}
	want := map[ColumnPair]bool{
		{From: "warehouse_code", To: "warehouse_code"}: true,
		{From: "bin_code", To: "bin_code"}:             true,
	}
	for _, pair := range binCounts.Columns {
		if !want[pair] {
			t.Errorf("unexpected column pair %+v", pair)
		}
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

//go:build mysql

package ashurbanipal

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"sync/atomic"
	"testing"
	"time"

	_ "github.com/go-sql-driver/mysql"
)

// testURL reads MYSQL_TEST_URL, mirroring
// implementations/rust/src/db/mysql.rs's own test_url() — the devcontainer
// sets this to a long-lived shared `mysql` service; MARIADB_TEST_URL (same
// shape, pointed at the `mariadb` service) exercises the same tests against
// the other fork via TestMySQLAgainstMariaDB below.
func testURL(t *testing.T) string {
	t.Helper()
	url := os.Getenv("MYSQL_TEST_URL")
	if url == "" {
		t.Skip("MYSQL_TEST_URL not set — needs a reachable MySQL/MariaDB instance (see .devcontainer)")
	}
	return url
}

var seededDBCounter int64

// seededMySQLDB creates its own uniquely-named throwaway database against
// the shared instance baseURL points at (mirrors mysql.rs's seeded_db()) —
// there's no sqlite::memory:-style disposable instance for MySQL, so each
// test gets isolation this way instead of for free.
func seededMySQLDB(t *testing.T, baseURL string) *sql.DB {
	t.Helper()
	admin, err := sql.Open("mysql", stripScheme(baseURL))
	if err != nil {
		t.Fatalf("opening admin connection: %v", err)
	}
	defer admin.Close()

	nanos := time.Now().UnixNano()
	n := atomic.AddInt64(&seededDBCounter, 1)
	name := fmt.Sprintf("ashurbanipal_test_%d_%d", nanos, n)
	if _, err := admin.Exec(fmt.Sprintf("create database `%s`", name)); err != nil {
		t.Fatalf("creating database %s: %v", name, err)
	}
	t.Cleanup(func() {
		dropAdmin, err := sql.Open("mysql", stripScheme(baseURL))
		if err != nil {
			t.Errorf("opening cleanup connection: %v", err)
			return
		}
		defer dropAdmin.Close()
		if _, err := dropAdmin.Exec(fmt.Sprintf("drop database `%s`", name)); err != nil {
			t.Errorf("dropping database %s: %v", name, err)
		}
	})

	db, err := sql.Open("mysql", stripScheme(baseURL)+name)
	if err != nil {
		t.Fatalf("opening seeded db connection: %v", err)
	}
	t.Cleanup(func() { db.Close() })

	schema := []string{
		`create table users (
			id integer primary key auto_increment,
			email varchar(255) not null,
			age integer
		)`,
		`create table orders (
			id integer primary key auto_increment,
			user_id integer,
			status varchar(50) not null,
			constraint fk_orders_user foreign key (user_id) references users(id)
		)`,
		`create table order_extra (
			order_id integer primary key,
			gift_message varchar(255),
			constraint fk_order_extra_order foreign key (order_id) references orders(id)
		)`,
	}
	for _, stmt := range schema {
		if _, err := db.Exec(stmt); err != nil {
			t.Fatalf("creating schema: %v", err)
		}
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

// stripScheme converts a mysql://user:pass@host:port/ URL into the DSN
// go-sql-driver/mysql expects (user:pass@tcp(host:port)/), and drops any
// trailing database name so seededMySQLDB can append its own throwaway
// database name — MYSQL_TEST_URL/MARIADB_TEST_URL are given in the
// mysql:// URL shape shared with sqlx (see the devcontainer env), not the
// driver's native DSN shape.
func stripScheme(url string) string {
	const prefix = "mysql://"
	rest := url
	if len(rest) >= len(prefix) && rest[:len(prefix)] == prefix {
		rest = rest[len(prefix):]
	}
	at := -1
	for i, r := range rest {
		if r == '@' {
			at = i
		}
	}
	if at < 0 {
		return rest
	}
	userpass := rest[:at]
	hostpart := rest[at+1:]
	slash := -1
	for i, r := range hostpart {
		if r == '/' {
			slash = i
			break
		}
	}
	host := hostpart
	if slash >= 0 {
		host = hostpart[:slash]
	}
	return userpass + "@tcp(" + host + ")/"
}

func TestMySQLListTablesAndQueryTableRoundTrip(t *testing.T) {
	db := seededMySQLDB(t, testURL(t))
	source := NewMySQLSource(db, 5)
	ctx := context.Background()

	tables, err := source.ListTables(ctx, nil)
	if err != nil {
		t.Fatalf("ListTables: %v", err)
	}
	if len(tables) != 3 || tables[0].Name != "order_extra" || tables[1].Name != "orders" || tables[2].Name != "users" {
		t.Fatalf("got tables %+v, want [order_extra orders users]", tables)
	}

	other := "no_such_schema"
	if _, err := source.ListTables(ctx, &other); !errors.As(err, new(*NotAllowedError)) {
		t.Fatalf("ListTables(no_such_schema) = %v, want NotAllowedError", err)
	}

	sortCol := "age"
	data, err := source.QueryTable(ctx, nil, "users", QueryOpts{Limit: 10, Sort: &sortCol})
	if err != nil {
		t.Fatalf("QueryTable: %v", err)
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
}

func TestMySQLForeignKeyColumnReportsKeyAndReferences(t *testing.T) {
	db := seededMySQLDB(t, testURL(t))
	source := NewMySQLSource(db, 5)
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

func TestMySQLPKAndFKColumnReportsBoth(t *testing.T) {
	db := seededMySQLDB(t, testURL(t))
	source := NewMySQLSource(db, 5)
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

func TestMySQLTableCountsReportsARealEstimate(t *testing.T) {
	db := seededMySQLDB(t, testURL(t))
	// InnoDB's background stats recalculation may not have run yet right
	// after insert — force it so the estimate is deterministic for this
	// test, without pretending the wire contract itself is exact (it's
	// still "MAY be stale/approximate" per spec/protocol.md §5.3).
	if _, err := db.Exec("analyze table users"); err != nil {
		t.Fatalf("analyze table: %v", err)
	}
	source := NewMySQLSource(db, 5)
	counts, err := source.TableCounts(context.Background(), nil)
	if err != nil {
		t.Fatalf("TableCounts: %v", err)
	}
	found := false
	for _, c := range counts {
		if c.Table == "users" {
			found = true
			if c.ApproxRows < 0 {
				t.Errorf("users approx_rows = %d, want a real (non-negative) estimate, not the no-mechanism sentinel", c.ApproxRows)
			}
		}
	}
	if !found {
		t.Fatal("users not found in table-counts")
	}
}

func TestMySQLCommonValuesIsAlwaysEmpty(t *testing.T) {
	db := seededMySQLDB(t, testURL(t))
	source := NewMySQLSource(db, 5)
	values, err := source.CommonValues(context.Background(), nil, "users", "age")
	if err != nil {
		t.Fatalf("CommonValues: %v", err)
	}
	if len(values) != 0 {
		t.Errorf("got %d values, want 0 (no pg_stats analog on MySQL)", len(values))
	}
	if _, err := source.CommonValues(context.Background(), nil, "users", "nope"); !errors.As(err, new(*NotAllowedError)) {
		t.Errorf("CommonValues(nope) = %v, want NotAllowedError", err)
	}
}

// TestMySQLSlowQueryIsAbortedByTheTimeoutMechanism is the empirical proof
// this port's brief asked for, run against MYSQL_TEST_URL — see
// TestMariaDBSlowQueryIsAbortedByTheTimeoutMechanism for the MariaDB-fork
// run of the identical mechanism, which is the one that actually catches a
// MAX_EXECUTION_TIME/max_statement_time divergence (PR #26's own bug was
// only caught by running against a real MariaDB, not by reasoning about
// API symmetry between the two forks).
func TestMySQLSlowQueryIsAbortedByTheTimeoutMechanism(t *testing.T) {
	runSlowQueryTimeoutTest(t, testURL(t))
}

// TestMariaDBSlowQueryIsAbortedByTheTimeoutMechanism is the same test
// against MARIADB_TEST_URL, gated on that variable specifically (not
// MYSQL_TEST_URL) so it's skipped, not silently unrun, when only a plain
// MySQL instance is reachable.
func TestMariaDBSlowQueryIsAbortedByTheTimeoutMechanism(t *testing.T) {
	url := os.Getenv("MARIADB_TEST_URL")
	if url == "" {
		t.Skip("MARIADB_TEST_URL not set — needs a reachable MariaDB instance (see .devcontainer)")
	}
	runSlowQueryTimeoutTest(t, url)
}

func runSlowQueryTimeoutTest(t *testing.T, url string) {
	t.Helper()
	db := seededMySQLDB(t, url)
	source := NewMySQLSource(db, 1)
	ctx := context.Background()

	variant, err := source.variantOf(ctx)
	if err != nil {
		t.Fatalf("variantOf: %v", err)
	}

	// Held for the whole test so the SET SESSION below (when needed) and
	// the timed query definitely land on the same physical connection — a
	// fresh acquire from db would risk getting a different idle connection
	// back.
	conn, err := db.Conn(ctx)
	if err != nil {
		t.Fatalf("acquiring connection: %v", err)
	}
	defer conn.Close()

	// MariaDB caps WITH RECURSIVE at max_recursive_iterations (default
	// 1000) regardless of max_statement_time — the CTE below would
	// otherwise finish in under a millisecond, long before the 1s timeout
	// gets a chance to fire, making this a broken test rather than a
	// passing one. MySQL has no such cap, so this is a no-op there.
	if variant == variantMariaDB {
		if _, err := conn.ExecContext(ctx, "set session max_recursive_iterations = 100000000"); err != nil {
			t.Fatalf("raising max_recursive_iterations: %v", err)
		}
	}

	// Timeout checks happen at row-iteration checkpoints on both forks —
	// empirically, a bare SELECT SLEEP(n) never hits one, so this needs a
	// query that actually iterates rows, mirroring the recursive-CTE
	// approach sqlite_test.go's timeout test uses.
	query := timedSelect(variant, 1, `count(*) from (
		with recursive slow(x) as (
			select 1 union all select x + 1 from slow where x < 100000000
		) select x from slow
	) t`)
	start := time.Now()
	var n int64
	err = conn.QueryRowContext(ctx, query).Scan(&n)
	elapsed := time.Since(start)
	if err == nil {
		t.Fatalf("expected the slow query to be interrupted, got n=%d after %v", n, elapsed)
	}
	if elapsed > 5*time.Second {
		t.Fatalf("slow query took %v to error, want close to the 1s deadline", elapsed)
	}

	// The same connection must still be usable afterward — proves both
	// forks' per-statement mechanisms are self-resetting, no stale state
	// left behind the way an uncleared SQLite progress handler would leave.
	var ok int64
	if err := conn.QueryRowContext(context.Background(), "select 1").Scan(&ok); err != nil {
		t.Fatalf("probe query after timeout failed: %v", err)
	}
	if ok != 1 {
		t.Fatalf("probe query = %d, want 1", ok)
	}
}

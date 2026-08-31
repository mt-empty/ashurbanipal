//go:build mysql

package ashurbanipal

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"slices"
	"strings"
	"testing"
	"time"
)

// MySQL/MariaDB have no has_table_privilege function and no cheap role-aware
// way to narrow information_schema.tables to SELECT-able tables, so the
// listing is deliberately NOT gated (an INSERT-only table still shows up).
// What this pins is the other half: a residual 1142 at the row fetch must
// surface as NotAllowedError (400), never a raw driver error (500).

// limitedDSN rewrites a mysql://root:pw@host/db URL into a go-sql-driver DSN
// (user:pass@tcp(host)/db) for the throwaway least-privilege user.
func limitedDSN(url, user, password, dbName string) string {
	rest := strings.TrimPrefix(url, "mysql://")
	if at := strings.LastIndexByte(rest, '@'); at >= 0 {
		rest = rest[at+1:]
	}
	host := rest
	if slash := strings.IndexByte(host, '/'); slash >= 0 {
		host = host[:slash]
	}
	return fmt.Sprintf("%s:%s@tcp(%s)/%s", user, password, host, dbName)
}

func runMySQLPrivilegeTest(t *testing.T, baseURL string) {
	t.Helper()
	const user = "ashb_test_tlp_user"
	const password = "ashb_test_pw"

	admin, err := sql.Open("mysql", stripScheme(baseURL))
	if err != nil {
		t.Fatalf("admin open: %v", err)
	}
	defer admin.Close()

	dbName := fmt.Sprintf("ashb_test_tlp_%d", time.Now().UnixNano())
	// Idempotent: a prior aborted run may have left the user behind (the db
	// name is nanosecond-unique, the user name is not).
	if _, err := admin.Exec(fmt.Sprintf("drop user if exists '%s'@'%%'", user)); err != nil {
		t.Fatalf("pre-drop user: %v", err)
	}
	for _, stmt := range []string{
		fmt.Sprintf("create database `%s`", dbName),
		fmt.Sprintf("create user '%s'@'%%' identified by '%s'", user, password),
		fmt.Sprintf("create table `%s`.readable (id int primary key, name varchar(50))", dbName),
		fmt.Sprintf("insert into `%s`.readable values (1, 'a'), (2, 'b')", dbName),
		fmt.Sprintf("create table `%s`.write_only (id int primary key)", dbName),
		fmt.Sprintf("create table `%s`.no_grant (id int primary key)", dbName),
		fmt.Sprintf("grant select on `%s`.readable to '%s'@'%%'", dbName, user),
		fmt.Sprintf("grant insert on `%s`.write_only to '%s'@'%%'", dbName, user),
	} {
		if _, err := admin.Exec(stmt); err != nil {
			t.Fatalf("setup %q: %v", stmt, err)
		}
	}
	t.Cleanup(func() {
		admin.Exec(fmt.Sprintf("drop database if exists `%s`", dbName))
		admin.Exec(fmt.Sprintf("drop user if exists '%s'@'%%'", user))
	})

	db, err := sql.Open("mysql", limitedDSN(baseURL, user, password, dbName))
	if err != nil {
		t.Fatalf("limited open: %v", err)
	}
	t.Cleanup(func() { db.Close() })

	source := NewMySQLSource(db, 5)
	ctx := context.Background()

	tables, err := source.ListTables(ctx, &dbName)
	if err != nil {
		t.Fatalf("ListTables: %v", err)
	}
	var names []string
	for _, tbl := range tables {
		names = append(names, tbl.Name)
	}
	if !slices.Contains(names, "readable") || !slices.Contains(names, "write_only") {
		// write_only staying listed is the documented gap — if it ever
		// disappears, update docs/adapter-decisions.md.
		t.Fatalf("listing = %v, want readable and write_only present", names)
	}
	if slices.Contains(names, "no_grant") {
		t.Fatalf("listing = %v, no_grant should not be catalog-visible", names)
	}

	if _, err := source.QueryTable(ctx, &dbName, "readable", QueryOpts{Limit: 10}); err != nil {
		t.Fatalf("QueryTable(readable): %v", err)
	}

	if _, err := source.QueryTable(ctx, &dbName, "write_only", QueryOpts{Limit: 10}); !errors.As(err, new(*NotAllowedError)) {
		t.Fatalf("QueryTable(write_only) = %v, want NotAllowedError", err)
	}
	if _, err := source.QueryTable(ctx, &dbName, "no_grant", QueryOpts{Limit: 10}); !errors.As(err, new(*NotAllowedError)) {
		t.Fatalf("QueryTable(no_grant) = %v, want NotAllowedError", err)
	}
}

func TestMySQLSelectDeniedMapsToNotAllowed(t *testing.T) {
	runMySQLPrivilegeTest(t, testURL(t))
}

func TestMariaDBSelectDeniedMapsToNotAllowed(t *testing.T) {
	url := os.Getenv("MARIADB_TEST_URL")
	if url == "" {
		t.Skip("MARIADB_TEST_URL not set — needs a reachable MariaDB instance (see .devcontainer)")
	}
	runMySQLPrivilegeTest(t, url)
}

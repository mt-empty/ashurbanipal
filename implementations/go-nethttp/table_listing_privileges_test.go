package ashurbanipal

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/stdlib"
)

const (
	tablePrivSchema = "ashb_test_table_privileges"
	tablePrivRole   = "ashb_test_table_privileges_role"
)

// The table listing, the counts, and the `table` allow-list must all
// Excludes non-selectable tables and maps residual SELECT denial to NotAllowed
// (spec/protocol.md §5.2).
func TestListingAndAllowListExcludeNonSelectableTables(t *testing.T) {
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		t.Skip("DATABASE_URL not set (the devcontainer sets it automatically)")
	}

	setupDB, err := sql.Open("pgx", databaseURL)
	if err != nil {
		t.Fatalf("opening setup connection: %v", err)
	}
	defer setupDB.Close()

	for _, stmt := range []string{
		fmt.Sprintf("drop schema if exists %s cascade", tablePrivSchema),
		fmt.Sprintf("drop role if exists %s", tablePrivRole),
		fmt.Sprintf("create role %s nosuperuser", tablePrivRole),
		// Lets the pool's sessions `set role` to it in AfterConnect below.
		fmt.Sprintf("grant %s to current_user", tablePrivRole),
		fmt.Sprintf("create schema %s", tablePrivSchema),
		fmt.Sprintf("grant usage on schema %s to %s", tablePrivSchema, tablePrivRole),
		fmt.Sprintf("create table %s.readable (id int primary key, name text)", tablePrivSchema),
		fmt.Sprintf("insert into %s.readable values (1, 'a'), (2, 'b')", tablePrivSchema),
		fmt.Sprintf("create table %s.write_only (id int primary key)", tablePrivSchema),
		fmt.Sprintf("create table %s.no_grant (id int primary key)", tablePrivSchema),
		fmt.Sprintf("grant select on %s.readable to %s", tablePrivSchema, tablePrivRole),
		fmt.Sprintf("grant insert on %s.write_only to %s", tablePrivSchema, tablePrivRole),
	} {
		if _, err := setupDB.Exec(stmt); err != nil {
			t.Fatalf("setup exec %q: %v", stmt, err)
		}
	}
	t.Cleanup(func() {
		setupDB.Exec(fmt.Sprintf("drop schema if exists %s cascade", tablePrivSchema))
		setupDB.Exec(fmt.Sprintf("drop role if exists %s", tablePrivRole))
	})

	connConfig, err := pgx.ParseConfig(databaseURL)
	if err != nil {
		t.Fatalf("parsing DATABASE_URL: %v", err)
	}
	connConfig.AfterConnect = func(ctx context.Context, pc *pgconn.PgConn) error {
		_, err := pc.Exec(ctx, fmt.Sprintf("set role %s", tablePrivRole)).ReadAll()
		return err
	}
	connStr := stdlib.RegisterConnConfig(connConfig)
	defer stdlib.UnregisterConnConfig(connStr)

	db, err := sql.Open("pgx", connStr)
	if err != nil {
		t.Fatalf("opening under-privileged pool: %v", err)
	}
	defer db.Close()

	source := NewPostgresSource(db, 5)
	ctx := context.Background()
	schema := tablePrivSchema
	opts := QueryOpts{Limit: 10, Offset: 0}

	tables, err := source.ListTables(ctx, &schema)
	if err != nil {
		t.Fatalf("ListTables: %v", err)
	}
	if len(tables) != 1 || tables[0].Name != "readable" {
		t.Fatalf("ListTables must omit write_only (INSERT only) and no_grant (no privilege), got %+v", tables)
	}

	counts, err := source.TableCounts(ctx, &schema)
	if err != nil {
		t.Fatalf("TableCounts: %v", err)
	}
	if len(counts) != 1 || counts[0].Table != "readable" {
		t.Fatalf("TableCounts must track the same set as ListTables, got %+v", counts)
	}

	if _, err := source.QueryTable(ctx, &schema, "readable", opts); err != nil {
		t.Fatalf("readable is SELECT-able: %v", err)
	}

	var notAllowed *NotAllowedError
	if _, err := source.QueryTable(ctx, &schema, "write_only", opts); !errors.As(err, &notAllowed) {
		t.Fatalf("an INSERT-only table must be rejected as NotAllowedError, not a permission-denied 500; got %v", err)
	}
	if _, err := source.QueryTable(ctx, &schema, "no_grant", opts); !errors.As(err, &notAllowed) {
		t.Fatalf("a table the role has no privilege on must be rejected as NotAllowedError; got %v", err)
	}
}

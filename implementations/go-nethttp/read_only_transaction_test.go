package ashurbanipal

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/stdlib"
)

const (
	readOnlyTxSchema = "ashb_test_go_read_only_tx"
	readOnlyTxRole   = "ashb_test_go_read_only_tx_role"
)

// Every operation runs in a read-only transaction (spec/protocol.md §6). A
// row-level security policy that calls a writing function is the one way a
// plain SELECT on a listed table can write; RLS does not apply to a
// superuser, so the source's sessions `set role` to an ordinary role.
func TestASelectThatWouldWriteFailsAndWritesNothing(t *testing.T) {
	databaseURL := requireTestEnv(t, "DATABASE_URL")

	setupDB, err := sql.Open("pgx", databaseURL)
	if err != nil {
		t.Fatalf("opening setup connection: %v", err)
	}
	defer setupDB.Close()

	s, r := readOnlyTxSchema, readOnlyTxRole
	for _, stmt := range []string{
		fmt.Sprintf("drop schema if exists %s cascade", s),
		fmt.Sprintf("drop role if exists %s", r),
		fmt.Sprintf("create role %s nosuperuser", r),
		fmt.Sprintf("grant %s to current_user", r),
		fmt.Sprintf("create schema %s", s),
		fmt.Sprintf("grant usage on schema %s to %s", s, r),
		// The role may insert, so only the read-only transaction stops the write.
		fmt.Sprintf("create table %s.audit (id serial primary key)", s),
		fmt.Sprintf("grant insert on %s.audit to %s", s, r),
		fmt.Sprintf("grant usage on sequence %s.audit_id_seq to %s", s, r),
		fmt.Sprintf("create function %[1]s.log_read() returns boolean language sql volatile "+
			"as $$ insert into %[1]s.audit default values; select true $$", s),
		fmt.Sprintf("create table %s.watched (id int primary key)", s),
		fmt.Sprintf("insert into %s.watched values (1)", s),
		fmt.Sprintf("alter table %s.watched enable row level security", s),
		fmt.Sprintf("create policy log_every_read on %[1]s.watched for select to %[2]s using (%[1]s.log_read())", s, r),
		fmt.Sprintf("grant select on %s.watched to %s", s, r),
	} {
		if _, err := setupDB.Exec(stmt); err != nil {
			t.Fatalf("setup exec %q: %v", stmt, err)
		}
	}
	t.Cleanup(func() {
		setupDB.Exec(fmt.Sprintf("drop schema if exists %s cascade", s))
		setupDB.Exec(fmt.Sprintf("drop role if exists %s", r))
	})

	connConfig, err := pgx.ParseConfig(databaseURL)
	if err != nil {
		t.Fatalf("parsing DATABASE_URL: %v", err)
	}
	connConfig.AfterConnect = func(ctx context.Context, pc *pgconn.PgConn) error {
		_, err := pc.Exec(ctx, fmt.Sprintf("set role %s", r)).ReadAll()
		return err
	}
	connStr := stdlib.RegisterConnConfig(connConfig)
	defer stdlib.UnregisterConnConfig(connStr)
	db, err := sql.Open("pgx", connStr)
	if err != nil {
		t.Fatalf("opening role pool: %v", err)
	}
	defer db.Close()

	schema := s
	_, err = NewPostgresSource(db, 5).QueryTable(context.Background(), &schema, "watched", QueryOpts{Limit: 10})
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "25006" {
		t.Fatalf("expected a read-only transaction error (25006), got %v", err)
	}

	var written int
	if err := setupDB.QueryRow(fmt.Sprintf("select count(*) from %s.audit", s)).Scan(&written); err != nil {
		t.Fatal(err)
	}
	if written != 0 {
		t.Fatalf("the policy wrote %d rows", written)
	}
}

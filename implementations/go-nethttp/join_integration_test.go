package ashurbanipal

import (
	"context"
	"database/sql"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
)

// Regression tests for spec/protocol.md §5.11 against Postgres catalog types
// the conformance seed cannot vary: enum identity, arrays, and the timeout
// label. One schema per test so they cannot race each other's DDL.

func pgSource(t *testing.T, timeoutSecs int) *PostgresSource {
	t.Helper()
	db, err := sql.Open("pgx", os.Getenv("DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return NewPostgresSource(db, timeoutSecs)
}

func pairJoin(t *testing.T, leftTable, leftCol, rightTable, rightCol string) JoinSpec {
	t.Helper()
	spec, err := ParseJoin(fmt.Sprintf(
		`{"table":%q,"joins":[{"type":"inner","table":%q,"on":[{"left":{"join":0,"column":%q},"right":%q}]}]}`,
		leftTable, rightTable, leftCol, rightCol))
	if err != nil {
		t.Fatal(err)
	}
	return spec
}

func TestJoinEnumsPairOnlyWithinOneTypeAndArraysNeverJoin(t *testing.T) {
	const schema = "ashb_test_go_join_types"
	setupSchemaDDL(t, schema, fmt.Sprintf(
		`create type %[1]s.mood as enum ('ok', 'sad');
		 create type %[1]s.size as enum ('s', 'm');
		 create table %[1]s.a (id int primary key, m %[1]s.mood, z %[1]s.size, tags text[], n numeric);
		 create table %[1]s.b (id int primary key, m %[1]s.mood, z %[1]s.size, tags text[], n bigint);
		 insert into %[1]s.a values (1, 'ok', 's', '{x}', 1.0);
		 insert into %[1]s.b values (1, 'ok', 's', '{x}', 1);`, schema))
	source := pgSource(t, 5)
	ctx := context.Background()
	s := schema

	data, err := source.QueryJoin(ctx, &s, pairJoin(t, "a", "m", "b", "m"), JoinOpts{Limit: 10})
	if err != nil || len(data.Rows) != 1 {
		t.Fatalf("same enum: %v %+v", err, data)
	}
	if _, err := source.QueryJoin(ctx, &s, pairJoin(t, "a", "m", "b", "z"), JoinOpts{Limit: 10}); err == nil {
		t.Error("different enum types must be rejected")
	} else if _, ok := err.(*BadJoinError); !ok {
		t.Errorf("want *BadJoinError, got %T", err)
	}
	if _, err := source.QueryJoin(ctx, &s, pairJoin(t, "a", "tags", "b", "tags"), JoinOpts{Limit: 10}); err == nil {
		t.Error("arrays must not be joinable")
	}
	mixed, err := source.QueryJoin(ctx, &s, pairJoin(t, "a", "n", "b", "n"), JoinOpts{Limit: 10})
	if err != nil || len(mixed.Rows) != 1 {
		t.Errorf("numeric and bigint are one class: %v %+v", err, mixed)
	}
}

func TestSlowJoinIsAQueryTimeoutAndReleasesTheConnection(t *testing.T) {
	const schema = "ashb_test_go_join_slow"
	setupSchemaDDL(t, schema, fmt.Sprintf(
		`create table %[1]s.a as select g as id, g %% 2 as k from generate_series(1, 20000) g;
		 create table %[1]s.b as select g as id, g %% 2 as k from generate_series(1, 20000) g;`, schema))
	source := pgSource(t, 1)
	ctx := context.Background()
	s := schema

	sortCol := "id"
	start := time.Now()
	_, err := source.QueryJoin(ctx, &s, pairJoin(t, "a", "k", "b", "k"), JoinOpts{Limit: 10, Sort: &sortCol, Descending: true})
	if err == nil || !isQueryTimeout(err) {
		t.Fatalf("want a query timeout, got %v", err)
	}
	if time.Since(start) > 5*time.Second {
		t.Errorf("the timeout took %v", time.Since(start))
	}
	rec := httptest.NewRecorder()
	writeError(rec, err)
	if rec.Code != http.StatusInternalServerError || !strings.Contains(rec.Body.String(), `"code":"query_timeout"`) {
		t.Errorf("wire answer = %d %s", rec.Code, rec.Body.String())
	}

	ok, err := source.QueryJoin(ctx, &s, pairJoin(t, "a", "id", "b", "id"), JoinOpts{Limit: 10})
	if err != nil || len(ok.Rows) != 10 || !ok.HasMore {
		t.Errorf("the pool must still work after a timeout: %v %+v", err, ok)
	}
}

package ashurbanipal

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
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
	db, err := sql.Open("pgx", requireTestEnv(t, "DATABASE_URL"))
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

// Postgres rejects a comparison of two different explicit collations, while
// the default collation yields to an explicit one; the metadata reports only
// the explicit ones.
func TestTextColumnsWithClashingCollationsDoNotJoin(t *testing.T) {
	const schema = "ashb_test_go_join_collation"
	setupSchemaDDL(t, schema, fmt.Sprintf(
		`create table %[1]s.a (id int primary key, c text collate "C", p text collate "POSIX", d text);
		 create table %[1]s.b (id int primary key, c text collate "C", p text collate "C", d text);
		 insert into %[1]s.a values (1, 'x', 'x', 'x');
		 insert into %[1]s.b values (1, 'x', 'x', 'x');`, schema))
	source := pgSource(t, 5)
	ctx := context.Background()
	s := schema

	table, err := source.QueryTable(ctx, &s, "a", QueryOpts{Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, c := range table.Columns {
		got = append(got, c.Collation)
	}
	if fmt.Sprint(got) != fmt.Sprint([]string{"", "C", "POSIX", ""}) {
		t.Errorf("collations = %q", got)
	}

	for _, pair := range [][2]string{{"c", "c"}, {"c", "d"}, {"d", "c"}, {"d", "d"}} {
		data, err := source.QueryJoin(ctx, &s, pairJoin(t, "a", pair[0], "b", pair[1]), JoinOpts{Limit: 10})
		if err != nil || len(data.Rows) != 1 {
			t.Errorf("%s to %s: %v %+v", pair[0], pair[1], err, data)
		}
	}
	_, err = source.QueryJoin(ctx, &s, pairJoin(t, "a", "p", "b", "p"), JoinOpts{Limit: 10})
	if bad, ok := err.(*BadJoinError); !ok || !strings.Contains(bad.Reason, "different text collations") {
		t.Errorf("want a collation clash, got %v", err)
	}
}

// A json, xml or geometric column has no ordering operator, so a sort on it is
// a 400 unsortable_column, not a 500; jsonb sorts, and a domain over it reports
// the json class.
func TestSortingAnUnorderableColumnIsAClientError(t *testing.T) {
	const schema = "ashb_test_go_join_sort"
	setupSchemaDDL(t, schema, fmt.Sprintf(
		`create domain %[1]s.settings as jsonb;
		 create table %[1]s.a (id int primary key, doc json, bag jsonb, dom %[1]s.settings);
		 create table %[1]s.b (id int primary key);
		 insert into %[1]s.a values (1, '{}', '{}', '{}'), (2, '[]', '[]', '[]');
		 insert into %[1]s.b values (1);`, schema))
	source := pgSource(t, 5)
	ctx := context.Background()
	s := schema
	doc, join0 := "doc", 0

	_, err := source.QueryTable(ctx, &s, "a", QueryOpts{Limit: 10, Sort: &doc})
	var unsortable *UnsortableError
	if !errors.As(err, &unsortable) || unsortable.Column != "doc" {
		t.Fatalf("table sort on json: got %v", err)
	}
	_, err = source.QueryJoin(ctx, &s, pairJoin(t, "a", "id", "b", "id"), JoinOpts{Limit: 10, Sort: &doc, SortJoin: &join0})
	if !errors.As(err, &unsortable) {
		t.Fatalf("join sort on json: got %v", err)
	}
	rec := httptest.NewRecorder()
	writeError(rec, err)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), `"code":"unsortable_column"`) {
		t.Errorf("response = %d %s", rec.Code, rec.Body)
	}

	for _, column := range []string{"bag", "dom", "id"} {
		c := column
		if _, err := source.QueryTable(ctx, &s, "a", QueryOpts{Limit: 10, Sort: &c}); err != nil {
			t.Errorf("sorting by %s: %v", column, err)
		}
	}
	table, err := source.QueryTable(ctx, &s, "a", QueryOpts{Limit: 10})
	if err != nil || table.Columns[3].Class != "json" {
		t.Errorf("domain over jsonb: %v %+v", err, table.Columns)
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

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
)

func uuidCol(name string) colMeta {
	return colMeta{name: name, typeName: "uuid", class: classUUID}
}

func textCol(name string) colMeta {
	return colMeta{name: name, typeName: "text", class: classText}
}

func testOrdersUsers() []tableMeta {
	return []tableMeta{
		{schema: "public", name: "orders", columns: []colMeta{uuidCol("id"), uuidCol("user_id")}, orderKeys: []int{0}},
		{schema: "public", name: "users", columns: []colMeta{uuidCol("id"), textCol("email")}, orderKeys: []int{0}},
	}
}

const testJoinJSON = `{"table":"orders","joins":[{"type":"left","table":"users",
	"on":[{"left":{"join":0,"column":"user_id"},"right":"id"}]}]}`

// Planning and SQL building are covered per engine by spec/fixtures/join-builder-tests.json (join_fixture_test.go).

func TestAFloatKeySaysWhyItCannotJoin(t *testing.T) {
	spec, _ := ParseJoin(testJoinJSON)
	metas := testOrdersUsers()
	metas[0].columns = append(metas[0].columns, colMeta{name: "score", typeName: "double precision", class: classFloat})
	spec.Joins[0].On[0].Left.Column = "score"
	_, err := planJoin(spec, metas, JoinOpts{})
	bad, ok := err.(*BadJoinError)
	if !ok || !strings.Contains(bad.Reason, "orders.score (double precision)") || !strings.Contains(bad.Reason, "floating-point values are not compared exactly") {
		t.Errorf("float key must say why it cannot join, got %v", err)
	}
}

func TestATableInAnotherSchemaIsReportedUnderIt(t *testing.T) {
	spec, err := ParseJoin(testJoinJSON)
	if err != nil {
		t.Fatal(err)
	}
	tables := testOrdersUsers()
	tables[1].schema = "warehouse"
	plan, err := planJoin(spec, tables, JoinOpts{})
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range plan.columnInfos("public") {
		want := ""
		if c.Table == "users" {
			want = "warehouse"
		}
		if c.Schema != want {
			t.Errorf("%s.%s schema = %q, want %q", c.Table, c.Column, c.Schema, want)
		}
	}
}

func TestOnlyATextColumnReportsItsCollation(t *testing.T) {
	bin := "utf8mb4_bin"
	text := colMeta{name: "name", typeName: "varchar(20)", class: classText, collation: &bin}
	doc := colMeta{name: "doc", typeName: "json", class: classJSON, collation: &bin}
	if got := text.columnInfo().Collation; got != bin {
		t.Errorf("text collation = %q", got)
	}
	if got := doc.columnInfo().Collation; got != "" {
		t.Errorf("a json column reported collation %q", got)
	}
}

func TestValueForms(t *testing.T) {
	for _, c := range []struct {
		form valueForm
		v    string
		ok   bool
	}{
		{formMysqlDecimal, "-12", true},
		{formMysqlDecimal, "+3.25", true},
		{formMysqlDecimal, "0.5", true},
		{formMysqlDecimal, ".5", false},
		{formMysqlDecimal, "5.", false},
		{formMysqlDecimal, "1e3", false},
		{formMysqlDecimal, "abc", false},
		{formMysqlDecimal, "", false},
		{formMysqlDecimal, "NaN", false},
		{formMysqlDecimal, strings.Repeat("9", 35), true},
		{formMysqlDecimal, strings.Repeat("9", 36), false},
		{formMysqlFloat, "1.5e-3", true},
		{formMysqlFloat, "2E10", true},
		{formMysqlFloat, "1e", false},
		{formMysqlFloat, "NaN", false},
		{formMysqlDate, "2016-02-29", true},
		{formMysqlDate, "2015-02-29", false},
		{formMysqlDate, "2016-02-30", false},
		{formMysqlDate, "0000-00-00", true},
		{formMysqlDate, "0000-01-01", false},
		{formMysqlDate, "12000-01-01", false},
		{formMysqlDate, "2016-01-01 10:00", false},
		{formMysqlDatetime, "2016-01-01", true},
		{formMysqlDatetime, "2016-01-01 10:30", true},
		{formMysqlDatetime, "2016-01-01T10:30:00.123456", true},
		{formMysqlDatetime, "0000-00-00 00:00:00", true},
		{formMysqlDatetime, "2016-01-01T10:30:00.1234567", false},
		{formMysqlDatetime, "2016-01-01T10:30:00Z", false},
		{formMysqlDatetime, "2016-01-01 ", false},
		{formMysqlDatetime, "2016-01-01 24:00", false},
		{formMysqlTime, "23:59:59", true},
		{formMysqlTime, "-01:00:00", true},
		{formMysqlTime, "100:00:00.5", true},
		{formMysqlTime, "838:59:59", true},
		{formMysqlTime, "839:00:00", false},
		{formMysqlTime, "9:30", false},
		{formMysqlTime, "10:60", false},
		{formPgNumeric, "-12", true},
		{formPgNumeric, strings.Repeat("9", 40), true},
		{formPgNumeric, "NaN", true},
		{formPgNumeric, "-Infinity", true},
		{formPgNumeric, "1e3", false},
		{formPgNumeric, "abc", false},
		{formPgFloat, "1e+300", true},
		{formPgFloat, "infinity", true},
		{formPgFloat, "1e", false},
		{formPgDate, "2016-02-29", true},
		{formPgDate, "2016-02-30", false},
		{formPgDate, "12000-01-01", true},
		{formPgDate, "0044-03-15 BC", true},
		{formPgDate, "0001-02-29 BC", true},
		{formPgDate, "0002-02-29 BC", false},
		{formPgDate, "infinity", true},
		{formPgDate, "-infinity", true},
		{formPgDate, "0000-01-01", false},
		{formPgDate, "0000-00-00", false},
		{formPgTimestamp, "2016-01-01 10:30", true},
		{formPgTimestamp, "0044-03-15 10:00:00 BC", true},
		{formPgTimestamp, "12000-01-01 10:00:00", true},
		{formPgTimestamp, "2016-01-01 24:00:00", true},
		{formPgTimestamp, "infinity", true},
		{formPgTimestamp, "2016-01-01T10:30:00Z", false},
		{formPgTime, "23:59:59", true},
		{formPgTime, "24:00", true},
		{formPgTime, "24:00:00.000", true},
		{formPgTime, "24:00:01", false},
		{formPgTime, "10:60", false},
		{formPgTime, "9:30", false},
		{formPgTime, "10:00+02", false},
		{formPgTimestampTz, "2016-01-01 10:00:00+00", true},
		{formPgTimestampTz, "2016-01-01T10:00:00.5+05:30", true},
		{formPgTimestampTz, "1890-01-01 00:00:00+00:53:28", true},
		{formPgTimestampTz, "0044-03-15 10:00:00+00:53:28 BC", true},
		{formPgTimestampTz, "2016-01-01 10:00-0300", true},
		{formPgTimestampTz, "2016-01-01 10:00Z", true},
		{formPgTimestampTz, "2016-01-01", true},
		{formPgTimestampTz, "-infinity", true},
		{formPgTimestampTz, "2016-01-01Z", false},
		{formPgTimestampTz, "2016-01-01 10:00+5", false},
		{formPgTimestampTz, "2016-01-01 10:00+05:3", false},
		{formPgTimeTz, "10:00:00+02", true},
		{formPgTimeTz, "24:00:00+00", true},
		{formPgTimeTz, "10:00", true},
		{formPgTimeTz, "10:00+", false},
	} {
		if got := c.form.accepts(c.v); got != c.ok {
			t.Errorf("%v accepts %q = %v, want %v", c.form, c.v, got, c.ok)
		}
	}
}

func TestParseFilterJoinKeyOnlyOnTheJoinRoute(t *testing.T) {
	raw := `[{"join":1,"column":"email","op":"IS NULL"}]`
	if _, err := ParseFilter(raw); err == nil {
		t.Error("/tables/data must reject a join key")
	}
	conditions, err := ParseFilterForJoin(raw)
	if err != nil || conditions[0].Join == nil || *conditions[0].Join != 1 {
		t.Errorf("join route must accept it: %v %+v", err, conditions)
	}
}

func TestWriteErrorNamesTimeoutsAndBadJoins(t *testing.T) {
	for _, tc := range []struct {
		err    error
		status int
		code   string
	}{
		{context.DeadlineExceeded, http.StatusInternalServerError, "query_timeout"},
		{fmt.Errorf("wrapped: %w", context.DeadlineExceeded), http.StatusInternalServerError, "query_timeout"},
		{badJoin("x"), http.StatusBadRequest, "invalid_join"},
		{&BadParamError{Reason: "x"}, http.StatusBadRequest, "invalid_parameter"},
		{sql.ErrConnDone, http.StatusInternalServerError, "database_error"},
	} {
		rec := httptest.NewRecorder()
		writeError(rec, tc.err)
		if rec.Code != tc.status || !strings.Contains(rec.Body.String(), `"code":"`+tc.code+`"`) {
			t.Errorf("%v: got %d %s, want %d %s", tc.err, rec.Code, rec.Body.String(), tc.status, tc.code)
		}
	}
}

func TestDatabaseErrorTitleCarriesNoEngineText(t *testing.T) {
	rec := httptest.NewRecorder()
	writeError(rec, errors.New("select secret from t"))
	if body := rec.Body.String(); strings.Contains(body, "secret") || !strings.Contains(body, `"title":"database error"`) {
		t.Errorf("got %s, want title \"database error\" with no engine text", body)
	}
}

func TestPgColumnClass(t *testing.T) {
	cases := []struct {
		dataType, schema, udt string
		enum                  bool
		want                  columnClass
	}{
		{"integer", "", "", false, classNumber},
		{"numeric", "", "", false, classNumber},
		{"character varying", "", "", false, classText},
		{"uuid", "", "", false, classUUID},
		{"smallint", "", "", false, classNumber},
		{"date", "", "", false, classTemporal},
		{"timestamp without time zone", "", "", false, classTemporal},
		{"timestamp with time zone", "", "", false, classTemporal},
		{"time without time zone", "", "", false, classTime},
		{"time with time zone", "", "", false, classTime},
		{"ARRAY", "", "", false, classArray},
		{"json", "", "", false, classJSON},
		{"jsonb", "", "", false, classJSON},
		{"double precision", "", "", false, classFloat},
		{"real", "", "", false, classFloat},
		{"money", "", "", false, classOther},
		{"USER-DEFINED", "public", "citext", false, classText},
		{"USER-DEFINED", "public", "geometry", false, classOther},
		{"USER-DEFINED", "public", "mood", true, classEnum("public.mood")},
	}
	for _, c := range cases {
		if got := pgColumnClass(c.dataType, c.schema, c.udt, c.enum); got != c.want {
			t.Errorf("%s: got %v want %v", c.dataType, got, c.want)
		}
	}
}

func TestParseFilterRejectsAKeyInAnotherCase(t *testing.T) {
	if _, err := ParseFilter(`[{"COLUMN":"a","op":"IS NULL"}]`); err == nil {
		t.Error("a key spelled in another case must be rejected")
	}
	if _, err := ParseFilter(`[{"column":"a","op":"IS NULL"}]`); err != nil {
		t.Errorf("the documented keys must still parse: %v", err)
	}
}

func TestAMySQLZeroDateComparesTheColumnsTextOnTheTableRoute(t *testing.T) {
	table := tableMeta{name: "t", columns: []colMeta{{
		name: "d", typeName: "date", class: classTemporal,
		compare: &typedCompare{form: formMysqlDate},
	}}}
	for _, c := range []struct {
		cond Condition
		want string
	}{
		{Condition{Column: "d", Op: "=", Value: StringValue("2016-02-29")}, ` where ("d" = $3)`},
		{Condition{Column: "d", Op: "=", Value: StringValue("0000-00-00")}, ` where ("d"::text = $3)`},
		{Condition{Column: "d", Op: "IN", Value: &FilterValue{Items: []string{"2016-02-29", "0000-00-00"}, List: true}}, ` where ("d"::text IN ($3, $4))`},
	} {
		sql, _, err := tableWhereClause([]Condition{c.cond}, table, pgJoinDialect)
		if err != nil || sql != c.want {
			t.Errorf("%v: got %q, %v; want %q", c.cond.Value.Items, sql, err, c.want)
		}
	}
}

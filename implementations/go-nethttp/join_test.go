package ashurbanipal

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
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
		{schema: "public", name: "orders", columns: []colMeta{uuidCol("id"), uuidCol("user_id"), textCol("status"), {name: "tags", typeName: "ARRAY", class: classArray}}, orderKeys: []int{0}},
		{schema: "public", name: "users", columns: []colMeta{uuidCol("id"), textCol("email")}, orderKeys: []int{0}},
	}
}

const testJoinJSON = `{"table":"orders","joins":[{"type":"left","table":"users",
	"on":[{"left":{"join":0,"column":"user_id"},"right":"id"}]}]}`

func TestTieBreakPrefersThePrimaryKeyThenTheShortestUniqueKey(t *testing.T) {
	cols := testOrdersUsers()[0].columns
	pk := uniqueKey{name: "z_pkey", primary: true, columns: []string{"status", "id"}}
	short := uniqueKey{name: "b", columns: []string{"user_id"}}
	tied := uniqueKey{name: "a", columns: []string{"status"}}
	hidden := uniqueKey{name: "0", columns: []string{"hidden"}}
	if got := tieBreakKeys(cols, []uniqueKey{short, pk}); !slices.Equal(got, []int{2, 0}) {
		t.Errorf("primary key = %v", got)
	}
	if got := tieBreakKeys(cols, []uniqueKey{short, tied, hidden}); !slices.Equal(got, []int{2}) {
		t.Errorf("shortest, then lowest name = %v", got)
	}
	if got := tieBreakKeys(cols, nil); len(got) != 0 {
		t.Errorf("no key = %v", got)
	}
}

func TestOrderByLeavesOutAKeyAlreadyUsedAsSort(t *testing.T) {
	render := func(i int) string { return fmt.Sprintf("c%d", i) }
	one := 1
	if got := orderByClause(&one, []int{1, 0}, true, render); got != " order by c1 desc, c0 desc" {
		t.Errorf("got %q", got)
	}
	// order applies only with a sort.
	if got := orderByClause(nil, []int{0}, true, render); got != " order by c0 asc" {
		t.Errorf("got %q", got)
	}
	if got := orderByClause[int](nil, nil, false, render); got != "" {
		t.Errorf("got %q", got)
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

func TestParseJoinAcceptsAValidJoin(t *testing.T) {
	spec, err := ParseJoin(testJoinJSON)
	if err != nil {
		t.Fatal(err)
	}
	refs := spec.TableRefs()
	if len(refs) != 2 || refs[0].Table != "orders" || refs[1].Table != "users" || refs[0].Schema != nil || refs[1].Schema != nil {
		t.Errorf("table refs = %+v", refs)
	}
	if !spec.Joins[0].Left {
		t.Error("type left must set Left")
	}
}

func TestParseJoinRejectsStructuralViolations(t *testing.T) {
	pair := `{"left":{"join":0,"column":"a"},"right":"b"}`
	entry := fmt.Sprintf(`{"type":"left","table":"u","on":[%s]}`, pair)
	cases := map[string]string{
		"not json":            "not json",
		"array":               "[]",
		"no joins":            `{"table":"o","joins":[]}`,
		"missing table":       fmt.Sprintf(`{"joins":[%s]}`, entry),
		"right join":          `{"table":"o","joins":[{"type":"right","table":"u","on":[` + pair + `]}]}`,
		"uppercase type":      `{"table":"o","joins":[{"type":"LEFT","table":"u","on":[` + pair + `]}]}`,
		"no pairs":            `{"table":"o","joins":[{"type":"left","table":"u","on":[]}]}`,
		"four pairs":          `{"table":"o","joins":[{"type":"left","table":"u","on":[` + strings.Join([]string{pair, pair, pair, pair}, ",") + `]}]}`,
		"forward position":    `{"table":"o","joins":[{"type":"left","table":"u","on":[{"left":{"join":1,"column":"a"},"right":"b"}]}]}`,
		"negative position":   `{"table":"o","joins":[{"type":"left","table":"u","on":[{"left":{"join":-1,"column":"a"},"right":"b"}]}]}`,
		"operator key":        `{"table":"o","joins":[{"type":"left","table":"u","on":[{"left":{"join":0,"column":"a"},"right":"b","op":">"}]}]}`,
		"missing right":       `{"table":"o","joins":[{"type":"left","table":"u","on":[{"left":{"join":0,"column":"a"}}]}]}`,
		"empty columns":       `{"table":"o","joins":[` + entry + `],"columns":[]}`,
		"duplicate columns":   `{"table":"o","joins":[` + entry + `],"columns":[{"join":0,"column":"a"},{"join":0,"column":"a"}]}`,
		"five tables":         `{"table":"o","joins":[` + strings.Join([]string{entry, entry, entry, entry}, ",") + `]}`,
		"trailing data":       testJoinJSON + ` {}`,
		"oversize":            `{"table":"` + strings.Repeat("t", MaxJoinBytes) + `","joins":[]}`,
		"unknown top key":     `{"table":"o","joins":[` + entry + `],"x":1}`,
		"key in another case": fmt.Sprintf(`{"TABLE":"o","Joins":[%s]}`, entry),
		"nested key case":     `{"table":"o","joins":[{"Type":"left","table":"u","on":[` + pair + `]}]}`,
		"fractional position": `{"table":"o","joins":[{"type":"left","table":"u","on":[{"left":{"join":0.5,"column":"a"},"right":"b"}]}]}`,
	}
	for name, raw := range cases {
		if _, err := ParseJoin(raw); err == nil {
			t.Errorf("%s: want an error", name)
		} else if _, ok := err.(*BadJoinError); !ok {
			t.Errorf("%s: want *BadJoinError, got %T", name, err)
		}
	}
	four := `{"table":"o","joins":[` + strings.Join([]string{entry, entry, entry}, ",") + `]}`
	if _, err := ParseJoin(four); err != nil {
		t.Errorf("4 tables is the limit and must parse: %v", err)
	}
}

func TestPlanJoinRejectsUnknownNamesAndIncompatiblePairs(t *testing.T) {
	spec, _ := ParseJoin(testJoinJSON)
	if _, err := planJoin(spec, testOrdersUsers(), JoinOpts{}); err != nil {
		t.Fatalf("valid join: %v", err)
	}

	hostile := spec
	hostile.Joins = []JoinEntry{{Left: true, Table: "users", On: []OnPair{{Left: ColumnPos{Join: 0, Column: "user_id"}, Right: `id"; drop table users; --`}}}}
	if _, err := planJoin(hostile, testOrdersUsers(), JoinOpts{}); err == nil {
		t.Error("unknown column must be rejected")
	} else if _, ok := err.(*BadJoinError); !ok {
		t.Errorf("want *BadJoinError, got %v", err)
	}

	cross := spec
	cross.Joins = []JoinEntry{{Table: "users", On: []OnPair{{Left: ColumnPos{Join: 0, Column: "status"}, Right: "id"}}}}
	_, err := planJoin(cross, testOrdersUsers(), JoinOpts{})
	bad, ok := err.(*BadJoinError)
	if !ok || !strings.Contains(bad.Reason, "orders.status (text)") || !strings.Contains(bad.Reason, "users.id (uuid)") {
		t.Errorf("text to uuid must name both columns, got %v", err)
	}

	array := spec
	array.Joins = []JoinEntry{{Table: "users", On: []OnPair{{Left: ColumnPos{Join: 0, Column: "tags"}, Right: "id"}}}}
	if _, err := planJoin(array, testOrdersUsers(), JoinOpts{}); err == nil {
		t.Error("array column must not be joinable")
	}

	metas := testOrdersUsers()
	metas[0].columns = append(metas[0].columns, colMeta{name: "score", typeName: "double precision", class: classFloat})
	float := spec
	float.Joins = []JoinEntry{{Table: "users", On: []OnPair{{Left: ColumnPos{Join: 0, Column: "score"}, Right: "id"}}}}
	_, err = planJoin(float, metas, JoinOpts{})
	bad, ok = err.(*BadJoinError)
	if !ok || !strings.Contains(bad.Reason, "orders.score (double precision)") || !strings.Contains(bad.Reason, "floating-point values are not compared exactly") {
		t.Errorf("float key must say why it cannot join, got %v", err)
	}
}

func TestPlanJoinEnumsPairOnlyWithinOneType(t *testing.T) {
	enumA, enumB := classEnum("public.a"), classEnum("public.b")
	tables := []tableMeta{
		{name: "x", columns: []colMeta{{name: "e", typeName: "USER-DEFINED", class: enumA}}},
		{name: "y", columns: []colMeta{{name: "e", typeName: "USER-DEFINED", class: enumA}, {name: "f", typeName: "USER-DEFINED", class: enumB}}},
	}
	spec := JoinSpec{Table: "x", Joins: []JoinEntry{{Table: "y", On: []OnPair{{Left: ColumnPos{Column: "e"}, Right: "e"}}}}}
	if _, err := planJoin(spec, tables, JoinOpts{}); err != nil {
		t.Errorf("same enum: %v", err)
	}
	spec.Joins[0].On[0].Right = "f"
	if _, err := planJoin(spec, tables, JoinOpts{}); err == nil {
		t.Error("different enums must be rejected")
	}
}

func TestPlanJoinTextCollationClash(t *testing.T) {
	bin, ci := "utf8mb4_bin", "utf8mb4_general_ci"
	a, b := textCol("v"), textCol("v")
	a.collation, b.collation = &bin, &ci
	tables := []tableMeta{{name: "ca", columns: []colMeta{a}}, {name: "cb", columns: []colMeta{b}}}
	spec := JoinSpec{Table: "ca", Joins: []JoinEntry{{Table: "cb", On: []OnPair{{Left: ColumnPos{Column: "v"}, Right: "v"}}}}}
	_, err := planJoin(spec, tables, JoinOpts{})
	if bad, ok := err.(*BadJoinError); !ok || !strings.Contains(bad.Reason, "collation") {
		t.Errorf("want a collation BadJoinError, got %v", err)
	}
}

func TestAssignJoinLabelsAreUniqueAndStable(t *testing.T) {
	got := assignJoinLabels([]string{"id", "id", "email", "id_1"}, []int{0, 1, 1, 0})
	want := []string{"id_0", "id_1_2", "email", "id_1"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("labels = %v, want %v", got, want)
	}
	got = assignJoinLabels([]string{"id", "id", "email"}, []int{0, 1, 1})
	want = []string{"id_0", "id_1", "email"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("labels = %v, want %v", got, want)
	}
}

func TestBuildJoinSelectUsesCatalogNamesAndGeneratedAliasesOnly(t *testing.T) {
	spec, _ := ParseJoin(testJoinJSON)
	email := "a@b.c"
	or := "OR"
	sort, sortJoin := "email", 1
	plan, err := planJoin(spec, testOrdersUsers(), JoinOpts{
		Sort: &sort, SortJoin: &sortJoin,
		Filter: []Condition{
			{Column: "email", Op: "=", Value: StringValue(email), Join: &sortJoin},
			{Logic: &or, Not: true, Column: "status", Op: "IS NULL"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	sqlText, values := buildJoinSelect(plan, pgJoinDialect)
	for _, want := range []string{
		`t0."id"::text as c0, `,
		` from "public"."orders" t0 left join "public"."users" t1 on t1."id" = t0."user_id"`,
		` where (t1."email"::text = $3) OR (NOT (t0."status" IS NULL))`,
		` order by t1."email" asc, t0."id" asc limit $1 offset $2`,
	} {
		if !strings.Contains(sqlText, want) {
			t.Errorf("sql missing %q:\n%s", want, sqlText)
		}
	}
	if len(values) != 1 || values[0] != email {
		t.Errorf("values = %v", values)
	}
}

func TestTypedColumnsCompareInTheirOwnType(t *testing.T) {
	spec, _ := ParseJoin(testJoinJSON)
	tables := testOrdersUsers()
	tables[0].columns = append(tables[0].columns, colMeta{
		name: "total", typeName: "integer", class: classNumber, compare: pgTypedCompare("integer"),
	})
	and, or := "AND", "OR"
	list := func(v ...string) *FilterValue { return &FilterValue{Items: v, List: true} }
	plan, err := planJoin(spec, tables, JoinOpts{Filter: []Condition{
		{Column: "total", Op: "BETWEEN", Value: list("1", "9.5")},
		{Logic: &and, Not: true, Column: "status", Op: "IN", Value: list("a", "b")},
		{Logic: &or, Column: "total", Op: "LIKE", Value: StringValue("1%")},
	}})
	if err != nil {
		t.Fatal(err)
	}
	sqlText, values := buildJoinSelect(plan, pgJoinDialect)
	want := ` where (t0."total" BETWEEN $3::int8 AND $4::numeric) AND (NOT (t0."status"::text IN ($5, $6))) OR (t0."total"::text LIKE $7)`
	if !strings.Contains(sqlText, want) {
		t.Errorf("sql missing %q:\n%s", want, sqlText)
	}
	if !slices.Equal(values, []string{"1", "9.5", "a", "b", "1%"}) {
		t.Errorf("values = %v", values)
	}
	_, err = planJoin(spec, tables, JoinOpts{Filter: []Condition{{Column: "total", Op: "IN", Value: list("1", "x")}}})
	var fe *FilterError
	if !errors.As(err, &fe) || !strings.Contains(fe.Reason, `"x"`) || !strings.Contains(fe.Reason, `"total"`) {
		t.Errorf("bad value err = %v", err)
	}
}

func TestValueForms(t *testing.T) {
	for _, c := range []struct {
		form valueForm
		v    string
		ok   bool
	}{
		{formNumber, "-12", true}, {formNumber, "+3.25", true}, {formNumber, ".5", false},
		{formNumber, "5.", false}, {formNumber, "1e3", false}, {formNumber, "abc", false},
		{formNumber, strings.Repeat("9", 35), true}, {formNumber, strings.Repeat("9", 36), false},
		{formFloat, "1.5e-3", true}, {formFloat, "2E10", true}, {formFloat, "1e", false}, {formFloat, "NaN", false},
		{formDate, "2016-02-29", true}, {formDate, "2015-02-29", false}, {formDate, "0000-01-01", false},
		{formDate, "2016-01-01 10:00", false},
		{formTimestamp, "2016-01-01", true}, {formTimestamp, "2016-01-01T10:30:00.123456", true},
		{formTimestamp, "2016-01-01T10:30:00.1234567", false}, {formTimestamp, "2016-01-01T10:30:00Z", false},
		{formTimestamp, "2016-01-01 ", false},
		{formTime, "23:59:59", true}, {formTime, "24:00", false}, {formTime, "9:30", false},
		{formTime, "10:00+02", false}, {formTimestampTz, "2016-01-01 10:00:00+00", true},
		{formTimestampTz, "2016-01-01T10:00:00.5+05:30", true}, {formTimestampTz, "1890-01-01 00:00:00+00:53:28", true},
		{formTimestampTz, "2016-01-01 10:00-0300", true}, {formTimestampTz, "2016-01-01 10:00Z", true},
		{formTimestampTz, "2016-01-01", true}, {formTimestampTz, "2016-01-01Z", false},
		{formTimestampTz, "2016-01-01 10:00+5", false}, {formTimestampTz, "2016-01-01 10:00+05:3", false},
		{formTimeTz, "10:00:00+02", true}, {formTimeTz, "10:00", true}, {formTimeTz, "10:00+", false},
	} {
		if got := c.form.accepts(c.v); got != c.ok {
			t.Errorf("%v accepts %q = %v, want %v", c.form, c.v, got, c.ok)
		}
	}
}

func TestPlanJoinRangeChecksFilterAndSortPositions(t *testing.T) {
	spec, _ := ParseJoin(testJoinJSON)
	two := 2
	if _, err := planJoin(spec, testOrdersUsers(), JoinOpts{Filter: []Condition{{Column: "id", Op: "IS NULL", Join: &two}}}); err == nil {
		t.Error("filter position out of range")
	} else if _, ok := err.(*FilterError); !ok {
		t.Errorf("want *FilterError, got %T", err)
	}
	one := 1
	if _, err := planJoin(spec, testOrdersUsers(), JoinOpts{SortJoin: &one}); err == nil {
		t.Error("sort_join without sort")
	}
	email := "email"
	if _, err := planJoin(spec, testOrdersUsers(), JoinOpts{Sort: &email}); err == nil {
		t.Error("email is not a column of position 0")
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
		{"timestamp with time zone", "", "", false, classTemporal},
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

func TestEachTableMayNameItsOwnSchema(t *testing.T) {
	spec, err := ParseJoin(`{"table":"shipments","schema":"warehouse","joins":[{"type":"left","table":"orders",
		"schema":"public","on":[{"left":{"join":0,"column":"order_id"},"right":"id"}]}]}`)
	if err != nil {
		t.Fatal(err)
	}
	refs := spec.TableRefs()
	if *refs[0].Schema != "warehouse" || *refs[1].Schema != "public" {
		t.Errorf("table refs = %+v", refs)
	}
	for _, bad := range []string{
		`{"table":"orders","schema":null,"joins":[{"type":"left","table":"users","on":[{"left":{"join":0,"column":"user_id"},"right":"id"}]}]}`,
		`{"table":"orders","joins":[{"type":"left","table":"users","schema":null,"on":[{"left":{"join":0,"column":"user_id"},"right":"id"}]}]}`,
		`{"table":"orders","schema":1,"joins":[{"type":"left","table":"users","on":[{"left":{"join":0,"column":"user_id"},"right":"id"}]}]}`,
		`{"table":"orders","joins":[{"type":"left","table":"users","schema":["public"],"on":[{"left":{"join":0,"column":"user_id"},"right":"id"}]}]}`,
	} {
		if _, err := ParseJoin(bad); err == nil {
			t.Errorf("accepted %s", bad)
		}
	}
	if _, err := tableSchemas(refs, "public", []string{"public"}); err == nil {
		t.Error("an unlisted own schema must be a bad join")
	}
}

func TestATableInAnotherSchemaIsSplicedAndReportedUnderIt(t *testing.T) {
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
	sqlText, _ := buildJoinSelect(plan, pgJoinDialect)
	if want := ` from "public"."orders" t0 left join "warehouse"."users" t1 `; !strings.Contains(sqlText, want) {
		t.Errorf("sql missing %q:\n%s", want, sqlText)
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

func keyedTable(name string, cols []string, types []string, key ...int) tableMeta {
	t := tableMeta{name: name, orderKeys: key}
	for i, c := range cols {
		t.columns = append(t.columns, colMeta{name: c, typeName: types[i], class: classNumber})
	}
	return t
}

func TestJoinOrderKeysLeaveOutAKeyBoundToAFixedTable(t *testing.T) {
	ints := func(n int) []string { return slices.Repeat([]string{"int4"}, n) }
	collated := keyedTable("a", []string{"id", "b_code"}, []string{"int4", "text"}, 0)
	c := "C"
	collated.columns[1].collation = &c
	cases := []struct {
		name   string
		tables []tableMeta
		ons    [][]joinOn
		want   [][2]int
	}{
		{"fully bound", []tableMeta{keyedTable("a", []string{"id", "b_id"}, ints(2), 0), keyedTable("b", []string{"id"}, ints(1), 0)},
			[][]joinOn{{{0, 1, 0}}}, [][2]int{{0, 0}}},
		{"partly bound", []tableMeta{keyedTable("a", []string{"id", "x"}, ints(2), 0), keyedTable("b", []string{"x", "y"}, ints(2), 0, 1)},
			[][]joinOn{{{0, 1, 0}}}, [][2]int{{0, 0}, {1, 0}, {1, 1}}},
		{"composite, column by column", []tableMeta{keyedTable("a", []string{"id", "x", "y"}, ints(3), 0), keyedTable("b", []string{"x", "y"}, ints(2), 0, 1)},
			[][]joinOn{{{0, 2, 1}, {0, 1, 0}}}, [][2]int{{0, 0}}},
		{"type mismatch", []tableMeta{keyedTable("a", []string{"id", "b_id"}, []string{"int4", "int8"}, 0), keyedTable("b", []string{"id"}, ints(1), 0)},
			[][]joinOn{{{0, 1, 0}}}, [][2]int{{0, 0}, {1, 0}}},
		{"collation mismatch", []tableMeta{collated, keyedTable("b", []string{"code"}, []string{"text"}, 0)},
			[][]joinOn{{{0, 1, 0}}}, [][2]int{{0, 0}, {1, 0}}},
		{"bound to a keyless table", []tableMeta{keyedTable("v", []string{"b_id"}, ints(1)), keyedTable("b", []string{"id"}, ints(1), 0)},
			[][]joinOn{{{0, 0, 0}}}, [][2]int{{1, 0}}},
		{"a left-out key still fixes its table", []tableMeta{keyedTable("a", []string{"id", "b_id"}, ints(2), 0), keyedTable("b", []string{"id", "c_id"}, ints(2), 0), keyedTable("c", []string{"id"}, ints(1), 0)},
			[][]joinOn{{{0, 1, 0}}, {{1, 1, 0}}}, [][2]int{{0, 0}}},
		{"one binding from a fixed table is enough", []tableMeta{keyedTable("v", []string{"b_id"}, ints(1)), keyedTable("a", []string{"id", "b_id"}, ints(2), 0), keyedTable("b", []string{"id"}, ints(1), 0)},
			[][]joinOn{{{0, 0, 1}}, {{0, 0, 0}, {1, 1, 0}}}, [][2]int{{1, 0}}},
	}
	for _, tc := range cases {
		if got := joinOrderKeys(tc.tables, tc.ons); !slices.Equal(got, tc.want) {
			t.Errorf("%s: got %v, want %v", tc.name, got, tc.want)
		}
	}
}

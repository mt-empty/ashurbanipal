package ashurbanipal

import (
	"context"
	"database/sql"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func uuidCol(name string) joinColMeta {
	c := classUUID
	return joinColMeta{name: name, typeName: "uuid", class: &c}
}

func textCol(name string) joinColMeta {
	c := classText
	return joinColMeta{name: name, typeName: "text", class: &c}
}

func testOrdersUsers() []joinTableMeta {
	return []joinTableMeta{
		{name: "orders", columns: []joinColMeta{uuidCol("id"), uuidCol("user_id"), textCol("status"), {name: "tags", typeName: "ARRAY"}}},
		{name: "users", columns: []joinColMeta{uuidCol("id"), textCol("email")}},
	}
}

const testJoinJSON = `{"table":"orders","joins":[{"type":"left","table":"users",
	"on":[{"left":{"join":0,"column":"user_id"},"right":"id"}]}]}`

func TestParseJoinAcceptsAValidJoin(t *testing.T) {
	spec, err := ParseJoin(testJoinJSON)
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(spec.TableNames(), ","); got != "orders,users" {
		t.Errorf("table names = %s", got)
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
	metas[0].columns = append(metas[0].columns, joinColMeta{name: "score", typeName: "double precision"})
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
	tables := []joinTableMeta{
		{name: "x", columns: []joinColMeta{{name: "e", typeName: "USER-DEFINED", class: &enumA}}},
		{name: "y", columns: []joinColMeta{{name: "e", typeName: "USER-DEFINED", class: &enumA}, {name: "f", typeName: "USER-DEFINED", class: &enumB}}},
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
	tables := []joinTableMeta{{name: "ca", columns: []joinColMeta{a}}, {name: "cb", columns: []joinColMeta{b}}}
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
			{Column: "email", Op: "=", Value: &email, Join: &sortJoin},
			{Logic: &or, Not: true, Column: "status", Op: "IS NULL"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	schema := "public"
	sqlText, values := buildJoinSelect(plan, pgJoinDialect, &schema)
	for _, want := range []string{
		`t0."id"::text as c0, `,
		` from "public"."orders" t0 left join "public"."users" t1 on t1."id" = t0."user_id"`,
		` where (t1."email"::text = $3) OR (NOT (t0."status"::text IS NULL))`,
		` order by t1."email" asc limit $1 offset $2`,
	} {
		if !strings.Contains(sqlText, want) {
			t.Errorf("sql missing %q:\n%s", want, sqlText)
		}
	}
	if len(values) != 1 || values[0] != email {
		t.Errorf("values = %v", values)
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

func TestPgTypeClass(t *testing.T) {
	cases := []struct {
		dataType, schema, udt string
		enum                  bool
		want                  *typeClass
	}{
		{"integer", "", "", false, &classNumber},
		{"numeric", "", "", false, &classNumber},
		{"character varying", "", "", false, &classText},
		{"uuid", "", "", false, &classUUID},
		{"timestamp with time zone", "", "", false, &classTemporal},
		{"ARRAY", "", "", false, nil},
		{"jsonb", "", "", false, nil},
		{"double precision", "", "", false, nil},
	}
	for _, c := range cases {
		got := pgTypeClass(c.dataType, c.schema, c.udt, c.enum)
		if (got == nil) != (c.want == nil) || (got != nil && *got != *c.want) {
			t.Errorf("%s: got %v want %v", c.dataType, got, c.want)
		}
	}
	e := pgTypeClass("USER-DEFINED", "public", "mood", true)
	if e == nil || *e != classEnum("public.mood") {
		t.Errorf("enum class = %v", e)
	}
	if pgTypeClass("USER-DEFINED", "public", "geometry", false) != nil {
		t.Error("an unknown user-defined type is not joinable")
	}
}

package ashurbanipal

import (
	"encoding/json"
	"errors"
	"reflect"
	"testing"
)

// Consumes spec/fixtures/filter-builder-tests.json (schema: spec/fixtures/README.md).

type filterFixtureCase struct {
	Name        string                          `json:"name"`
	Table       string                          `json:"table"`
	Conditions  json.RawMessage                 `json:"conditions"`
	Raw         *string                         `json:"raw"`
	Expect      map[string]filterFixtureOutcome `json:"expect"`
	ExpectError *string                         `json:"expect_error"`
}

type filterFixtureOutcome struct {
	Where  string   `json:"where"`
	Values []string `json:"values"`
	Error  string   `json:"error"`
}

// Structural kinds all fail the parse before any schema access, so they compare as one.
const filterFixtureStructural = "structural"

func filterFixtureKind(kind string) string {
	if kind == "unknown_column" || kind == "invalid_value" {
		return kind
	}
	return filterFixtureStructural
}

func runFilterFixtureCase(t *testing.T, e fixtureEngine, table tableMeta, tc filterFixtureCase) filterFixtureOutcome {
	t.Helper()
	if (tc.Raw == nil) == (tc.Conditions == nil) {
		t.Fatalf("case %s: needs exactly one of raw and conditions", tc.Name)
	}
	raw := string(tc.Conditions)
	if tc.Raw != nil {
		raw = *tc.Raw
	}
	conditions, err := ParseFilter(raw)
	if err != nil {
		return filterFixtureOutcome{Error: filterFixtureStructural}
	}
	where, values, err := tableWhereClause(conditions, table, e.dialect)
	var notAllowed *NotAllowedError
	var filterError *FilterError
	switch {
	case err == nil:
		if values == nil {
			values = []string{}
		}
		return filterFixtureOutcome{Where: where, Values: values}
	case errors.As(err, &notAllowed):
		return filterFixtureOutcome{Error: notAllowed.Kind.Code()}
	case errors.As(err, &filterError):
		return filterFixtureOutcome{Error: "invalid_value"}
	default:
		t.Fatalf("unexpected error %T: %v", err, err)
		return filterFixtureOutcome{}
	}
}

// filterFixtureWant is the case's expectation on engine, or false when the case doesn't run there.
func filterFixtureWant(t *testing.T, tc filterFixtureCase, engine string) (filterFixtureOutcome, bool) {
	t.Helper()
	if (tc.ExpectError == nil) == (tc.Expect == nil) {
		t.Fatalf("case %s: needs exactly one of expect and expect_error", tc.Name)
	}
	if tc.ExpectError != nil {
		return filterFixtureOutcome{Error: filterFixtureKind(*tc.ExpectError)}, true
	}
	want, ok := tc.Expect[engine]
	switch {
	case want.Error != "":
		want.Error = filterFixtureKind(want.Error)
	case want.Where != "":
		want.Where = " where " + want.Where
	}
	return want, ok
}

func runFilterFixture(t *testing.T, e fixtureEngine) {
	var file struct {
		Cases []filterFixtureCase `json:"cases"`
	}
	readFixture(t, "filter-builder-tests.json", &file)
	cat, tables := loadCatalogFixture(t, e)
	ran := 0
	for _, tc := range file.Cases {
		want, ok := filterFixtureWant(t, tc, e.name)
		if !ok {
			continue
		}
		key := cat.DefaultSchema + "." + tc.Table
		table, ok := tables[key]
		if !ok {
			t.Fatalf("case %s: no %s in the %s catalog", tc.Name, key, e.name)
		}
		ran++
		t.Run(tc.Name, func(t *testing.T) {
			got := runFilterFixtureCase(t, e, table, tc)
			if !reflect.DeepEqual(got, want) {
				t.Errorf("\nwant %+v\ngot  %+v", want, got)
			}
		})
	}
	if ran == 0 {
		t.Fatalf("no filter fixture cases ran for %s", e.name)
	}
}

func TestFilterBuilderFixturesPostgres(t *testing.T) {
	runFilterFixture(t, pgFixtureEngine)
}

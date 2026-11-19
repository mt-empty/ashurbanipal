package ashurbanipal

import (
	"encoding/json"
	"errors"
	"reflect"
	"strings"
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
		return filterFixtureOutcome{Where: strings.TrimPrefix(where, " where "), Values: values}
	case errors.As(err, &notAllowed):
		return filterFixtureOutcome{Error: "unknown_column"}
	case errors.As(err, &filterError):
		return filterFixtureOutcome{Error: "invalid_value"}
	default:
		t.Fatalf("unexpected error %T: %v", err, err)
		return filterFixtureOutcome{}
	}
}

// filterFixtureWant is the case's expectation on engine, or false when the case doesn't run there.
func filterFixtureWant(tc filterFixtureCase, engine string) (filterFixtureOutcome, bool) {
	if tc.ExpectError != nil {
		return filterFixtureOutcome{Error: filterFixtureKind(*tc.ExpectError)}, true
	}
	want, ok := tc.Expect[engine]
	if ok && want.Error != "" {
		want.Error = filterFixtureKind(want.Error)
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
		want, ok := filterFixtureWant(tc, e.name)
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

package ashurbanipal

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"testing"
)

// Consumes the shared filter fixtures (spec/fixtures/README.md).

type fixtureFile struct {
	Tables map[string]map[string]fixtureColumn `json:"tables"`
	Cases  []fixtureCase                       `json:"cases"`
}

type fixtureColumn struct {
	Type string `json:"type"`
}

type fixtureCase struct {
	Name        string          `json:"name"`
	Table       string          `json:"table"`
	Conditions  json.RawMessage `json:"conditions"`
	Raw         *string         `json:"raw"`
	Expect      *fixtureExpect  `json:"expect"`
	ExpectError *string         `json:"expect_error"`
}

type fixtureExpect struct {
	Where  string   `json:"where"`
	Values []string `json:"values"`
}

// repoRoot resolves from this test file's own location (two directories
// up from implementations/go-nethttp) rather than the working directory
// `go test` happens to be invoked from.
func repoRoot(t *testing.T) string {
	t.Helper()
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed to resolve this test file's path")
	}
	return filepath.Join(filepath.Dir(thisFile), "..", "..")
}

// seedColumns substitutes the fixture's tables map for the live catalog
// (spec/fixtures/README.md).
func seedTable(t *testing.T, file fixtureFile, table string) tableMeta {
	t.Helper()
	columns, ok := file.Tables[table]
	if !ok {
		t.Fatalf("fixture references unmapped table %q", table)
	}
	out := make([]colMeta, 0, len(columns))
	for name, c := range columns {
		out = append(out, colMeta{
			name: name, typeName: c.Type, class: pgColumnClass(c.Type, "", "", false),
			compare: pgTypedCompare(c.Type),
		})
	}
	return tableMeta{name: table, columns: out}
}

var placeholderRe = regexp.MustCompile(`\$(\d+)`)

// shiftPlaceholders re-numbers the fixture's $1-based placeholders to
// match tableWhereClause's real numbering, which starts at $3 in
// production (QueryTable binds limit/offset as $1/$2 first) —
// spec/fixtures/README.md: "Runners with a different placeholder scheme
// ... normalize before comparing", mirroring db.rs's own
// shift_placeholders test helper exactly (shift by 2, not renumber to a
// scheme-agnostic token) since Go's driver also uses $N positional
// parameters.
func shiftPlaceholders(fragment string, by int) string {
	return placeholderRe.ReplaceAllStringFunc(fragment, func(m string) string {
		n, _ := strconv.Atoi(m[1:])
		return "$" + strconv.Itoa(n+by)
	})
}

func TestFilterBuilderFixtures(t *testing.T) {
	path := filepath.Join(repoRoot(t), "spec", "fixtures", "filter-builder-tests.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading fixture file %s: %v", path, err)
	}
	var file fixtureFile
	if err := json.Unmarshal(data, &file); err != nil {
		t.Fatalf("parsing fixture file: %v", err)
	}
	if len(file.Cases) == 0 {
		t.Fatal("fixture file has no cases")
	}

	for _, tc := range file.Cases {
		tc := tc
		t.Run(tc.Name, func(t *testing.T) {
			var raw string
			switch {
			case tc.Raw != nil:
				raw = *tc.Raw
			case tc.Conditions != nil:
				raw = string(tc.Conditions)
			default:
				t.Fatalf("case %s: neither raw nor conditions present", tc.Name)
			}

			switch {
			case tc.Expect != nil:
				conditions, err := ParseFilter(raw)
				if err != nil {
					t.Fatalf("case %s: parse failed: %v", tc.Name, err)
				}
				where, values, err := tableWhereClause(conditions, seedTable(t, file, tc.Table), pgJoinDialect)
				if err != nil {
					t.Fatalf("case %s: build failed: %v", tc.Name, err)
				}
				expectedWhere := ""
				if tc.Expect.Where != "" {
					expectedWhere = " where " + shiftPlaceholders(tc.Expect.Where, 2)
				}
				if where != expectedWhere {
					t.Errorf("case %s: WHERE mismatch:\n got: %q\nwant: %q", tc.Name, where, expectedWhere)
				}
				if !equalStrings(values, tc.Expect.Values) {
					t.Errorf("case %s: bind values mismatch: got %v want %v", tc.Name, values, tc.Expect.Values)
				}

			case tc.ExpectError != nil && (*tc.ExpectError == "unknown_column" || *tc.ExpectError == "invalid_value"):
				conditions, err := ParseFilter(raw)
				if err != nil {
					t.Fatalf("case %s: should parse (rejection is builder-stage): %v", tc.Name, err)
				}
				_, _, err = tableWhereClause(conditions, seedTable(t, file, tc.Table), pgJoinDialect)
				var notAllowed *NotAllowedError
				var filterError *FilterError
				switch {
				case *tc.ExpectError == "unknown_column" && !errors.As(err, &notAllowed):
					t.Fatalf("case %s: expected NotAllowedError, got %T: %v", tc.Name, err, err)
				case *tc.ExpectError == "invalid_value" && !errors.As(err, &filterError):
					t.Fatalf("case %s: expected FilterError, got %T: %v", tc.Name, err, err)
				}

			case tc.ExpectError != nil:
				_, err := ParseFilter(raw)
				if err == nil {
					t.Fatalf("case %s: expected structural rejection (%s), but it parsed", tc.Name, *tc.ExpectError)
				}

			default:
				t.Fatalf("case %s: neither expect nor expect_error present", tc.Name)
			}
		})
	}
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

package ashurbanipal

import (
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
)

// Consumes spec/fixtures/join-builder-tests.json (schema: spec/fixtures/README.md).

type joinFixtureFile struct {
	Catalogs map[string]joinFixtureCatalog `json:"catalogs"`
	Cases    []map[string]json.RawMessage  `json:"cases"`
}

type joinFixtureCatalog struct {
	Schemas       []string `json:"schemas"`
	DefaultSchema string   `json:"default_schema"`
	Tables        map[string]struct {
		Columns    []map[string]any `json:"columns"`
		UniqueKeys []struct {
			Name    string   `json:"name"`
			Primary bool     `json:"primary"`
			Columns []string `json:"columns"`
		} `json:"unique_keys"`
	} `json:"tables"`
}

type joinFixtureOutcome struct {
	SQL    string   `json:"sql"`
	Values []string `json:"values"`
	Labels []string `json:"labels"`
	Error  string   `json:"error"`
}

// joinFixtureEngine is one engine's half of the fixture: how a catalog column
// row becomes a colMeta, as that backend's tableMeta builds it.
type joinFixtureEngine struct {
	name          string
	dialect       joinDialect
	splicesSchema bool // SQLite has no schema above the database.
	column        func(map[string]any) colMeta
}

func fixtureString(c map[string]any, key string) string {
	s, _ := c[key].(string)
	return s
}

func fixtureCollation(c map[string]any) *string {
	if s, ok := c["collation"].(string); ok {
		return &s
	}
	return nil
}

// joinFixtureCode is the spec/protocol.md §2 code writeError gives err.
func joinFixtureCode(t *testing.T, err error) string {
	t.Helper()
	rec := httptest.NewRecorder()
	writeError(rec, err)
	var body struct {
		Code string `json:"code"`
	}
	if jerr := json.Unmarshal(rec.Body.Bytes(), &body); jerr != nil {
		t.Fatalf("decoding problem body %q: %v", rec.Body.String(), jerr)
	}
	return body.Code
}

func joinFixtureTables(e joinFixtureEngine, cat joinFixtureCatalog) map[string]tableMeta {
	out := map[string]tableMeta{}
	for key, tbl := range cat.Tables {
		schema, name, _ := strings.Cut(key, ".")
		meta := tableMeta{name: name}
		if e.splicesSchema {
			meta.schema = schema
		}
		for _, c := range tbl.Columns {
			meta.columns = append(meta.columns, e.column(c))
		}
		var keys []uniqueKey
		for _, k := range tbl.UniqueKeys {
			keys = append(keys, uniqueKey{name: k.Name, primary: k.Primary, columns: k.Columns})
		}
		meta.orderKeys = tieBreakKeys(meta.columns, keys)
		out[key] = meta
	}
	return out
}

func runJoinFixtureCase(t *testing.T, cat joinFixtureCatalog, tables map[string]tableMeta, e joinFixtureEngine,
	c map[string]json.RawMessage) joinFixtureOutcome {
	t.Helper()
	fail := func(err error) joinFixtureOutcome { return joinFixtureOutcome{Error: joinFixtureCode(t, err)} }
	raw := string(c["join"])
	if r, ok := c["join_raw"]; ok {
		if err := json.Unmarshal(r, &raw); err != nil {
			t.Fatal(err)
		}
	}
	spec, err := ParseJoin(raw)
	if err != nil {
		return fail(err)
	}
	var opts JoinOpts
	opts.Limit = 50
	if f, ok := c["filter"]; ok {
		if opts.Filter, err = ParseFilterForJoin(string(f)); err != nil {
			return fail(err)
		}
	}
	if s, ok := c["sort"]; ok {
		var sort string
		_ = json.Unmarshal(s, &sort)
		opts.Sort = &sort
	}
	if s, ok := c["sort_join"]; ok {
		var n int
		_ = json.Unmarshal(s, &n)
		opts.SortJoin = &n
	}
	if o, ok := c["order"]; ok {
		opts.Descending = string(o) == `"desc"`
	}
	request := cat.DefaultSchema
	if s, ok := c["schema"]; ok {
		_ = json.Unmarshal(s, &request)
	}
	if !slices.Contains(cat.Schemas, request) {
		t.Fatalf("request schema %q is not in the %s catalog", request, e.name)
	}
	refs := spec.TableRefs()
	schemas, err := tableSchemas(refs, request, cat.Schemas)
	if err != nil {
		return fail(err)
	}
	metas := make([]tableMeta, len(refs))
	for i, r := range refs {
		meta, ok := tables[schemas[i]+"."+r.Table]
		if !ok {
			return fail(badJoin("unknown table %q", r.Table))
		}
		metas[i] = meta
	}
	plan, err := planJoin(spec, metas, opts)
	if err != nil {
		return fail(err)
	}
	sql, values := buildJoinSelect(plan, e.dialect)
	if values == nil {
		values = []string{}
	}
	return joinFixtureOutcome{SQL: sql, Values: values, Labels: plan.labels}
}

func runJoinFixture(t *testing.T, e joinFixtureEngine) {
	path := filepath.Join(repoRoot(t), "spec", "fixtures", "join-builder-tests.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading fixture file %s: %v", path, err)
	}
	var file joinFixtureFile
	if err := json.Unmarshal(data, &file); err != nil {
		t.Fatalf("parsing fixture file: %v", err)
	}
	cat := file.Catalogs[e.name]
	tables := joinFixtureTables(e, cat)
	ran := 0
	for _, c := range file.Cases {
		var name string
		_ = json.Unmarshal(c["name"], &name)
		var want joinFixtureOutcome
		if code, ok := c["expect_error"]; ok {
			_ = json.Unmarshal(code, &want.Error)
		} else {
			var expect map[string]joinFixtureOutcome
			_ = json.Unmarshal(c["expect"], &expect)
			w, ok := expect[e.name]
			if !ok {
				continue
			}
			want = w
		}
		ran++
		t.Run(name, func(t *testing.T) {
			got := runJoinFixtureCase(t, cat, tables, e, c)
			if !reflect.DeepEqual(got, want) {
				t.Errorf("\nwant %s\ngot  %s", fmt.Sprintf("%+v", want), fmt.Sprintf("%+v", got))
			}
		})
	}
	if ran == 0 {
		t.Fatalf("no join fixture cases ran for %s", e.name)
	}
}

func TestJoinBuilderFixturesPostgres(t *testing.T) {
	runJoinFixture(t, joinFixtureEngine{
		name: "postgres", dialect: pgJoinDialect, splicesSchema: true,
		column: func(c map[string]any) colMeta {
			isEnum, _ := c["is_enum"].(bool)
			return colMeta{
				name: fixtureString(c, "name"), typeName: fixtureString(c, "type"),
				class:     pgColumnClass(fixtureString(c, "data_type"), fixtureString(c, "udt_schema"), fixtureString(c, "udt_name"), isEnum),
				compare:   pgTypedCompare(fixtureString(c, "data_type")),
				collation: fixtureCollation(c),
			}
		},
	})
}

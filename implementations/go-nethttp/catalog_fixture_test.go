package ashurbanipal

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// Engine-native catalogs from spec/fixtures/catalogs.json, shared by the join
// and filter fixture runners (schema: spec/fixtures/README.md).

// repoRoot resolves from this file's location, not the working directory.
func repoRoot(t *testing.T) string {
	t.Helper()
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed to resolve this test file's path")
	}
	return filepath.Join(filepath.Dir(thisFile), "..", "..")
}

// readFixture decodes spec/fixtures/<name> into v.
func readFixture(t *testing.T, name string, v any) {
	t.Helper()
	path := filepath.Join(repoRoot(t), "spec", "fixtures", name)
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading fixture file %s: %v", path, err)
	}
	if err := json.Unmarshal(data, v); err != nil {
		t.Fatalf("parsing fixture file %s: %v", path, err)
	}
}

type fixtureCatalog struct {
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

// loadCatalogFixture is the engine's catalog and its tables keyed schema.table.
func loadCatalogFixture(t *testing.T, e fixtureEngine) (fixtureCatalog, map[string]tableMeta) {
	t.Helper()
	var file struct {
		Catalogs map[string]fixtureCatalog `json:"catalogs"`
	}
	readFixture(t, "catalogs.json", &file)
	cat, ok := file.Catalogs[e.name]
	if !ok {
		t.Fatalf("catalogs.json has no %s catalog", e.name)
	}
	return cat, fixtureTables(e, cat)
}

// fixtureEngine is one engine's half of the fixtures: how a catalog column
// row becomes a colMeta, as that backend's tableMeta builds it.
type fixtureEngine struct {
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

func fixtureTables(e fixtureEngine, cat fixtureCatalog) map[string]tableMeta {
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

var pgFixtureEngine = fixtureEngine{
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
}

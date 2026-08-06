package ashurbanipal

import (
	"net/http"
	"net/url"
	"testing"
)

// DB-backed coverage of resolveSchema against the devcontainer's seeded
// Postgres (schemas: public, other_schema, warehouse — see
// .devcontainer/db/init/01-seed.sql). Reuses the shared server built once
// in TestMain (see integration_test.go) rather than booting its own.

func TestListSchemasExcludesSystemNamespaces(t *testing.T) {
	body := getJSON(t, testServer(t), "/api/schemas")
	schemas, _ := body["schemas"].([]interface{})
	want := map[string]bool{"public": true, "other_schema": true, "warehouse": true}
	seen := map[string]bool{}
	for _, s := range schemas {
		name := s.(string)
		seen[name] = true
		if name == "pg_catalog" || name == "information_schema" || len(name) >= 3 && name[:3] == "pg_" {
			t.Errorf("system namespace %q leaked into /api/schemas", name)
		}
	}
	for name := range want {
		if !seen[name] {
			t.Errorf("expected schema %q not found in %v", name, schemas)
		}
	}
}

func TestExplicitSchemaPublicMatchesImplicitDefault(t *testing.T) {
	base := testServer(t)
	implicit := getJSON(t, base, "/api/tables")
	explicit := getJSON(t, base, "/api/tables?schema=public")
	implicitTables, _ := implicit["tables"].([]interface{})
	explicitTables, _ := explicit["tables"].([]interface{})
	if len(implicitTables) != len(explicitTables) || len(implicitTables) == 0 {
		t.Fatalf("implicit %v tables, explicit %v tables", implicitTables, explicitTables)
	}
	for i := range implicitTables {
		if implicitTables[i].(map[string]interface{})["name"] != explicitTables[i].(map[string]interface{})["name"] {
			t.Errorf("table[%d]: implicit %v != explicit %v", i, implicitTables[i], explicitTables[i])
		}
	}
}

func TestExplicitOtherSchemaSelectsOnlyItsOwnTables(t *testing.T) {
	body := getJSON(t, testServer(t), "/api/tables?schema=other_schema")
	tables, _ := body["tables"].([]interface{})
	if len(tables) != 1 || tables[0].(map[string]interface{})["name"] != "decoy_items" {
		t.Errorf("got tables %v, want exactly [decoy_items]", tables)
	}
}

func TestUnrecognizedSchemaIsRejectedWith400OnEverySchemaAwareRoute(t *testing.T) {
	base := testServer(t)
	evilValues := []string{"", "nonexistent_schema", `public"; drop schema public cascade; --`, "public' OR '1'='1"}
	for _, evil := range evilValues {
		q := url.QueryEscape(evil)
		paths := []string{
			"/api/tables?schema=" + q,
			"/api/table-counts?schema=" + q,
			"/api/tables/data?schema=" + q + "&table=users",
			"/api/tables/common-values?schema=" + q + "&table=users&column=email",
		}
		for _, path := range paths {
			resp, err := http.Get(base + "/__ashurbanipal" + path)
			if err != nil {
				t.Fatalf("GET %s: %v", path, err)
			}
			resp.Body.Close()
			if resp.StatusCode != http.StatusBadRequest {
				t.Errorf("GET %s: status %d, want 400", path, resp.StatusCode)
			}
		}
	}
}

func TestCrossSchemaFKReferenceIncludesReferencedTablesSchema(t *testing.T) {
	body := getJSON(t, testServer(t), "/api/tables/data?schema=warehouse&table=shipments&limit=1")
	columns, _ := body["columns"].([]interface{})
	for _, c := range columns {
		col := c.(map[string]interface{})
		if col["name"] != "order_id" {
			continue
		}
		if col["key"] != "fk" {
			t.Fatalf("order_id key = %v, want fk", col["key"])
		}
		ref, _ := col["references"].(map[string]interface{})
		if ref["table"] != "orders" || ref["schema"] != "public" {
			t.Errorf("order_id references = %v, want {table: orders, schema: public}", ref)
		}
		return
	}
	t.Fatal("order_id column not found")
}

func TestSameSchemaFKReferenceOmitsSchemaField(t *testing.T) {
	body := getJSON(t, testServer(t), "/api/tables/data?table=orders&limit=1")
	columns, _ := body["columns"].([]interface{})
	for _, c := range columns {
		col := c.(map[string]interface{})
		if col["name"] != "user_id" {
			continue
		}
		ref, _ := col["references"].(map[string]interface{})
		if _, ok := ref["schema"]; ok {
			t.Errorf("user_id references.schema = %v, want absent", ref["schema"])
		}
		return
	}
	t.Fatal("user_id column not found")
}

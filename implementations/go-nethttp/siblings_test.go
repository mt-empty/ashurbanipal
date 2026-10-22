package ashurbanipal

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
)

// Port 9 refuses at once, so every check is a fast healthy=false. A nil
// Source is safe: /api/siblings never touches the database.
const unreachable = "http://127.0.0.1:9/__ashurbanipal"

func labelledConfig() Config {
	return Config{
		Enabled:  true,
		Instance: &Instance{Name: "orders", Label: "dev"},
		Siblings: []Sibling{
			{Name: "orders", Label: "dev", BaseURL: unreachable, HealthPath: "/health"},
			{Name: "orders", Label: "int", BaseURL: unreachable, HealthPath: "/health"},
			{Name: "billing", BaseURL: unreachable, HealthPath: "/health"},
		},
	}
}

func get(t *testing.T, handler http.Handler, path string) (int, map[string]any) {
	t.Helper()
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decoding %s: %v", path, err)
	}
	return rec.Code, body
}

func getSiblings(t *testing.T, cfg Config) map[string]any {
	t.Helper()
	_, body := get(t, Router(cfg, []NamedSource{{Name: "primary", Source: nil}}), "/__ashurbanipal/api/siblings")
	return body
}

func TestSiblingsReportThisInstanceInPlaceWithoutACheck(t *testing.T) {
	got := getSiblings(t, labelledConfig())
	want := map[string]any{
		"instance": map[string]any{"name": "orders", "label": "dev"},
		"siblings": []any{
			map[string]any{"name": "orders", "label": "dev", "base_url": unreachable, "healthy": true},
			map[string]any{"name": "orders", "label": "int", "base_url": unreachable, "healthy": false},
			map[string]any{"name": "billing", "base_url": unreachable, "healthy": false},
		},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("GET /api/siblings = %v, want %v", got, want)
	}
}

func TestSiblingsWithoutInstanceOmitInstanceAndLabel(t *testing.T) {
	cfg := Config{Enabled: true, Siblings: []Sibling{{Name: "billing", BaseURL: unreachable, HealthPath: "/health"}}}
	got := getSiblings(t, cfg)
	want := map[string]any{
		"siblings": []any{map[string]any{"name": "billing", "base_url": unreachable, "healthy": false}},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("GET /api/siblings = %v, want %v", got, want)
	}
}

func TestInvalidSiblingConfigIsReportedBySiblingsOnly(t *testing.T) {
	for name, tc := range map[string]struct {
		mutate func(*Config)
		title  string
	}{
		"instance without a label": {
			func(c *Config) { c.Instance.Label = "" },
			"invalid sibling configuration: Instance needs a non-empty Name and Label",
		},
		"duplicate name and label": {
			func(c *Config) { c.Siblings[1].Label = "dev" },
			`invalid sibling configuration: two siblings share the name "orders" and the same label`,
		},
	} {
		t.Run(name, func(t *testing.T) {
			cfg := labelledConfig()
			tc.mutate(&cfg)
			handler := Router(cfg, []NamedSource{{Name: "primary", Source: nil}})
			status, body := get(t, handler, "/__ashurbanipal/api/siblings")
			if status != http.StatusInternalServerError || body["code"] != "invalid_config" || body["title"] != tc.title {
				t.Errorf("GET /api/siblings = %d %v, want 500 invalid_config %q", status, body, tc.title)
			}
			if status, _ := get(t, handler, "/__ashurbanipal/api/sources"); status != http.StatusOK {
				t.Errorf("GET /api/sources = %d, want 200", status)
			}
		})
	}
}

func TestDisabledRouterNeverValidatesSiblings(t *testing.T) {
	cfg := labelledConfig()
	cfg.Enabled = false
	cfg.Instance.Label = ""
	assertDisabled(t, Router(cfg, nil))
}

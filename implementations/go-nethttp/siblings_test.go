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

func getSiblings(t *testing.T, cfg Config) map[string]any {
	t.Helper()
	handler := Router(cfg, []NamedSource{{Name: "primary", Source: nil}})
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/__ashurbanipal/api/siblings", nil))
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decoding /api/siblings: %v", err)
	}
	return body
}

func TestSiblingsEchoInstanceAndLabelsAndDropThisInstance(t *testing.T) {
	got := getSiblings(t, labelledConfig())
	want := map[string]any{
		"instance": map[string]any{"name": "orders", "label": "dev"},
		"siblings": []any{
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

func TestInvalidSiblingConfigPanicsWhenEnabled(t *testing.T) {
	for name, mutate := range map[string]func(*Config){
		"instance without a label": func(c *Config) { c.Instance.Label = "" },
		"duplicate name and label": func(c *Config) { c.Siblings[1].Label = "dev" },
	} {
		t.Run(name, func(t *testing.T) {
			cfg := labelledConfig()
			mutate(&cfg)
			defer func() {
				if recover() == nil {
					t.Error("Router did not panic")
				}
			}()
			Router(cfg, []NamedSource{{Name: "primary", Source: nil}})
		})
	}
}

func TestDisabledRouterNeverValidatesSiblings(t *testing.T) {
	cfg := labelledConfig()
	cfg.Enabled = false
	cfg.Instance.Label = ""
	assertDisabled(t, Router(cfg, nil))
}

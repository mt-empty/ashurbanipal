package ashurbanipal

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// Ports the Rust reference's fail-closed guarantees
// (implementations/rust/core/src/config.rs's tests) and the Spring Boot
// starter's AshurbanipalKillSwitchTest.kt at the level a plain library
// function can observe them directly. A nil *sql.DB is safe throughout:
// Router never touches the database at construction time, only
// per-request.

// PORTING.md hardening item 2: absent config MUST mean disabled, never
// "enabled with defaults".
func TestZeroValueConfigIsDisabled(t *testing.T) {
	assertDisabled(t, Router(Config{}, nil))
}

func TestEnabledFalseIsDisabled(t *testing.T) {
	assertDisabled(t, Router(Config{Enabled: false}, nil))
}

func TestEnabledTrueEnablesRoutes(t *testing.T) {
	assertEnabled(t, Router(Config{Enabled: true}, []NamedSource{{Name: "primary", Source: nil}}))
}

// A host passing zero sources while enabled is a startup-time
// misconfiguration, not a runtime condition — mirrors the Rust
// reference's assert!(!sources.is_empty()) in router().
func TestEnabledTrueWithNoSourcesPanics(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Error("Router(Config{Enabled: true}, nil) did not panic")
		}
	}()
	Router(Config{Enabled: true}, nil)
}

// assertDisabled checks that every one of the seven mount routes 404s —
// indistinguishable from the viewer never having been mounted at all
// (spec/protocol.md §4) — using the default base path, since a disabled
// Config{} carries no BasePath override of its own to probe instead.
func assertDisabled(t *testing.T, handler http.Handler) {
	t.Helper()
	for _, path := range []string{
		"/__ashurbanipal",
		"/__ashurbanipal/api/sources",
		"/__ashurbanipal/api/tables",
		"/__ashurbanipal/api/table-counts",
		"/__ashurbanipal/api/tables/data",
		"/__ashurbanipal/api/tables/common-values",
		"/__ashurbanipal/api/siblings",
	} {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if rec.Code != http.StatusNotFound {
			t.Errorf("GET %s: got status %d, want 404 (disabled)", path, rec.Code)
		}
	}
}

// assertEnabled checks the UI route serves the vendored frontend with no
// protocol header (spec/protocol.md §5.1/§7) — the one route that never
// touches the database, so it's safe to probe without a live *sql.DB.
func assertEnabled(t *testing.T, handler http.Handler) {
	t.Helper()
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/__ashurbanipal", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /__ashurbanipal: got status %d, want 200 (enabled)", rec.Code)
	}
	if rec.Header().Get(protocolHeader) != "" {
		t.Errorf("UI route carries a protocol header; spec/protocol.md §5.1/§7 reserve it for the API routes")
	}
	if len(rec.Body.Bytes()) == 0 {
		t.Errorf("UI route returned an empty body")
	}
}

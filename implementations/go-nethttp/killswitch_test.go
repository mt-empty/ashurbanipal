package ashurbanipal

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

// Ports the Rust reference's fail-closed guarantees
// (implementations/rust/core/src/config.rs's tests) and the Spring Boot
// starter's AshurbanipalKillSwitchTest.kt at the level a plain library
// function can observe them directly — Router's error return is itself
// the whole mechanism here (no DI container, no context-refresh failure
// to assert against), so these call Router(...) and inspect what comes
// back. A nil *sql.DB is safe throughout: Router never touches the
// database at construction time, only per-request.

// PORTING.md hardening item 2: absent config MUST mean disabled, never
// "enabled with defaults".
func TestZeroValueConfigIsDisabled(t *testing.T) {
	handler, err := Router(Config{}, nil)
	if err != nil {
		t.Fatalf("Router(Config{}, nil) returned an error: %v", err)
	}
	assertDisabled(t, handler)
}

func TestEnvironmentNotInEnabledForIsDisabled(t *testing.T) {
	cfg := Config{Environment: "staging", EnabledFor: []string{"dev"}}
	handler, err := Router(cfg, nil)
	if err != nil {
		t.Fatalf("Router returned an error: %v", err)
	}
	assertDisabled(t, handler)
}

func TestMatchingEnvironmentEnablesRoutes(t *testing.T) {
	cfg := Config{Environment: "dev", EnabledFor: []string{"dev", "integration"}}
	handler, err := Router(cfg, nil)
	if err != nil {
		t.Fatalf("Router returned an error: %v", err)
	}
	assertEnabled(t, handler)
}

// spec/protocol.md §4: the special token "any" matches every environment
// except production-like ones.
func TestAnyMatchesEveryNonProductionEnvironment(t *testing.T) {
	cfg := Config{Environment: "qa-eu-1", EnabledFor: []string{"any"}}
	handler, err := Router(cfg, nil)
	if err != nil {
		t.Fatalf("Router returned an error: %v", err)
	}
	assertEnabled(t, handler)
}

// spec/protocol.md §4: a production-like name in EnabledFor MUST be
// rejected at config load — Router(...) returning a non-nil error is
// this port's only observable form of "startup fails", since there's no
// separate config-load step to fail before it (PORTING.md hardening item
// 5's caveat: this is the property a conformance run over HTTP can never
// observe, so it has to be asserted here).
func TestProductionLikeEnabledForFailsToConstruct(t *testing.T) {
	for _, alias := range []string{"production", "prod", "PROD", "Production", "PRD", "live"} {
		t.Run(alias, func(t *testing.T) {
			cfg := Config{Environment: "dev", EnabledFor: []string{"dev", alias}}
			handler, err := Router(cfg, nil)
			if err == nil {
				t.Fatalf("Router did not return an error for EnabledFor containing %q", alias)
			}
			if handler != nil {
				t.Fatalf("Router returned a non-nil handler alongside an error")
			}
			var prodErr *ProductionEnabledError
			if !errors.As(err, &prodErr) {
				t.Fatalf("expected *ProductionEnabledError, got %T: %v", err, err)
			}
		})
	}
}

// Running *in* production disables regardless of EnabledFor (even "any")
// — but this is a plain disable, not a construction failure, since
// EnabledFor itself names no production-like value here.
func TestRunningEnvironmentItselfProductionLikeDisablesWithoutFailing(t *testing.T) {
	for _, env := range []string{"production", "PROD", "live"} {
		t.Run(env, func(t *testing.T) {
			cfg := Config{Environment: env, EnabledFor: []string{"any"}}
			handler, err := Router(cfg, nil)
			if err != nil {
				t.Fatalf("Router returned an error for a production-like running environment (should silently disable, not fail): %v", err)
			}
			assertDisabled(t, handler)
		})
	}
}

// assertDisabled checks that every one of the six mount routes 404s —
// indistinguishable from the viewer never having been mounted at all
// (spec/protocol.md §4) — using the default base path, since a disabled
// Config{} carries no BasePath override of its own to probe instead.
func assertDisabled(t *testing.T, handler http.Handler) {
	t.Helper()
	for _, path := range []string{
		"/__ashurbanipal",
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

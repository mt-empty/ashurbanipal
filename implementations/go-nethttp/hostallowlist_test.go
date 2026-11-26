package ashurbanipal

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHostAllowListFixtureCases(t *testing.T) {
	var fixtures struct {
		Cases []struct {
			Name         string   `json:"name"`
			AllowedHosts []string `json:"allowed_hosts"`
			Host         string   `json:"host"` // null decodes to "", a missing header
			Allowed      bool     `json:"allowed"`
		} `json:"cases"`
	}
	readFixture(t, "host-allow-list-tests.json", &fixtures)
	for _, c := range fixtures.Cases {
		if got := newHostAllowList(c.AllowedHosts).allows(c.Host); got != c.Allowed {
			t.Errorf("%s: allows = %v, want %v", c.Name, got, c.Allowed)
		}
	}
}

func TestHostAllowListWarnings(t *testing.T) {
	if w := newHostAllowList(nil).warnings; len(w) != 1 || !strings.Contains(w[0], "allowed_hosts is not set") {
		t.Errorf("no entries: warnings = %q, want one about the missing list", w)
	}
	w := newHostAllowList([]string{"http://localhost", "localhost/x", "*.example", "localhost:abc", "ok.example"}).warnings
	if len(w) != 4 || !strings.Contains(w[0], `"http://localhost"`) {
		t.Errorf("bad entries: warnings = %q, want four naming each entry", w)
	}
}

// statusFor sends one request with the given Host ("" sends none).
func statusFor(handler http.Handler, method, path, host string, headers map[string]string) int {
	req := httptest.NewRequest(method, path, nil)
	req.Host = host
	for name, value := range headers {
		req.Header.Set(name, value)
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec.Code
}

func TestRouterRejectsAnUnlistedHost(t *testing.T) {
	handler := Router(
		Config{Enabled: true, AllowedHosts: []string{"localhost"}},
		[]NamedSource{{Name: "primary", Source: nil}},
	)
	for _, path := range []string{"/__ashurbanipal", "/__ashurbanipal/api/tables"} {
		if code := statusFor(handler, http.MethodGet, path, "rebind.invalid", nil); code != http.StatusNotFound {
			t.Errorf("GET %s, Host rebind.invalid: got %d, want 404", path, code)
		}
		if code := statusFor(handler, http.MethodGet, path, "rebind.invalid", map[string]string{"X-Forwarded-Host": "localhost"}); code != http.StatusNotFound {
			t.Errorf("GET %s with X-Forwarded-Host: got %d, want 404", path, code)
		}
		if code := statusFor(handler, http.MethodGet, path, "", nil); code != http.StatusNotFound {
			t.Errorf("GET %s with no Host: got %d, want 404", path, code)
		}
	}
	if code := statusFor(handler, http.MethodGet, "/__ashurbanipal", "LOCALHOST:4000", nil); code != http.StatusOK {
		t.Errorf("GET /__ashurbanipal, Host LOCALHOST:4000: got %d, want 200", code)
	}
}

func TestHostCheckFollowsACustomMount(t *testing.T) {
	viewer := Router(
		Config{Enabled: true, BasePath: "/viewer", AllowedHosts: []string{"localhost"}},
		[]NamedSource{{Name: "primary", Source: nil}},
	)
	mux := http.NewServeMux()
	mux.Handle("/svc/", http.StripPrefix("/svc", viewer))
	mux.HandleFunc("/other", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	cases := []struct {
		method, path, host string
		want               int
	}{
		{http.MethodGet, "/svc/viewer", "rebind.invalid", http.StatusNotFound},
		{http.MethodPost, "/svc/viewer/api/tables", "rebind.invalid", http.StatusNotFound},
		{http.MethodGet, "/svc/viewer", "localhost", http.StatusOK},
		{http.MethodGet, "/other", "rebind.invalid", http.StatusOK},
	}
	for _, c := range cases {
		if got := statusFor(mux, c.method, c.path, c.host, nil); got != c.want {
			t.Errorf("%s %s, Host %s: got %d, want %d", c.method, c.path, c.host, got, c.want)
		}
	}
}

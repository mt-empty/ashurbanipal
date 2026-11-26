package ashurbanipal

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHostAllowListMatching(t *testing.T) {
	cases := []struct {
		entries []string
		host    string
		want    bool
	}{
		{nil, "anything.example", true},
		{nil, "", true},
		{[]string{"billing.internal"}, "billing.internal", true},
		{[]string{"billing.internal"}, "billing.internal:4000", true},
		{[]string{"billing.internal"}, "evil.example", false},
		{[]string{"billing.internal"}, "billing.internal.evil.example", false},
		{[]string{"billing.internal:4000"}, "billing.internal:4000", true},
		{[]string{"billing.internal:4000"}, "billing.internal", false},
		{[]string{"billing.internal:4000"}, "billing.internal:4001", false},
		{[]string{"Billing.Internal"}, "BILLING.internal:4000", true},
		{[]string{"billing.internal"}, "billing.internal.", true},
		{[]string{"billing.internal"}, "billing.internal.:4000", true},
		{[]string{"other.internal."}, "other.internal", true},
		{[]string{"localhost"}, ".", false},
		{[]string{"billing.internal"}, "billing.internal..", false},
		{[]string{"[::1]:4000"}, "[::1]:4000", true},
		{[]string{"[::1]:4000"}, "[::1]:4001", false},
		{[]string{"[fe80::1]"}, "[FE80::1]:80", true},
		{[]string{"[::1]"}, "::1", false},
		{[]string{"localhost"}, "", false},
		{[]string{"localhost"}, "localhost:", false},
		{[]string{"localhost"}, "localhost:99999", false},
		{[]string{"localhost"}, "localhost:80x", false},
		{[]string{"localhost"}, "user@localhost", false},
		{[]string{"localhost"}, "localhost/path", false},
		{[]string{"localhost"}, "local host", false},
		{[]string{"http://localhost"}, "localhost", false},
		{[]string{"http://localhost", "ok.example"}, "ok.example", true},
	}
	for _, c := range cases {
		if got := newHostAllowList(c.entries).allows(c.host); got != c.want {
			t.Errorf("entries %q, Host %q: allows = %v, want %v", c.entries, c.host, got, c.want)
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

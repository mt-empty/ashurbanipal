package ashurbanipal

import (
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
)

type fixtureRequest struct {
	Method string `json:"method"`
	Path   string `json:"path"`
}

type hostRoutesFixture struct {
	ViewerPaths []string         `json:"viewer_paths"`
	HostRoutes  []fixtureRequest `json:"host_routes"`
	Unrouted    []fixtureRequest `json:"unrouted"`
}

// hostMux registers the viewer on Paths, under prefix through StripPrefix,
// beside every fixture host route and a catch-all host 404.
func hostMux(fixture hostRoutesFixture, prefix string, allowedHosts []string) *http.ServeMux {
	cfg := Config{Enabled: true, AllowedHosts: allowedHosts}
	viewer := http.StripPrefix(prefix, Router(cfg, []NamedSource{{Name: "primary", Source: nil}}))
	mux := http.NewServeMux()
	for _, path := range Paths(cfg) {
		mux.Handle(prefix+path, viewer)
	}
	for _, route := range fixture.HostRoutes {
		path := prefix + strings.ReplaceAll(route.Path, "{mount}", "/__ashurbanipal")
		mux.HandleFunc(route.Method+" "+path, func(w http.ResponseWriter, _ *http.Request) {
			_, _ = io.WriteString(w, "host-route")
		})
	}
	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = io.WriteString(w, "host-404")
	})
	return mux
}

// spec/protocol.md §3: the viewer never changes a host route, with the Host
// check on or off.
func TestHostRoutesAreUntouched(t *testing.T) {
	var fixture hostRoutesFixture
	readFixture(t, "host-routes-untouched.json", &fixture)
	for _, prefix := range []string{"", "/svc"} {
		for _, group := range []struct {
			requests []fixtureRequest
			status   int
			body     string
		}{
			{fixture.HostRoutes, http.StatusOK, "host-route"},
			{fixture.Unrouted, http.StatusNotFound, "host-404"},
		} {
			for _, setup := range []struct {
				allowed []string
				host    string
			}{
				{[]string{"localhost"}, "localhost"},
				{[]string{"localhost"}, "rebind.invalid"},
				{nil, "rebind.invalid"},
			} {
				mux := hostMux(fixture, prefix, setup.allowed)
				for _, req := range group.requests {
					path := prefix + strings.ReplaceAll(req.Path, "{mount}", "/__ashurbanipal")
					r := httptest.NewRequest(req.Method, path, nil)
					r.Host = setup.host
					w := httptest.NewRecorder()
					mux.ServeHTTP(w, r)
					if w.Code != group.status || w.Body.String() != group.body {
						t.Errorf("%s %s, list %v, Host %s: got %d %q, want %d %q",
							req.Method, path, setup.allowed, setup.host, w.Code, w.Body.String(), group.status, group.body)
					}
				}
			}
		}
	}
}

func TestPathsMatchTheFixture(t *testing.T) {
	var fixture hostRoutesFixture
	readFixture(t, "host-routes-untouched.json", &fixture)
	want := make([]string, 0, len(fixture.ViewerPaths))
	for _, p := range fixture.ViewerPaths {
		want = append(want, "/__ashurbanipal"+p)
	}
	if got := Paths(Config{Enabled: true}); !slices.Equal(got, want) {
		t.Errorf("Paths = %v, want %v", got, want)
	}
	if got := Paths(Config{}); got != nil {
		t.Errorf("Paths when disabled = %v, want nil", got)
	}
}

func TestARootBasePathPanics(t *testing.T) {
	for _, base := range []string{"/", "//"} {
		func() {
			defer func() {
				if r := recover(); r == nil || !strings.Contains(r.(string), "must not be the root") {
					t.Errorf("BasePath %q: recovered %v, want a root-mount panic", base, r)
				}
			}()
			Router(Config{Enabled: true, BasePath: base}, []NamedSource{{Name: "primary", Source: nil}})
		}()
	}
}

package ashurbanipal

import (
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
)

// hostAllowList is the optional Host allow-list against DNS rebinding
// (spec/protocol.md §3.1). With no entries configured the check is off.
type hostAllowList struct {
	// active is false when Config.AllowedHosts is empty. Entries that fail
	// to parse are dropped, so a list of only bad entries is active and
	// rejects every request.
	active   bool
	entries  []hostPort
	warnings []string
}

type hostPort struct {
	// name is lowercased; an IPv6 literal keeps its brackets.
	name    string
	port    int
	hasPort bool
}

func newHostAllowList(hosts []string) hostAllowList {
	if len(hosts) == 0 {
		return hostAllowList{warnings: []string{
			"allowed_hosts is not set, so any Host header is accepted and a DNS-rebinding page can read the viewer (spec/protocol.md §3.1)",
		}}
	}
	l := hostAllowList{active: true}
	for _, entry := range hosts {
		hp, ok := parseHostPort(entry)
		if !ok {
			l.warnings = append(l.warnings, fmt.Sprintf("allowed_hosts entry %q is not a host name with an optional port, so it matches nothing", entry))
			continue
		}
		l.entries = append(l.entries, hp)
	}
	return l
}

// allows takes the request's raw Host header or HTTP/2 :authority (Go's
// r.Host), never a forwarded header. With the check on, a missing or
// malformed host is rejected.
func (l hostAllowList) allows(host string) bool {
	if !l.active {
		return true
	}
	req, ok := parseHostPort(host)
	if !ok {
		return false
	}
	for _, e := range l.entries {
		if e.name == req.name && (!e.hasPort || (req.hasPort && req.port == e.port)) {
			return true
		}
	}
	return false
}

// parseHostPort accepts name or name:port, with an IPv6 literal in
// brackets; one trailing dot on the name is dropped. No scheme, path,
// userinfo or wildcard.
func parseHostPort(text string) (hostPort, bool) {
	var name, port string
	hasPort := false
	if strings.HasPrefix(text, "[") {
		end := strings.IndexByte(text, ']')
		if end < 0 {
			return hostPort{}, false
		}
		name = text[:end+1]
		rest := text[end+1:]
		inner := name[1 : len(name)-1]
		if inner == "" || strings.Trim(inner, "0123456789abcdefABCDEF:.") != "" {
			return hostPort{}, false
		}
		if rest != "" {
			if !strings.HasPrefix(rest, ":") {
				return hostPort{}, false
			}
			port, hasPort = rest[1:], true
		}
		return finishHostPort(name, port, hasPort)
	}
	name = text
	if i := strings.IndexByte(text, ':'); i >= 0 {
		name, port, hasPort = text[:i], text[i+1:], true
	}
	// billing.internal. is the same DNS name as billing.internal.
	name = strings.TrimSuffix(name, ".")
	if name == "" {
		return hostPort{}, false
	}
	for _, c := range []byte(name) {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '.' || c == '-' || c == '_') {
			return hostPort{}, false
		}
	}
	return finishHostPort(name, port, hasPort)
}

func finishHostPort(name, port string, hasPort bool) (hostPort, bool) {
	hp := hostPort{name: strings.ToLower(name), hasPort: hasPort}
	if hasPort {
		if port == "" || len(port) > 5 || strings.Trim(port, "0123456789") != "" {
			return hostPort{}, false
		}
		// Digits only and at most five of them, so Atoi cannot fail.
		n, _ := strconv.Atoi(port)
		if n > 65535 {
			return hostPort{}, false
		}
		hp.port = n
	}
	return hp, true
}

// withHostCheck answers a request whose Host is not listed with the same
// 404 as an unmounted path.
func withHostCheck(l hostAllowList, next http.Handler) http.Handler {
	for _, w := range l.warnings {
		slog.Warn("ashurbanipal: " + w)
	}
	if !l.active {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !l.allows(r.Host) {
			http.NotFound(w, r)
			return
		}
		next.ServeHTTP(w, r)
	})
}

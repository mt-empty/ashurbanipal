package ashurbanipal

import (
	"context"
	"net/http"
	"net/url"
	"time"

	"golang.org/x/sync/errgroup"
)

// siblingTimeout bounds each individual health check so one dead sibling
// can't stall the /api/siblings response (spec/protocol.md §5.6).
const siblingTimeout = 3 * time.Second

// SiblingStatus is one entry of GET {mount}/api/siblings.
type SiblingStatus struct {
	Name    string `json:"name"`
	BaseURL string `json:"base_url"`
	Healthy bool   `json:"healthy"`
}

// checkSiblings fans health checks out in parallel via errgroup, one GET
// per sibling against its resolved health URL. A check failure (network
// error, non-2xx, timeout, unresolvable URL) yields healthy=false, never
// an error response — errgroup's error return is unused for exactly that
// reason (spec/protocol.md §5.6: "never an error response").
func checkSiblings(ctx context.Context, client *http.Client, siblings []Sibling) []SiblingStatus {
	statuses := make([]SiblingStatus, len(siblings))
	g, ctx := errgroup.WithContext(ctx)
	for i, sibling := range siblings {
		i, sibling := i, sibling
		g.Go(func() error {
			statuses[i] = SiblingStatus{Name: sibling.Name, BaseURL: sibling.BaseURL}
			healthURL, ok := siblingHealthURL(sibling.BaseURL, sibling.HealthPath)
			if !ok {
				return nil
			}
			checkCtx, cancel := context.WithTimeout(ctx, siblingTimeout)
			defer cancel()
			req, err := http.NewRequestWithContext(checkCtx, http.MethodGet, healthURL, nil)
			if err != nil {
				return nil
			}
			resp, err := client.Do(req)
			if err != nil {
				return nil
			}
			defer resp.Body.Close()
			statuses[i].Healthy = resp.StatusCode >= 200 && resp.StatusCode < 300
			return nil
		})
	}
	_ = g.Wait() // no goroutine above ever returns a non-nil error
	return statuses
}

// siblingHealthURL resolves healthPath against baseURL's origin
// (scheme + host + port), not its path — spec/protocol.md §5.6.
func siblingHealthURL(baseURL, healthPath string) (string, bool) {
	u, err := url.Parse(baseURL)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return "", false
	}
	origin := url.URL{Scheme: u.Scheme, Host: u.Host}
	resolved, err := origin.Parse(healthPath)
	if err != nil {
		return "", false
	}
	return resolved.String(), true
}

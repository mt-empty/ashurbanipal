package ashurbanipal

import (
	"fmt"
	"strings"
)

// productionAliases are compared case-insensitively; "production" itself is
// deliberately not representable in EnabledFor — Validate rejects it at
// config-construction time rather than letting it reach a running server
// (spec/protocol.md §4).
var productionAliases = []string{"production", "prod", "prd", "live"}

func isProductionLike(value string) bool {
	for _, alias := range productionAliases {
		if strings.EqualFold(value, alias) {
			return true
		}
	}
	return false
}

// Limits bounds pagination and query duration. The zero value is not
// usable directly — Router applies defaultLimits() when a field is zero, so
// a caller can set only the fields they care about.
type Limits struct {
	DefaultPageSize  int
	MaxPageSize      int
	QueryTimeoutSecs int
}

func defaultLimits() Limits {
	return Limits{DefaultPageSize: 50, MaxPageSize: 100, QueryTimeoutSecs: 5}
}

// WithDefaults fills any zero field from defaultLimits(), mirroring the
// Rust reference's #[serde(default)] struct-level Limits::default(). A
// caller constructing a DbSource directly (NewPostgresSource et al., which
// take an already-resolved timeout rather than a Config) calls this
// itself before reading QueryTimeoutSecs — Router no longer does it on
// their behalf.
func (l Limits) WithDefaults() Limits {
	d := defaultLimits()
	if l.DefaultPageSize == 0 {
		l.DefaultPageSize = d.DefaultPageSize
	}
	if l.MaxPageSize == 0 {
		l.MaxPageSize = d.MaxPageSize
	}
	if l.QueryTimeoutSecs == 0 {
		l.QueryTimeoutSecs = d.QueryTimeoutSecs
	}
	return l
}

// Sibling is one entry in Config.Siblings — another Ashurbanipal instance
// whose health is polled live by GET {mount}/api/siblings.
type Sibling struct {
	Name        string
	DBViewerURL string
	HealthPath  string
}

// Config mirrors the Rust reference's TOML config 1:1 (implementation.md
// §5.2's mapping table), expressed as a plain Go struct rather than tied to
// any particular config-file format — the host populates it however it
// likes (env vars, flags, its own config library).
//
// The zero value, Config{}, MUST mean disabled: EnabledFor is nil, so
// IsEnabled reports false regardless of Environment. This is load-bearing
// (implementation.md §5.5 item 2) — a host that forgets to configure
// anything gets a 404'd viewer, never one silently enabled with defaults.
type Config struct {
	Environment string
	// EnabledFor is the allow-list of environments the viewer is enabled
	// for. Empty means disabled everywhere. The special token "any"
	// matches every environment except production-like ones.
	EnabledFor []string
	// BasePath is the mount point; empty means "/__ashurbanipal" (the
	// reference default, not a requirement — spec/protocol.md §3).
	BasePath string
	Limits   Limits
	Siblings []Sibling
}

// ProductionEnabledError is returned by Validate/Router when EnabledFor
// names a production-like value — config load fails outright rather than
// silently disabling at request time (spec/protocol.md §4).
type ProductionEnabledError struct {
	Value string
}

func (e *ProductionEnabledError) Error() string {
	return fmt.Sprintf("ashurbanipal must never be enabled in production: EnabledFor contains %q", e.Value)
}

// Validate rejects a production-like value in EnabledFor. Router calls this
// itself; a host constructing Config outside Router (e.g. to inspect
// IsEnabled before merging routes) should call it too.
func (c Config) Validate() error {
	for _, value := range c.EnabledFor {
		if isProductionLike(value) {
			return &ProductionEnabledError{Value: value}
		}
	}
	return nil
}

// IsEnabled reports whether the viewer is enabled for the configured
// Environment. A production-like Environment is always disabled,
// regardless of EnabledFor (including "any") — spec/protocol.md §4.
func (c Config) IsEnabled() bool {
	if isProductionLike(c.Environment) {
		return false
	}
	for _, enabled := range c.EnabledFor {
		if strings.EqualFold(enabled, "any") || strings.EqualFold(enabled, c.Environment) {
			return true
		}
	}
	return false
}

func (c Config) basePath() string {
	if c.BasePath == "" {
		return "/__ashurbanipal"
	}
	return c.BasePath
}

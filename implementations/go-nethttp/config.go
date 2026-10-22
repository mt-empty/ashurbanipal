package ashurbanipal

import (
	"fmt"
)

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

// WithDefaults fills zero fields from the protocol defaults.
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

// Instance names this instance. Labels are opaque host strings: echoed,
// never parsed or acted on (`spec/protocol.md` §4).
type Instance struct {
	Name  string `json:"name"`
	Label string `json:"label"`
}

// Sibling's Label is optional; empty means unset.
type Sibling struct {
	Name       string
	Label      string
	BaseURL    string
	HealthPath string
}

// Config is host-provided and fail-closed by default (`spec/protocol.md` §4).
type Config struct {
	Enabled  bool
	BasePath string
	Limits   Limits
	Instance *Instance
	Siblings []Sibling
}

func (c Config) IsEnabled() bool {
	return c.Enabled
}

// siblingsView is the sibling config after spec/protocol.md §5.6's
// corrections, which never reject it: each one is reported in Warnings.
type siblingsView struct {
	Instance *Instance
	Siblings []Sibling
	Warnings []string
}

func (c Config) siblingsView() siblingsView {
	v := siblingsView{Instance: c.Instance, Siblings: c.Siblings}
	if v.Instance != nil && (v.Instance.Name == "" || v.Instance.Label == "") {
		v.Warnings = append(v.Warnings, "instance needs a non-empty name and label; ignored")
		v.Instance = nil
	}
	copies := map[[2]string]int{}
	for _, s := range c.Siblings {
		key := [2]string{s.Name, s.Label}
		copies[key]++
		if copies[key] != 2 {
			continue
		}
		if s.Label == "" {
			v.Warnings = append(v.Warnings, fmt.Sprintf("two siblings share the name %q and no label", s.Name))
		} else {
			v.Warnings = append(v.Warnings, fmt.Sprintf("two siblings share the name %q and the label %q", s.Name, s.Label))
		}
	}
	return v
}

// isInstance reports whether s is this instance's own entry, which is
// reported healthy without a health check: it is serving the response.
func (i *Instance) isInstance(s Sibling) bool {
	return i != nil && s.Name == i.Name && s.Label == i.Label
}

func (c Config) basePath() string {
	if c.BasePath == "" {
		return "/__ashurbanipal"
	}
	return c.BasePath
}

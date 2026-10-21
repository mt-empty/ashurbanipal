package ashurbanipal

import (
	"errors"
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

// validateSiblings applies the instance/label rules of spec/protocol.md §5.6.
func (c Config) validateSiblings() error {
	if c.Instance != nil && (c.Instance.Name == "" || c.Instance.Label == "") {
		return errors.New("Instance needs a non-empty Name and Label")
	}
	seen := map[[2]string]bool{}
	for _, s := range c.Siblings {
		key := [2]string{s.Name, s.Label}
		if seen[key] {
			return fmt.Errorf("two siblings share the name %q and the same label", s.Name)
		}
		seen[key] = true
	}
	return nil
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

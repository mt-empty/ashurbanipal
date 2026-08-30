package ashurbanipal

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
	Name       string
	BaseURL    string
	HealthPath string
}

// Config mirrors the Rust reference's TOML config 1:1 (docs/design.md §7),
// expressed as a plain Go struct rather than tied to any particular
// config-file format — the host populates it however it likes (env vars,
// flags, its own config library).
//
// The zero value, Config{}, MUST mean disabled: Enabled is false, so
// IsEnabled reports false. This is load-bearing (spec/protocol.md §4) — a
// host that forgets to configure anything gets a 404'd viewer, never one
// silently enabled with defaults.
type Config struct {
	// Enabled is off unless the host sets it explicitly. Ashurbanipal
	// doesn't know or police which environment it's running in — that's
	// the host's call entirely (spec/protocol.md §4).
	Enabled bool
	// BasePath is the mount point; empty means "/__ashurbanipal" (the
	// reference default, not a requirement — spec/protocol.md §3).
	BasePath string
	Limits   Limits
	Siblings []Sibling
}

// IsEnabled reports whether the viewer is enabled.
func (c Config) IsEnabled() bool {
	return c.Enabled
}

func (c Config) basePath() string {
	if c.BasePath == "" {
		return "/__ashurbanipal"
	}
	return c.BasePath
}

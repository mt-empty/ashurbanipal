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

type Sibling struct {
	Name       string
	BaseURL    string
	HealthPath string
}

// Config is host-provided and fail-closed by default (`spec/protocol.md` §4).
type Config struct {
	Enabled  bool
	BasePath string
	Limits   Limits
	Siblings []Sibling
}

func (c Config) IsEnabled() bool {
	return c.Enabled
}

func (c Config) basePath() string {
	if c.BasePath == "" {
		return "/__ashurbanipal"
	}
	return c.BasePath
}

package ashurbanipal

import (
	"context"
	"database/sql"
)

// KeyKind is "pk" or "fk" — spec/protocol.md §5.4.1.
type KeyKind string

const (
	KeyPK KeyKind = "pk"
	KeyFK KeyKind = "fk"
)

// ColumnRef is the {table, column} a foreign-key column references.
type ColumnRef struct {
	Table  string `json:"table"`
	Column string `json:"column"`
	// Schema is only set when the referenced table lives in a schema other
	// than the referencing column's own — same-schema FKs (the common
	// case) omit it, so the wire payload is unchanged from before this
	// field existed (additive, spec/protocol.md §7 versioning policy).
	Schema string `json:"schema,omitempty"`
}

// ColumnInfo is one column's metadata, sourced entirely from schema
// catalogs (spec/protocol.md §5.4.1) — never used to build SQL itself.
type ColumnInfo struct {
	Name       string     `json:"name"`
	Type       string     `json:"type"`
	Key        KeyKind    `json:"key,omitempty"`
	References *ColumnRef `json:"references,omitempty"`
	Comment    string     `json:"comment,omitempty"`
}

// TableInfo is one entry of GET /api/tables.
type TableInfo struct {
	Name    string  `json:"name"`
	Comment *string `json:"comment,omitempty"`
}

// TableData is the full response body of GET /api/tables/data.
type TableData struct {
	Columns     []ColumnInfo         `json:"columns"`
	Rows        []map[string]*string `json:"rows"`
	TotalApprox int64                `json:"total_approx"`
}

// CountEntry is one entry of GET /api/table-counts.
type CountEntry struct {
	Table      string `json:"table"`
	ApproxRows int64  `json:"approx_rows"`
}

// CommonValueEntry is one entry of GET /api/tables/common-values.
type CommonValueEntry struct {
	Value string  `json:"value"`
	Freq  float32 `json:"freq"`
}

// QueryOpts parameterizes GET /api/tables/data.
type QueryOpts struct {
	Limit      int64
	Offset     int64
	Sort       *string
	Descending bool
	Filter     []Condition
}

// DbSource is the one seam to the database — route handlers (routes.go)
// never touch *sql.DB/*sql.Tx directly. One implementation per backend:
// PostgresSource (postgres.go, the default), SQLiteSource (sqlite.go,
// gated behind the `sqlite` build tag), MySQLSource (mysql.go, gated
// behind the `mysql` build tag) — mirrors the Rust reference's DbSource
// trait in implementations/rust/core/src/db/mod.rs. Every query a method issues
// (catalog/metadata included, not just row fetches) must be bounded by the
// same configured timeout; each implementation owns how it enforces that,
// since the mechanism differs per engine (see docs/adapter-decisions.md
// §6).
type DbSource interface {
	ListSchemas(ctx context.Context) ([]string, error)
	ListTables(ctx context.Context, schema *string) ([]TableInfo, error)
	TableCounts(ctx context.Context, schema *string) ([]CountEntry, error)
	QueryTable(ctx context.Context, schema *string, table string, opts QueryOpts) (TableData, error)
	CommonValues(ctx context.Context, schema *string, table, column string) ([]CommonValueEntry, error)
}

// queryer is satisfied by both *sql.DB and *sql.Tx — every backend's
// catalog helpers accept this so the same code runs whether it's querying
// outside a transaction or pinned to one (spec/design.md §5's "resolve
// once per operation" requirement).
type queryer interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func findExact(haystack []string, needle string) (string, bool) {
	for _, s := range haystack {
		if s == needle {
			return s, true
		}
	}
	return "", false
}

// cellValue is a database/sql.Scanner that never fails: since every
// SELECTed column is already cast to text in the query text itself (never
// decoded into a native type and reformatted in Go — spec/protocol.md
// §5.4.3's cast-in-SQL requirement), the driver always hands back a
// string, []byte, or nil. Falling back to the sentinel on any other shape
// (rather than returning an error and aborting the whole row's Scan)
// mirrors the Rust reference's per-column row_to_json fallback. Shared
// across every backend — the contract doesn't vary by SQL dialect.
type cellValue struct {
	null bool
	str  string
}

func (c *cellValue) Scan(src interface{}) error {
	switch v := src.(type) {
	case nil:
		c.null = true
	case string:
		c.str = v
	case []byte:
		c.str = string(v)
	default:
		c.str = "<undecodable>"
	}
	return nil
}

func (c *cellValue) asJSON() *string {
	if c.null {
		return nil
	}
	s := c.str
	return &s
}

func joinComma(parts []string) string {
	out := ""
	for i, p := range parts {
		if i > 0 {
			out += ", "
		}
		out += p
	}
	return out
}

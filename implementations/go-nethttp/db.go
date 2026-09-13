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

// ColumnPair is one {from, to} pairing of an incoming FK (spec/protocol.md
// §5.9): from is the referencing column, to the referenced column; a
// composite FK has more than one.
type ColumnPair struct {
	From string `json:"from"`
	To   string `json:"to"`
}

// ReferencedByEntry is one FK constraint elsewhere in the source whose
// target is the requested table (spec/protocol.md §5.9 — the reverse of
// ColumnRef).
type ReferencedByEntry struct {
	Table string `json:"table"`
	// Set only when the referencing table's schema differs from the
	// resolved one — the opposite end of the relationship from
	// ColumnRef.Schema.
	Schema     string       `json:"schema,omitempty"`
	Constraint string       `json:"constraint"`
	Columns    []ColumnPair `json:"columns"`
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

// DbSource is the database seam; routes never touch drivers directly.
// Every query is timeout-bounded, with enforcement varying by engine
// (spec/protocol.md §1; docs/adapter-decisions.md §6).
type DbSource interface {
	ListSchemas(ctx context.Context) ([]string, error)
	ListTables(ctx context.Context, schema *string) ([]TableInfo, error)
	TableCounts(ctx context.Context, schema *string) ([]CountEntry, error)
	QueryTable(ctx context.Context, schema *string, table string, opts QueryOpts) (TableData, error)
	CommonValues(ctx context.Context, schema *string, table, column string) ([]CommonValueEntry, error)
	// ReferencedBy lists every FK constraint elsewhere in the source whose
	// target is table (spec/protocol.md §5.9).
	ReferencedBy(ctx context.Context, schema *string, table string) ([]ReferencedByEntry, error)
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

// cellValue accepts the text-cast values required by spec/protocol.md §5.4.3
// without aborting a row for an unexpected driver value.
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

// groupReferencedBy merges single-pair ReferencedByEntry rows into one
// entry per (schema, table, constraint). It relies on the caller's catalog
// ORDER BY putting a constraint's columns adjacent — a run-length merge,
// not a full group-by. Each backend maps its own row shape (and applies
// any allow-list filter) before calling this. The result is always
// non-nil (empty, never null on the wire), so callers need no guard.
func groupReferencedBy(rows []ReferencedByEntry) []ReferencedByEntry {
	out := make([]ReferencedByEntry, 0, len(rows))
	for _, row := range rows {
		if n := len(out); n > 0 &&
			out[n-1].Table == row.Table &&
			out[n-1].Schema == row.Schema &&
			out[n-1].Constraint == row.Constraint {
			out[n-1].Columns = append(out[n-1].Columns, row.Columns...)
			continue
		}
		out = append(out, row)
	}
	return out
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

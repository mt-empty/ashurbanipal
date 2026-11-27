package ashurbanipal

import (
	"context"
	"database/sql"
	"fmt"
	"time"
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

// IndexInfo is one index of a table (spec/protocol.md §5.10). Columns are
// the key columns in index order; an expression entry is its expression text.
type IndexInfo struct {
	Name    string   `json:"name"`
	Columns []string `json:"columns"`
	Unique  bool     `json:"unique"`
	Method  string   `json:"method"`
	// Predicate is the partial-index WHERE text; omitted for a non-partial index.
	Predicate string `json:"predicate,omitempty"`
}

// ConstraintPK is a table's primary key; Name is omitted when the engine
// reports none.
type ConstraintPK struct {
	Name    string   `json:"name,omitempty"`
	Columns []string `json:"columns"`
}

// ConstraintUnique is one unique constraint.
type ConstraintUnique struct {
	Name    string   `json:"name"`
	Columns []string `json:"columns"`
}

// ConstraintFK is an outgoing foreign key, single-column or composite.
// Table/Schema name the referenced table; Schema is set only when it
// differs from the resolved one. OnDelete/OnUpdate are one of CASCADE,
// RESTRICT, SET NULL, SET DEFAULT, NO ACTION.
type ConstraintFK struct {
	Name     string       `json:"name"`
	Table    string       `json:"table"`
	Schema   string       `json:"schema,omitempty"`
	Columns  []ColumnPair `json:"columns"`
	OnDelete string       `json:"on_delete"`
	OnUpdate string       `json:"on_update"`
}

// ConstraintCheck is one check constraint; Expression is omitted where the
// engine cannot supply the SQL text.
type ConstraintCheck struct {
	Name       string `json:"name"`
	Expression string `json:"expression,omitempty"`
}

// Constraints groups a table's whole-object constraints. The slices are
// always non-nil so they encode as [] rather than null.
type Constraints struct {
	PrimaryKey  *ConstraintPK      `json:"primary_key,omitempty"`
	Unique      []ConstraintUnique `json:"unique"`
	ForeignKeys []ConstraintFK     `json:"foreign_keys"`
	Check       []ConstraintCheck  `json:"check"`
}

// Structure is the response body of GET /api/tables/structure (§5.10).
type Structure struct {
	Indexes     []IndexInfo `json:"indexes"`
	Constraints Constraints `json:"constraints"`
}

// newStructure returns a Structure whose slices are non-nil.
func newStructure() Structure {
	return Structure{
		Indexes: []IndexInfo{},
		Constraints: Constraints{
			Unique:      []ConstraintUnique{},
			ForeignKeys: []ConstraintFK{},
			Check:       []ConstraintCheck{},
		},
	}
}

// ColumnInfo is one column's metadata, sourced entirely from schema
// catalogs (spec/protocol.md §5.4.1) — never used to build SQL itself.
type ColumnInfo struct {
	Name       string     `json:"name"`
	Type       string     `json:"type"`
	Class      string     `json:"class"`               // the §5.4.1 column class
	EnumType   string     `json:"enum_type,omitempty"` // the enumerated type's identity; set only for class enum
	Collation  string     `json:"collation,omitempty"` // the collation where two text columns can clash
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

// Engine is a source's database engine as /api/sources reports it
// (spec/protocol.md §5.8); MariaDB is EngineMySQL.
type Engine string

const (
	EnginePostgres Engine = "postgres"
	EngineMySQL    Engine = "mysql"
	EngineSQLite   Engine = "sqlite"
)

// DbSource is the database seam; routes never touch drivers directly.
// Every query is timeout-bounded, with enforcement varying by engine
// (spec/protocol.md §1; docs/adapter-decisions.md §6).
type DbSource interface {
	// Engine is a constant per implementation: /api/sources never queries
	// the database (spec/protocol.md §5.8).
	Engine() Engine
	ListSchemas(ctx context.Context) (SchemaListing, error)
	ListTables(ctx context.Context, schema *string) ([]TableInfo, error)
	TableCounts(ctx context.Context, schema *string) ([]CountEntry, error)
	QueryTable(ctx context.Context, schema *string, table string, opts QueryOpts) (TableData, error)
	CommonValues(ctx context.Context, schema *string, table, column string) ([]CommonValueEntry, error)
	// ReferencedBy lists every FK constraint elsewhere in the source whose
	// target is table (spec/protocol.md §5.9).
	ReferencedBy(ctx context.Context, schema *string, table string) ([]ReferencedByEntry, error)
	// Structure reports table's indexes and constraints (spec/protocol.md §5.10).
	Structure(ctx context.Context, schema *string, table string) (Structure, error)
	// QueryJoin serves GET /api/tables/join (spec/protocol.md §5.11).
	QueryJoin(ctx context.Context, schema *string, spec JoinSpec, opts JoinOpts) (JoinData, error)
}

// queryer is satisfied by both *sql.DB and *sql.Tx — every backend's
// catalog helpers accept this so the same code runs whether it's querying
// outside a transaction or pinned to one (docs/design.md §5's "resolve
// once per operation" requirement).
type queryer interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

// SchemaListing is a source's browsable schemas plus the one an absent
// schema param resolves to: nil when the connection has no default schema,
// or its default is not listed (spec/protocol.md §5.7).
type SchemaListing struct {
	Schemas []string
	Default *string
}

func newSchemaListing(schemas []string, def *string) SchemaListing {
	if schemas == nil {
		schemas = []string{}
	}
	if def != nil {
		if _, ok := findExact(schemas, *def); !ok {
			def = nil
		}
	}
	return SchemaListing{Schemas: schemas, Default: def}
}

// errNoDefaultSchema rejects an absent schema param on a connection with no
// default schema (spec/protocol.md §1).
func errNoDefaultSchema() error {
	return &NotAllowedError{Kind: NotAllowedSchema, What: "no schema given, and this connection has no default schema"}
}

// requireExact returns name's catalog spelling, or a NotAllowedError when the
// allow-list lacks it.
func requireExact(allowed []string, name string, kind NotAllowedKind) (string, error) {
	if real, ok := findExact(allowed, name); ok {
		return real, nil
	}
	var noun string
	switch kind {
	case NotAllowedSchema:
		noun = "schema"
	case NotAllowedTable:
		noun = "table"
	case NotAllowedColumn:
		noun = "column"
	default:
		panic(fmt.Sprintf("requireExact called with kind %d", kind))
	}
	return "", &NotAllowedError{Kind: kind, What: fmt.Sprintf("%s %q", noun, name)}
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

type rowScanner interface {
	Next() bool
	Scan(...interface{}) error
	Err() error
}

// scanLabeledRow reads the current row as text cells keyed by label.
func scanLabeledRow(rows rowScanner, labels []string) (map[string]*string, error) {
	cells := make([]interface{}, len(labels))
	values := make([]cellValue, len(labels))
	for i := range values {
		cells[i] = &values[i]
	}
	if err := rows.Scan(cells...); err != nil {
		return nil, err
	}
	row := make(map[string]*string, len(labels))
	for i, label := range labels {
		row[label] = values[i].asJSON()
	}
	return row, nil
}

// scanLabeledRows reads every row; the query's own LIMIT bounds them.
func scanLabeledRows(rows rowScanner, labels []string) ([]map[string]*string, error) {
	out := []map[string]*string{}
	for rows.Next() {
		row, err := scanLabeledRow(rows, labels)
		if err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
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

// queryStrings runs a bounded query whose rows are one text column.
func queryStrings(ctx context.Context, q queryer, timeout time.Duration, query string, args ...any) ([]string, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	rows, err := q.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// pickSchema resolves the requested schema, or the connection's default when
// none is requested, against the allow-list (spec/protocol.md §5).
func pickSchema(schemas []string, requested *string, defaultSchema func() (*string, error)) (string, error) {
	resolved := requested
	if resolved == nil {
		def, err := defaultSchema()
		if err != nil {
			return "", err
		}
		if def == nil {
			return "", errNoDefaultSchema()
		}
		resolved = def
	}
	return requireExact(schemas, *resolved, NotAllowedSchema)
}

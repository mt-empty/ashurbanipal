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

// Catalog is the one seam to the database — the query.go handlers never
// touch *sql.DB directly. Every query (catalog/metadata included, not just
// row fetches) is bounded by the same configured timeout.
//
// Deliberate deviation from the Rust reference, documented per
// implementation.md §5.5 item 7 (catalog SQL diffed against db.rs, not
// independently reimplemented): db.rs hardcodes a separate
// CATALOG_TIMEOUT_SECS=5 constant for catalog/metadata queries, distinct
// from the configured limits.query_timeout_secs which only bounds the main
// row-fetch query. spec/protocol.md §6 just requires every query be
// "bounded by a timeout (configuration; reference default 5s)"; it doesn't
// require a second, separately-hardcoded bound for catalog queries. This
// port applies the one configured value uniformly — matching the Spring
// Boot port's single JdbcTemplate.queryTimeout, which does the same.
type Catalog struct {
	db      *sql.DB
	timeout time.Duration
}

type queryer interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func newCatalog(db *sql.DB, queryTimeoutSecs int) *Catalog {
	return &Catalog{db: db, timeout: time.Duration(queryTimeoutSecs) * time.Second}
}

func (c *Catalog) bounded(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(ctx, c.timeout)
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
// SELECTed column is already `::text`-cast in the query text itself (never
// decoded into a native type and reformatted in Go — spec/protocol.md
// §5.4.3's cast-in-SQL requirement), the driver always hands back a
// string, []byte, or nil. Falling back to the sentinel on any other shape
// (rather than returning an error and aborting the whole row's Scan)
// mirrors the Rust reference's per-column row_to_json fallback.
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

func (c *Catalog) allowedTables(ctx context.Context, db queryer) ([]string, error) {
	ctx, cancel := c.bounded(ctx)
	defer cancel()
	rows, err := db.QueryContext(ctx,
		`select table_name from information_schema.tables
		 where table_schema = current_schema() and table_type = 'BASE TABLE'
		 order by table_name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		out = append(out, name)
	}
	return out, rows.Err()
}

func (c *Catalog) allowedColumns(ctx context.Context, db queryer, table string) ([]string, error) {
	ctx, cancel := c.bounded(ctx)
	defer cancel()
	rows, err := db.QueryContext(ctx,
		`select column_name from information_schema.columns
		 where table_schema = current_schema() and table_name = $1
		 order by ordinal_position`, table)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		out = append(out, name)
	}
	return out, rows.Err()
}

type fkCandidate struct {
	column    string
	refTable  sql.NullString
	refColumn sql.NullString
}

// keyMetadata returns the set of primary-key columns and a column ->
// ColumnRef map for single-column foreign keys. Composite FKs are dropped
// entirely rather than risk mislabeling which referencing column pairs
// with which referenced column (spec/protocol.md §5.4.1). Composite
// *primary* keys are NOT dropped this way — every PK column still gets
// key="pk" regardless of how many columns are in the PK.
func (c *Catalog) keyMetadata(ctx context.Context, db queryer, table string) (map[string]bool, map[string]ColumnRef, error) {
	ctx, cancel := c.bounded(ctx)
	defer cancel()
	rows, err := db.QueryContext(ctx,
		`select tc.constraint_name, tc.constraint_type, kcu.column_name,
		        ccu.table_name as ref_table, ccu.column_name as ref_column
		 from information_schema.table_constraints tc
		 join information_schema.key_column_usage kcu
		   on kcu.constraint_name = tc.constraint_name
		  and kcu.table_schema = tc.table_schema
		 left join information_schema.constraint_column_usage ccu
		   on ccu.constraint_name = tc.constraint_name
		  and ccu.table_schema = tc.table_schema
		  and tc.constraint_type = 'FOREIGN KEY'
		 where tc.table_schema = current_schema()
		   and tc.table_name = $1
		   and tc.constraint_type in ('PRIMARY KEY', 'FOREIGN KEY')`, table)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()

	pkColumns := map[string]bool{}
	fkCandidates := map[string][]fkCandidate{}
	for rows.Next() {
		var constraintName, constraintType, columnName string
		var refTable, refColumn sql.NullString
		if err := rows.Scan(&constraintName, &constraintType, &columnName, &refTable, &refColumn); err != nil {
			return nil, nil, err
		}
		switch constraintType {
		case "PRIMARY KEY":
			pkColumns[columnName] = true
		case "FOREIGN KEY":
			fkCandidates[constraintName] = append(fkCandidates[constraintName], fkCandidate{
				column: columnName, refTable: refTable, refColumn: refColumn,
			})
		}
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}

	fkColumns := map[string]ColumnRef{}
	for _, members := range fkCandidates {
		distinct := map[string]bool{}
		for _, m := range members {
			distinct[m.column] = true
		}
		if len(distinct) != 1 {
			continue // composite FK: omit entirely
		}
		first := members[0]
		if first.refTable.Valid && first.refColumn.Valid {
			fkColumns[first.column] = ColumnRef{Table: first.refTable.String, Column: first.refColumn.String}
		}
	}
	return pkColumns, fkColumns, nil
}

// ListTables serves GET /api/tables.
func (c *Catalog) ListTables(ctx context.Context) ([]TableInfo, error) {
	ctx, cancel := c.bounded(ctx)
	defer cancel()
	rows, err := c.db.QueryContext(ctx,
		`select c.relname::text, obj_description(c.oid, 'pg_class')
		 from pg_class c
		 join pg_namespace n on n.oid = c.relnamespace
		 where n.nspname = current_schema() and c.relkind = 'r'
		 order by c.relname`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []TableInfo
	for rows.Next() {
		var name string
		var comment sql.NullString
		if err := rows.Scan(&name, &comment); err != nil {
			return nil, err
		}
		t := TableInfo{Name: name}
		if comment.Valid {
			t.Comment = &comment.String
		}
		out = append(out, t)
	}
	if out == nil {
		out = []TableInfo{}
	}
	return out, rows.Err()
}

// TableCounts serves GET /api/table-counts.
func (c *Catalog) TableCounts(ctx context.Context) ([]CountEntry, error) {
	ctx, cancel := c.bounded(ctx)
	defer cancel()
	rows, err := c.db.QueryContext(ctx,
		`select c.relname::text, c.reltuples::bigint
		 from pg_class c
		 join pg_namespace n on n.oid = c.relnamespace
		 where n.nspname = current_schema() and c.relkind = 'r'
		 order by c.relname`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []CountEntry
	for rows.Next() {
		var entry CountEntry
		if err := rows.Scan(&entry.Table, &entry.ApproxRows); err != nil {
			return nil, err
		}
		out = append(out, entry)
	}
	if out == nil {
		out = []CountEntry{}
	}
	return out, rows.Err()
}

// QueryTable serves GET /api/tables/data: validates table/sort/filter
// columns against the live schema, then runs one parameterized SELECT.
func (c *Catalog) QueryTable(ctx context.Context, table string, opts QueryOpts) (TableData, error) {
	tx, err := c.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return TableData{}, err
	}
	defer tx.Rollback()

	tables, err := c.allowedTables(ctx, tx)
	if err != nil {
		return TableData{}, err
	}
	realTable, ok := findExact(tables, table)
	if !ok {
		return TableData{}, &NotAllowedError{What: fmt.Sprintf("table %q", table)}
	}

	columnNames, err := c.allowedColumns(ctx, tx, realTable)
	if err != nil {
		return TableData{}, err
	}

	var sort *string
	if opts.Sort != nil {
		found, ok := findExact(columnNames, *opts.Sort)
		if !ok {
			return TableData{}, &NotAllowedError{What: fmt.Sprintf("column %q", *opts.Sort)}
		}
		sort = &found
	}

	var whereClause string
	var filterValues []string
	if len(opts.Filter) > 0 {
		whereClause, filterValues, err = BuildWhereClause(opts.Filter, columnNames)
		if err != nil {
			return TableData{}, err
		}
	}

	metaCtx, metaCancel := c.bounded(ctx)
	columnTypeRows, err := tx.QueryContext(metaCtx,
		`select column_name, data_type from information_schema.columns
		 where table_schema = current_schema() and table_name = $1
		 order by ordinal_position`, realTable)
	if err != nil {
		metaCancel()
		return TableData{}, err
	}
	type colType struct{ name, typ string }
	var columnTypes []colType
	for columnTypeRows.Next() {
		var ct colType
		if err := columnTypeRows.Scan(&ct.name, &ct.typ); err != nil {
			columnTypeRows.Close()
			metaCancel()
			return TableData{}, err
		}
		columnTypes = append(columnTypes, ct)
	}
	if err := columnTypeRows.Err(); err != nil {
		columnTypeRows.Close()
		metaCancel()
		return TableData{}, err
	}
	columnTypeRows.Close()

	// Joins through pg_attribute/pg_class directly: col_description is
	// keyed by attnum, which can diverge from ordinal_position once a
	// column has been dropped.
	commentRows, err := tx.QueryContext(metaCtx,
		`select a.attname::text, col_description(a.attrelid, a.attnum::int)
		 from pg_attribute a
		 join pg_class c on c.oid = a.attrelid
		 join pg_namespace n on n.oid = c.relnamespace
		 where n.nspname = current_schema() and c.relname = $1
		   and a.attnum > 0 and not a.attisdropped`, realTable)
	if err != nil {
		metaCancel()
		return TableData{}, err
	}
	columnComments := map[string]string{}
	for commentRows.Next() {
		var name string
		var comment sql.NullString
		if err := commentRows.Scan(&name, &comment); err != nil {
			commentRows.Close()
			metaCancel()
			return TableData{}, err
		}
		if comment.Valid {
			columnComments[name] = comment.String
		}
	}
	if err := commentRows.Err(); err != nil {
		commentRows.Close()
		metaCancel()
		return TableData{}, err
	}
	commentRows.Close()
	metaCancel()

	pkColumns, fkColumns, err := c.keyMetadata(ctx, tx, realTable)
	if err != nil {
		return TableData{}, err
	}

	columns := make([]ColumnInfo, 0, len(columnTypes))
	for _, ct := range columnTypes {
		col := ColumnInfo{Name: ct.name, Type: ct.typ}
		switch {
		case pkColumns[ct.name]:
			col.Key = KeyPK
		case func() bool { _, ok := fkColumns[ct.name]; return ok }():
			col.Key = KeyFK
			ref := fkColumns[ct.name]
			col.References = &ref
		}
		if comment, ok := columnComments[ct.name]; ok {
			col.Comment = comment
		}
		columns = append(columns, col)
	}

	selectParts := make([]string, len(columns))
	for i, col := range columns {
		selectParts[i] = quoteIdent(col.Name) + "::text"
	}
	selectList := joinComma(selectParts)

	// Table-qualified: an unqualified `order by "col"` would resolve to
	// the ::text-cast output column in selectList, sorting
	// lexicographically instead of by the real typed value.
	orderClause := ""
	if sort != nil {
		direction := "asc"
		if opts.Descending {
			direction = "desc"
		}
		orderClause = fmt.Sprintf(" order by %s.%s %s", quoteIdent(realTable), quoteIdent(*sort), direction)
	}

	// Identifiers spliced here are schema-validated (realTable/columns via
	// allowedTables/allowedColumns, sort via the findExact check above,
	// filter columns via BuildWhereClause's own allow-list check); every
	// value is a bound $N parameter.
	query := fmt.Sprintf("select %s from %s%s%s limit $1 offset $2",
		selectList, quoteIdent(realTable), whereClause, orderClause)

	args := make([]interface{}, 0, 2+len(filterValues))
	args = append(args, opts.Limit, opts.Offset)
	for _, v := range filterValues {
		args = append(args, v)
	}

	queryCtx, queryCancel := c.bounded(ctx)
	defer queryCancel()
	rows, err := tx.QueryContext(queryCtx, query, args...)
	if err != nil {
		return TableData{}, err
	}
	defer rows.Close()

	var out []map[string]*string
	for rows.Next() {
		cells := make([]interface{}, len(columns))
		values := make([]cellValue, len(columns))
		for i := range values {
			cells[i] = &values[i]
		}
		if err := rows.Scan(cells...); err != nil {
			return TableData{}, err
		}
		row := make(map[string]*string, len(columns))
		for i, col := range columns {
			row[col.Name] = values[i].asJSON()
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		return TableData{}, err
	}
	if out == nil {
		out = []map[string]*string{}
	}

	var totalApprox int64
	err = tx.QueryRowContext(queryCtx,
		`select reltuples::bigint from pg_class c
		 join pg_namespace n on n.oid = c.relnamespace
		 where n.nspname = current_schema() and c.relname = $1`, realTable).Scan(&totalApprox)
	if err != nil {
		return TableData{}, err
	}

	if err := tx.Commit(); err != nil {
		return TableData{}, err
	}
	return TableData{Columns: columns, Rows: out, TotalApprox: totalApprox}, nil
}

// CommonValues serves GET /api/tables/common-values.
func (c *Catalog) CommonValues(ctx context.Context, table, column string) ([]CommonValueEntry, error) {
	tx, err := c.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	tables, err := c.allowedTables(ctx, tx)
	if err != nil {
		return nil, err
	}
	realTable, ok := findExact(tables, table)
	if !ok {
		return nil, &NotAllowedError{What: fmt.Sprintf("table %q", table)}
	}
	columnNames, err := c.allowedColumns(ctx, tx, realTable)
	if err != nil {
		return nil, err
	}
	realColumn, ok := findExact(columnNames, column)
	if !ok {
		return nil, &NotAllowedError{What: fmt.Sprintf("column %q", column)}
	}

	ctx, cancel := c.bounded(ctx)
	defer cancel()

	// most_common_vals is anyarray; ::text::text[] reads it uniformly.
	// NULL (no ANALYZE stats yet) unnests to zero rows, not an error.
	rows, err := tx.QueryContext(ctx,
		`select t.val, t.freq
		 from pg_stats,
		      lateral unnest(most_common_vals::text::text[], most_common_freqs) as t(val, freq)
		 where schemaname = current_schema() and tablename = $1 and attname = $2
		 order by t.freq desc`, realTable, realColumn)
	if err != nil {
		return nil, err
	}
	var entries []CommonValueEntry
	for rows.Next() {
		var e CommonValueEntry
		if err := rows.Scan(&e.Value, &e.Freq); err != nil {
			rows.Close()
			return nil, err
		}
		entries = append(entries, e)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()

	var dataType sql.NullString
	err = tx.QueryRowContext(ctx,
		`select data_type from information_schema.columns
		 where table_schema = current_schema() and table_name = $1 and column_name = $2`,
		realTable, realColumn).Scan(&dataType)
	if err != nil && err != sql.ErrNoRows {
		return nil, err
	}

	// boolean's array-literal text form is "t"/"f", not "true"/"false" —
	// normalize to match QueryTable's rendering.
	if dataType.Valid && dataType.String == "boolean" {
		for i, e := range entries {
			switch e.Value {
			case "t":
				entries[i].Value = "true"
			case "f":
				entries[i].Value = "false"
			}
		}
	}
	if entries == nil {
		entries = []CommonValueEntry{}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return entries, nil
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

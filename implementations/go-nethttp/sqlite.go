//go:build sqlite

package ashurbanipal

import (
	"context"
	"database/sql"
	"fmt"
	"time"
)

// onlySchema is the only name ListSchemas ever returns — SQLite has no
// schema namespace above a single database file, mirroring how a bare
// ATTACH-less connection exposes its one implicit "main" schema
// (implementations/rust/core/src/db/sqlite.rs::ONLY_SCHEMA).
const onlySchema = "main"

// checkSchema rejects any requested schema other than onlySchema with the
// same NotAllowedError shape Postgres returns for a schema absent from its
// live allow-list, so callers don't need to special-case which backend
// rejected it.
func checkSchema(schema *string) error {
	if schema == nil || *schema == onlySchema {
		return nil
	}
	return &NotAllowedError{What: fmt.Sprintf("schema %q", *schema)}
}

// SQLiteSource is gated behind the `sqlite` build tag (opt-in, mirroring
// the Rust reference's `sqlite` Cargo feature) — see
// docs/adapter-decisions.md for the per-clause decisions this makes where
// Postgres-specific catalog/stats mechanisms have no SQLite equivalent.
//
// Unlike PostgresSource, catalog lookups here don't pin one *sql.Tx per
// operation: SQLite has no per-session state (no search_path/USE-database
// analog) that could drift between pooled connections, so the
// cross-connection consistency problem resolveSchema's transaction-pinning
// solves on Postgres/MySQL simply doesn't exist here — this matches the
// Rust reference's own choice (sqlite.rs's query_table acquires a fresh
// pooled connection per catalog call, not one held for the whole
// operation).
type SQLiteSource struct {
	db      *sql.DB
	timeout time.Duration
}

// NewSQLiteSource builds a DbSource backed by db, bounding every query
// (catalog and data alike) by queryTimeoutSecs. db must already be opened
// with a SQLite driver (e.g. modernc.org/sqlite).
func NewSQLiteSource(db *sql.DB, queryTimeoutSecs int) *SQLiteSource {
	return &SQLiteSource{db: db, timeout: time.Duration(queryTimeoutSecs) * time.Second}
}

var _ DbSource = (*SQLiteSource)(nil)

// bounded wraps every query in a context deadline. Verified empirically
// (not inferred from documentation, per this port's brief) against a real
// SQLite file with a single-connection pool: a slow recursive-CTE query
// canceled by ctx returns in ~1s (not the tens of seconds the full scan
// would take), and a query issued immediately afterward on the same
// physical connection completes without delay — proving modernc.org/sqlite
// actually aborts execution on cancellation rather than just abandoning
// the wait while the query keeps running server-side. Unlike the Rust
// reference (whose sqlx driver needed sqlite3_progress_handler because
// context cancellation there only stopped waiting, not the blocking C
// call), plain database/sql context cancellation is sufficient here — and
// unlike that progress handler, nothing needs clearing afterward.
func (c *SQLiteSource) bounded(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(ctx, c.timeout)
}

func (c *SQLiteSource) allowedTables(ctx context.Context) ([]string, error) {
	ctx, cancel := c.bounded(ctx)
	defer cancel()
	rows, err := c.db.QueryContext(ctx,
		`select name from sqlite_master
		 where type = 'table' and name not like 'sqlite\_%' escape '\'
		 order by name`)
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

// allowedColumns' table argument must already be validated against
// allowedTables — pragma_table_info is a table-valued function that takes
// its argument as spliced SQL text, not a bound parameter, so this is the
// one identifier per query that's escaped rather than bound (mirrors
// sqlite.rs::allowed_columns).
func (c *SQLiteSource) allowedColumns(ctx context.Context, table string) ([]string, error) {
	ctx, cancel := c.bounded(ctx)
	defer cancel()
	rows, err := c.db.QueryContext(ctx,
		fmt.Sprintf("select cid, name from pragma_table_info(%s) order by cid", quoteIdent(table)))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var cid int64
		var name string
		if err := rows.Scan(&cid, &name); err != nil {
			return nil, err
		}
		out = append(out, name)
	}
	return out, rows.Err()
}

// keyMetadata mirrors postgres.go's keyMetadata: composite FKs are dropped
// entirely rather than risk mislabeling which referencing column pairs
// with which referenced column (spec/protocol.md §5.4.1).
func (c *SQLiteSource) keyMetadata(ctx context.Context, table string) (map[string]bool, map[string]ColumnRef, error) {
	quoted := quoteIdent(table)
	ctx, cancel := c.bounded(ctx)
	defer cancel()

	pkRows, err := c.db.QueryContext(ctx,
		fmt.Sprintf("select name, pk from pragma_table_info(%s)", quoted))
	if err != nil {
		return nil, nil, err
	}
	pkColumns := map[string]bool{}
	for pkRows.Next() {
		var name string
		var pk int64
		if err := pkRows.Scan(&name, &pk); err != nil {
			pkRows.Close()
			return nil, nil, err
		}
		if pk > 0 {
			pkColumns[name] = true
		}
	}
	if err := pkRows.Err(); err != nil {
		pkRows.Close()
		return nil, nil, err
	}
	pkRows.Close()

	// (id, seq, table, from, to) — id groups columns belonging to the same
	// constraint (composite FKs share an id). The quoted "table"/"from"/"to"
	// are pragma_foreign_key_list's own fixed output column names (SQL
	// keywords needing escape), not the caller-supplied table.
	fkRows, err := c.db.QueryContext(ctx,
		fmt.Sprintf(`select id, "table", "from", "to" from pragma_foreign_key_list(%s)`, quoted))
	if err != nil {
		return nil, nil, err
	}
	type fkRow struct {
		id                 int64
		refTable, from, to string
	}
	byConstraint := map[int64][]fkRow{}
	for fkRows.Next() {
		var r fkRow
		if err := fkRows.Scan(&r.id, &r.refTable, &r.from, &r.to); err != nil {
			fkRows.Close()
			return nil, nil, err
		}
		byConstraint[r.id] = append(byConstraint[r.id], r)
	}
	if err := fkRows.Err(); err != nil {
		fkRows.Close()
		return nil, nil, err
	}
	fkRows.Close()

	fkColumns := map[string]ColumnRef{}
	for _, members := range byConstraint {
		if len(members) != 1 {
			continue // composite FK: omit entirely
		}
		m := members[0]
		fkColumns[m.from] = ColumnRef{Table: m.refTable, Column: m.to}
	}
	return pkColumns, fkColumns, nil
}

// sqliteBuildWhereClause is the SQLite equivalent of postgres.go's
// BuildWhereClause: `?` placeholders instead of `$N`, `CAST(col AS TEXT)`
// instead of `col::text`, and ILIKE mapped to plain LIKE — SQLite's LIKE
// is already ASCII case-insensitive by default, so there's no separate
// case-insensitive keyword to map to (docs/adapter-decisions.md §5.4.2).
func sqliteBuildWhereClause(conditions []Condition, columnNames []string) (string, []string, error) {
	if len(conditions) == 0 {
		return "", nil, nil
	}
	allowed := make(map[string]bool, len(columnNames))
	for _, c := range columnNames {
		allowed[c] = true
	}

	var values []string
	var clause []byte
	for i, cond := range conditions {
		if !allowed[cond.Column] {
			return "", nil, &NotAllowedError{What: fmt.Sprintf("column %q", cond.Column)}
		}
		if !validOps[cond.Op] {
			return "", nil, filterErr("condition %d has invalid op %q", i, cond.Op)
		}
		keyword := cond.Op
		if keyword == "ILIKE" {
			keyword = "LIKE"
		}
		cast := fmt.Sprintf("CAST(%s AS TEXT)", quoteIdent(cond.Column))
		var inner string
		if opTakesValue(cond.Op) {
			if cond.Value == nil {
				return "", nil, filterErr("op %q requires a value", cond.Op)
			}
			inner = fmt.Sprintf("%s %s ?", cast, keyword)
			values = append(values, *cond.Value)
		} else {
			inner = fmt.Sprintf("%s %s", cast, keyword)
		}
		wrapped := "(" + inner + ")"
		if cond.Not {
			wrapped = "(NOT (" + inner + "))"
		}
		if i > 0 {
			if cond.Logic == nil {
				return "", nil, filterErr("condition %d is missing logic", i)
			}
			if *cond.Logic == "OR" {
				clause = append(clause, " OR "...)
			} else {
				clause = append(clause, " AND "...)
			}
		}
		clause = append(clause, wrapped...)
	}
	return " where " + string(clause), values, nil
}

func (c *SQLiteSource) ListSchemas(ctx context.Context) ([]string, error) {
	return []string{onlySchema}, nil
}

func (c *SQLiteSource) ListTables(ctx context.Context, schema *string) ([]TableInfo, error) {
	if err := checkSchema(schema); err != nil {
		return nil, err
	}
	names, err := c.allowedTables(ctx)
	if err != nil {
		return nil, err
	}
	// No obj_description equivalent in SQLite — comments unsupported.
	out := make([]TableInfo, len(names))
	for i, name := range names {
		out[i] = TableInfo{Name: name}
	}
	return out, nil
}

func (c *SQLiteSource) TableCounts(ctx context.Context, schema *string) ([]CountEntry, error) {
	if err := checkSchema(schema); err != nil {
		return nil, err
	}
	names, err := c.allowedTables(ctx)
	if err != nil {
		return nil, err
	}
	// SQLite has no reltuples-equivalent catalog estimate; -1 is the
	// documented "no estimate" sentinel (spec/protocol.md §5.3) rather
	// than a per-table COUNT(*) scan. See docs/adapter-decisions.md.
	out := make([]CountEntry, len(names))
	for i, name := range names {
		out[i] = CountEntry{Table: name, ApproxRows: -1}
	}
	return out, nil
}

func (c *SQLiteSource) QueryTable(ctx context.Context, schema *string, table string, opts QueryOpts) (TableData, error) {
	if err := checkSchema(schema); err != nil {
		return TableData{}, err
	}
	tables, err := c.allowedTables(ctx)
	if err != nil {
		return TableData{}, err
	}
	realTable, ok := findExact(tables, table)
	if !ok {
		return TableData{}, &NotAllowedError{What: fmt.Sprintf("table %q", table)}
	}

	columnNames, err := c.allowedColumns(ctx, realTable)
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
		whereClause, filterValues, err = sqliteBuildWhereClause(opts.Filter, columnNames)
		if err != nil {
			return TableData{}, err
		}
	}

	pkColumns, fkColumns, err := c.keyMetadata(ctx, realTable)
	if err != nil {
		return TableData{}, err
	}

	typeCtx, typeCancel := c.bounded(ctx)
	typeRows, err := c.db.QueryContext(typeCtx,
		fmt.Sprintf("select cid, name, type from pragma_table_info(%s) order by cid", quoteIdent(realTable)))
	if err != nil {
		typeCancel()
		return TableData{}, err
	}
	type colType struct{ name, typ string }
	var columnTypes []colType
	for typeRows.Next() {
		var cid int64
		var ct colType
		if err := typeRows.Scan(&cid, &ct.name, &ct.typ); err != nil {
			typeRows.Close()
			typeCancel()
			return TableData{}, err
		}
		columnTypes = append(columnTypes, ct)
	}
	if err := typeRows.Err(); err != nil {
		typeRows.Close()
		typeCancel()
		return TableData{}, err
	}
	typeRows.Close()
	typeCancel()

	columns := make([]ColumnInfo, 0, len(columnTypes))
	for _, ct := range columnTypes {
		col := ColumnInfo{Name: ct.name, Type: ct.typ}
		// SQLite's declared column types can be empty (dynamic typing);
		// fall back to a stable label rather than emitting "".
		if col.Type == "" {
			col.Type = "unknown"
		}
		if ref, ok := fkColumns[ct.name]; ok {
			r := ref
			col.References = &r
		}
		switch {
		case pkColumns[ct.name]:
			col.Key = KeyPK
		case col.References != nil:
			col.Key = KeyFK
		}
		columns = append(columns, col)
	}

	selectParts := make([]string, len(columns))
	for i, col := range columns {
		selectParts[i] = fmt.Sprintf("CAST(%s AS TEXT)", quoteIdent(col.Name))
	}
	selectList := joinComma(selectParts)

	orderClause := ""
	if sort != nil {
		direction := "asc"
		if opts.Descending {
			direction = "desc"
		}
		orderClause = fmt.Sprintf(" order by %s.%s %s", quoteIdent(realTable), quoteIdent(*sort), direction)
	}

	// Identifiers spliced here are schema-validated (realTable via
	// allowedTables, columns via allowedColumns, sort via the findExact
	// check above, filter columns via sqliteBuildWhereClause's own
	// allow-list check); every value is a bound ? parameter.
	query := fmt.Sprintf("select %s from %s%s%s limit ? offset ?",
		selectList, quoteIdent(realTable), whereClause, orderClause)

	args := make([]interface{}, 0, len(filterValues)+2)
	for _, v := range filterValues {
		args = append(args, v)
	}
	args = append(args, opts.Limit, opts.Offset)

	queryCtx, queryCancel := c.bounded(ctx)
	defer queryCancel()
	rows, err := c.db.QueryContext(queryCtx, query, args...)
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

	return TableData{
		Columns: columns,
		Rows:    out,
		// No reltuples-equivalent estimate to read; -1 is the documented
		// "no estimate" sentinel (spec/protocol.md §5.4.4), not a live
		// COUNT(*) scan.
		TotalApprox: -1,
	}, nil
}

func (c *SQLiteSource) CommonValues(ctx context.Context, schema *string, table, column string) ([]CommonValueEntry, error) {
	if err := checkSchema(schema); err != nil {
		return nil, err
	}
	tables, err := c.allowedTables(ctx)
	if err != nil {
		return nil, err
	}
	realTable, ok := findExact(tables, table)
	if !ok {
		return nil, &NotAllowedError{What: fmt.Sprintf("table %q", table)}
	}
	columns, err := c.allowedColumns(ctx, realTable)
	if err != nil {
		return nil, err
	}
	if _, ok := findExact(columns, column); !ok {
		return nil, &NotAllowedError{What: fmt.Sprintf("column %q", column)}
	}
	// No pg_stats equivalent to read; an empty list is the documented "no
	// statistics available" answer (spec/protocol.md §5.5), not a live
	// GROUP BY scan. See docs/adapter-decisions.md.
	return []CommonValueEntry{}, nil
}

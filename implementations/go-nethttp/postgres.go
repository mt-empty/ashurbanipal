package ashurbanipal

import (
	"context"
	"database/sql"
	"fmt"
	"time"
)

// PostgresSource is the default/reference DbSource implementation — ported
// line-for-line against implementations/rust/core/src/db/postgres.rs's
// catalog SQL (PORTING.md hardening item 7). Every query (catalog/metadata
// included, not just row fetches) is bounded by the same configured
// timeout.
//
// Deliberate deviation from the Rust reference: postgres.rs hardcodes a
// separate CATALOG_TIMEOUT_SECS=5 for catalog/metadata queries, distinct
// from the main row-fetch query's configured limit. spec/protocol.md §6
// only requires every query be bounded by *a* timeout, not a
// separately-hardcoded one for catalog queries — this port applies the
// one configured value uniformly, matching the Spring Boot port's single
// JdbcTemplate.queryTimeout.
type PostgresSource struct {
	db      *sql.DB
	timeout time.Duration
}

// NewPostgresSource builds a DbSource backed by db, bounding every query
// (catalog and data alike) by queryTimeoutSecs. db must already be opened
// with a Postgres driver (e.g. github.com/jackc/pgx/v5/stdlib).
func NewPostgresSource(db *sql.DB, queryTimeoutSecs int) *PostgresSource {
	return &PostgresSource{db: db, timeout: time.Duration(queryTimeoutSecs) * time.Second}
}

var _ DbSource = (*PostgresSource)(nil)

func (c *PostgresSource) bounded(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(ctx, c.timeout)
}

// allowedSchemas excludes the catalogs themselves (`pg_catalog`,
// `information_schema`, `pg_toast%`, `pg_temp_%`) and anything the
// connected role can't actually use, so a schema only ever appears here if
// it's both a real user namespace and one this role has USAGE on
// (spec/protocol.md §5.7).
func (c *PostgresSource) allowedSchemas(ctx context.Context, db queryer) ([]string, error) {
	ctx, cancel := c.bounded(ctx)
	defer cancel()
	rows, err := db.QueryContext(ctx,
		`select nspname from pg_namespace
		 where nspname not in ('pg_catalog', 'information_schema')
		   and nspname not like 'pg_toast%'
		   and nspname not like 'pg_temp\_%' escape '\'
		   and has_schema_privilege(nspname, 'USAGE')
		 order by nspname`)
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

// resolveSchema resolves the schema for one operation exactly once: an
// explicit request and an absent one (resolved via current_schema()) both
// go through the same allow-list, so neither path can reach a schema the
// other would reject (docs/adapter-decisions.md §1). Callers run this
// against the operation's own transaction, which pins the whole operation
// to one physical connection — immune to pool sessions with divergent
// search_path.
func (c *PostgresSource) resolveSchema(ctx context.Context, db queryer, requested *string) (string, error) {
	schemas, err := c.allowedSchemas(ctx, db)
	if err != nil {
		return "", err
	}
	var resolved string
	if requested != nil {
		resolved = *requested
	} else {
		ctx, cancel := c.bounded(ctx)
		defer cancel()
		if err := db.QueryRowContext(ctx, "select current_schema()").Scan(&resolved); err != nil {
			return "", err
		}
	}
	real, ok := findExact(schemas, resolved)
	if !ok {
		return "", &NotAllowedError{What: fmt.Sprintf("schema %q", resolved)}
	}
	return real, nil
}

func (c *PostgresSource) allowedTables(ctx context.Context, db queryer, schema string) ([]string, error) {
	ctx, cancel := c.bounded(ctx)
	defer cancel()
	rows, err := db.QueryContext(ctx,
		`select table_name from information_schema.tables
		 where table_schema = $1 and table_type = 'BASE TABLE'
		 order by table_name`, schema)
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

func (c *PostgresSource) allowedColumns(ctx context.Context, db queryer, schema, table string) ([]string, error) {
	ctx, cancel := c.bounded(ctx)
	defer cancel()
	rows, err := db.QueryContext(ctx,
		`select column_name from information_schema.columns
		 where table_schema = $1 and table_name = $2
		 order by ordinal_position`, schema, table)
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
	refSchema sql.NullString
	refTable  sql.NullString
	refColumn sql.NullString
}

// keyMetadata returns the set of primary-key columns and a column ->
// ColumnRef map for single-column foreign keys. Composite FKs are dropped
// entirely rather than risk mislabeling which referencing column pairs
// with which referenced column (spec/protocol.md §5.4.1). Composite
// *primary* keys are NOT dropped this way — every PK column still gets
// key="pk" regardless of how many columns are in the PK.
//
// The `ccu` join must match on `ccu.constraint_schema` (the schema the
// constraint itself lives in, always equal to `tc.table_schema`), not
// `ccu.table_schema` (the schema of the table constraint_column_usage is
// describing — for a FOREIGN KEY row that's the *referenced* table's
// schema, which for a cross-schema FK differs from the constraining
// table's schema). Joining on `ccu.table_schema` instead silently drops
// every cross-schema FK's metadata (the LEFT JOIN just never matches).
func (c *PostgresSource) keyMetadata(ctx context.Context, db queryer, schema, table string) (map[string]bool, map[string]ColumnRef, error) {
	ctx, cancel := c.bounded(ctx)
	defer cancel()
	rows, err := db.QueryContext(ctx,
		`select tc.constraint_name, tc.constraint_type, kcu.column_name,
		        ccu.table_schema as ref_schema, ccu.table_name as ref_table, ccu.column_name as ref_column
		 from information_schema.table_constraints tc
		 join information_schema.key_column_usage kcu
		   on kcu.constraint_name = tc.constraint_name
		  and kcu.table_schema = tc.table_schema
		 left join information_schema.constraint_column_usage ccu
		   on ccu.constraint_name = tc.constraint_name
		  and ccu.constraint_schema = tc.table_schema
		  and tc.constraint_type = 'FOREIGN KEY'
		 where tc.table_schema = $1
		   and tc.table_name = $2
		   and tc.constraint_type in ('PRIMARY KEY', 'FOREIGN KEY')`, schema, table)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()

	pkColumns := map[string]bool{}
	fkCandidates := map[string][]fkCandidate{}
	for rows.Next() {
		var constraintName, constraintType, columnName string
		var refSchema, refTable, refColumn sql.NullString
		if err := rows.Scan(&constraintName, &constraintType, &columnName, &refSchema, &refTable, &refColumn); err != nil {
			return nil, nil, err
		}
		switch constraintType {
		case "PRIMARY KEY":
			pkColumns[columnName] = true
		case "FOREIGN KEY":
			fkCandidates[constraintName] = append(fkCandidates[constraintName], fkCandidate{
				column: columnName, refSchema: refSchema, refTable: refTable, refColumn: refColumn,
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
		if first.refSchema.Valid && first.refTable.Valid && first.refColumn.Valid {
			ref := ColumnRef{Table: first.refTable.String, Column: first.refColumn.String}
			// Same-schema is the overwhelming common case; omitting Schema
			// there keeps the wire payload byte-identical to before this
			// field existed.
			if first.refSchema.String != schema {
				ref.Schema = first.refSchema.String
			}
			fkColumns[first.column] = ref
		}
	}
	return pkColumns, fkColumns, nil
}

// ListSchemas serves GET /api/schemas.
func (c *PostgresSource) ListSchemas(ctx context.Context) ([]string, error) {
	schemas, err := c.allowedSchemas(ctx, c.db)
	if err != nil {
		return nil, err
	}
	if schemas == nil {
		schemas = []string{}
	}
	return schemas, nil
}

// ListTables serves GET /api/tables.
func (c *PostgresSource) ListTables(ctx context.Context, schema *string) ([]TableInfo, error) {
	tx, err := c.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	realSchema, err := c.resolveSchema(ctx, tx, schema)
	if err != nil {
		return nil, err
	}

	ctx, cancel := c.bounded(ctx)
	defer cancel()
	rows, err := tx.QueryContext(ctx,
		`select c.relname::text, obj_description(c.oid, 'pg_class')
		 from pg_class c
		 join pg_namespace n on n.oid = c.relnamespace
		 where n.nspname = $1 and c.relkind = 'r'
		 order by c.relname`, realSchema)
	if err != nil {
		return nil, err
	}
	var out []TableInfo
	for rows.Next() {
		var name string
		var comment sql.NullString
		if err := rows.Scan(&name, &comment); err != nil {
			rows.Close()
			return nil, err
		}
		t := TableInfo{Name: name}
		if comment.Valid {
			t.Comment = &comment.String
		}
		out = append(out, t)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	if out == nil {
		out = []TableInfo{}
	}
	return out, tx.Commit()
}

// TableCounts serves GET /api/table-counts.
func (c *PostgresSource) TableCounts(ctx context.Context, schema *string) ([]CountEntry, error) {
	tx, err := c.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	realSchema, err := c.resolveSchema(ctx, tx, schema)
	if err != nil {
		return nil, err
	}

	ctx, cancel := c.bounded(ctx)
	defer cancel()
	rows, err := tx.QueryContext(ctx,
		`select c.relname::text, c.reltuples::bigint
		 from pg_class c
		 join pg_namespace n on n.oid = c.relnamespace
		 where n.nspname = $1 and c.relkind = 'r'
		 order by c.relname`, realSchema)
	if err != nil {
		return nil, err
	}
	var out []CountEntry
	for rows.Next() {
		var entry CountEntry
		if err := rows.Scan(&entry.Table, &entry.ApproxRows); err != nil {
			rows.Close()
			return nil, err
		}
		out = append(out, entry)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	if out == nil {
		out = []CountEntry{}
	}
	return out, tx.Commit()
}

// QueryTable serves GET /api/tables/data: validates schema/table/sort/
// filter columns against the live schema, then runs one parameterized
// SELECT.
func (c *PostgresSource) QueryTable(ctx context.Context, schema *string, table string, opts QueryOpts) (TableData, error) {
	tx, err := c.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return TableData{}, err
	}
	defer tx.Rollback()

	realSchema, err := c.resolveSchema(ctx, tx, schema)
	if err != nil {
		return TableData{}, err
	}

	tables, err := c.allowedTables(ctx, tx, realSchema)
	if err != nil {
		return TableData{}, err
	}
	realTable, ok := findExact(tables, table)
	if !ok {
		return TableData{}, &NotAllowedError{What: fmt.Sprintf("table %q", table)}
	}

	columnNames, err := c.allowedColumns(ctx, tx, realSchema, realTable)
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
		 where table_schema = $1 and table_name = $2
		 order by ordinal_position`, realSchema, realTable)
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
		 where n.nspname = $1 and c.relname = $2
		   and a.attnum > 0 and not a.attisdropped`, realSchema, realTable)
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

	pkColumns, fkColumns, err := c.keyMetadata(ctx, tx, realSchema, realTable)
	if err != nil {
		return TableData{}, err
	}

	columns := make([]ColumnInfo, 0, len(columnTypes))
	for _, ct := range columnTypes {
		col := ColumnInfo{Name: ct.name, Type: ct.typ}
		if ref, ok := fkColumns[ct.name]; ok {
			col.References = &ref
		}
		switch {
		case pkColumns[ct.name]:
			col.Key = KeyPK
		case col.References != nil:
			col.Key = KeyFK
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

	// Table-qualified (by relation name, not schema — a FROM item's
	// correlation name is its own relation name regardless of whether
	// FROM itself is schema-qualified): an unqualified `order by "col"`
	// would resolve to the ::text-cast output column in selectList,
	// sorting lexicographically instead of by the real typed value.
	orderClause := ""
	if sort != nil {
		direction := "asc"
		if opts.Descending {
			direction = "desc"
		}
		orderClause = fmt.Sprintf(" order by %s.%s %s", quoteIdent(realTable), quoteIdent(*sort), direction)
	}

	// Identifiers spliced here are schema-validated (realSchema via
	// resolveSchema, realTable/columns via allowedTables/allowedColumns,
	// sort via the findExact check above, filter columns via
	// BuildWhereClause's own allow-list check); every value is a bound $N
	// parameter.
	query := fmt.Sprintf("select %s from %s.%s%s%s limit $1 offset $2",
		selectList, quoteIdent(realSchema), quoteIdent(realTable), whereClause, orderClause)

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
		 where n.nspname = $1 and c.relname = $2`, realSchema, realTable).Scan(&totalApprox)
	if err != nil {
		return TableData{}, err
	}

	if err := tx.Commit(); err != nil {
		return TableData{}, err
	}
	return TableData{Columns: columns, Rows: out, TotalApprox: totalApprox}, nil
}

// CommonValues serves GET /api/tables/common-values.
func (c *PostgresSource) CommonValues(ctx context.Context, schema *string, table, column string) ([]CommonValueEntry, error) {
	tx, err := c.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	realSchema, err := c.resolveSchema(ctx, tx, schema)
	if err != nil {
		return nil, err
	}

	tables, err := c.allowedTables(ctx, tx, realSchema)
	if err != nil {
		return nil, err
	}
	realTable, ok := findExact(tables, table)
	if !ok {
		return nil, &NotAllowedError{What: fmt.Sprintf("table %q", table)}
	}
	columnNames, err := c.allowedColumns(ctx, tx, realSchema, realTable)
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
		 where schemaname = $1 and tablename = $2 and attname = $3
		 order by t.freq desc`, realSchema, realTable, realColumn)
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
		 where table_schema = $1 and table_name = $2 and column_name = $3`,
		realSchema, realTable, realColumn).Scan(&dataType)
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

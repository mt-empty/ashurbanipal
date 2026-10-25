package ashurbanipal

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

// PostgresSource implements the Postgres backend (`spec/protocol.md` §5).
type PostgresSource struct {
	db      *sql.DB
	timeout time.Duration
}

// NewPostgresSource bounds catalog and data queries (`spec/protocol.md` §6).
func NewPostgresSource(db *sql.DB, queryTimeoutSecs int) *PostgresSource {
	return &PostgresSource{db: db, timeout: time.Duration(queryTimeoutSecs) * time.Second}
}

var _ DbSource = (*PostgresSource)(nil)

func init() {
	registerTimeoutDetector(func(err error) bool {
		var pgErr *pgconn.PgError
		return errors.As(err, &pgErr) && pgErr.Code == "57014"
	})
}

var pgJoinDialect = joinDialect{
	quote:    quoteIdent,
	castText: func(c string) string { return c + "::text" },
	numbered: true,
	ilike:    ilikeNative,
}

// pgTypeClass maps information_schema types to spec/protocol.md §5.11.2
// classes (docs/adapter-decisions.md §5.11).
func pgTypeClass(dataType, udtSchema, udtName string, isEnum bool) *typeClass {
	var c typeClass
	switch dataType {
	case "smallint", "integer", "bigint", "numeric":
		c = classNumber
	case "character varying", "character", "text":
		c = classText
	case "uuid":
		c = classUUID
	case "boolean":
		c = classBoolean
	case "bytea":
		c = classBinary
	case "date", "timestamp without time zone", "timestamp with time zone":
		c = classTemporal
	case "time without time zone", "time with time zone":
		c = classTime
	case "USER-DEFINED":
		switch {
		case isEnum:
			c = classEnum(udtSchema + "." + udtName)
		case udtName == "citext":
			c = classText
		default:
			return nil
		}
	default:
		return nil
	}
	return &c
}

func (c *PostgresSource) bounded(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(ctx, c.timeout)
}

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

// resolveSchema runs in the operation transaction to prevent pool-session drift
// (`spec/protocol.md` §5).
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
		return "", &NotAllowedError{Kind: NotAllowedSchema, What: fmt.Sprintf("schema %q", resolved)}
	}
	return real, nil
}

// readableTableOID resolves table to its OID iff it's a readable base
// table in schema — the single existence-and-privilege check every
// table-scoped operation needs before touching request-supplied SQL.
// Mirrors ListTables' own pg_class/relkind = 'r' predicate, not
// information_schema.tables' broader BASE TABLE (which also matches
// partitioned tables) — keeps this gate and ListTables in lockstep
// (docs/adapter-decisions.md §5.2/§5.3). One targeted row instead of
// fetching every table name in the schema to check membership of one.
func (c *PostgresSource) readableTableOID(ctx context.Context, db queryer, schema, table string) (int, error) {
	// Postgres text can never hold a NUL byte, so no real relname could ever
	// match one; short-circuit before it reaches the driver, which otherwise
	// throws its own encoding error ahead of the query ever getting a chance
	// to just say "no match" (spec/protocol.md §5.2).
	if strings.ContainsRune(table, 0) {
		return 0, &NotAllowedError{Kind: NotAllowedTable, What: fmt.Sprintf("table %q", table)}
	}
	ctx, cancel := c.bounded(ctx)
	defer cancel()
	var oid int
	if err := db.QueryRowContext(ctx,
		`select c.oid from pg_class c
		 join pg_namespace n on n.oid = c.relnamespace
		 where n.nspname = $1 and c.relname = $2 and c.relkind = 'r'
		   and has_table_privilege(c.oid, 'SELECT')`, schema, table).Scan(&oid); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return 0, &NotAllowedError{Kind: NotAllowedTable, What: fmt.Sprintf("table %q", table)}
		}
		return 0, err
	}
	return oid, nil
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

// keyMetadata uses constraint_schema for cross-schema FKs and omits composites
// (`spec/protocol.md` §5.4.1).
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
			// Same-schema references omit Schema on the wire (spec/protocol.md §5.4.1).
			if first.refSchema.String != schema {
				ref.Schema = first.refSchema.String
			}
			fkColumns[first.column] = ref
		}
	}
	return pkColumns, fkColumns, nil
}

// pgColumnComments joins pg_attribute/pg_class directly: col_description is
// keyed by attnum, which can diverge from ordinal_position once a column has
// been dropped.
func pgColumnComments(ctx context.Context, q queryer, schema, table string) (map[string]string, error) {
	rows, err := q.QueryContext(ctx,
		`select a.attname::text, col_description(a.attrelid, a.attnum::int)
		 from pg_attribute a
		 join pg_class c on c.oid = a.attrelid
		 join pg_namespace n on n.oid = c.relnamespace
		 where n.nspname = $1 and c.relname = $2
		   and a.attnum > 0 and not a.attisdropped`, schema, table)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	comments := map[string]string{}
	for rows.Next() {
		var name string
		var comment sql.NullString
		if err := rows.Scan(&name, &comment); err != nil {
			return nil, err
		}
		if comment.Valid {
			comments[name] = comment.String
		}
	}
	return comments, rows.Err()
}

// joinTableMeta reads a table already cleared by readableTableOID.
func (c *PostgresSource) joinTableMeta(ctx context.Context, tx queryer, schema, table string) (joinTableMeta, error) {
	metaCtx, cancel := c.bounded(ctx)
	defer cancel()
	rows, err := tx.QueryContext(metaCtx,
		`select c.column_name, c.data_type, c.udt_schema, c.udt_name,
		        exists (select 1 from pg_type t
		                join pg_namespace n on n.oid = t.typnamespace
		                where n.nspname = c.udt_schema and t.typname = c.udt_name
		                  and t.typtype = 'e')
		 from information_schema.columns c
		 where c.table_schema = $1 and c.table_name = $2
		 order by c.ordinal_position`, schema, table)
	if err != nil {
		return joinTableMeta{}, err
	}
	meta := joinTableMeta{name: table}
	for rows.Next() {
		var name, dataType, udtSchema, udtName string
		var isEnum bool
		if err := rows.Scan(&name, &dataType, &udtSchema, &udtName, &isEnum); err != nil {
			rows.Close()
			return joinTableMeta{}, err
		}
		meta.columns = append(meta.columns, joinColMeta{
			name: name, typeName: dataType, class: pgTypeClass(dataType, udtSchema, udtName, isEnum),
		})
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return joinTableMeta{}, err
	}
	rows.Close()

	comments, err := pgColumnComments(metaCtx, tx, schema, table)
	if err != nil {
		return joinTableMeta{}, err
	}

	pk, fk, err := c.keyMetadata(ctx, tx, schema, table)
	if err != nil {
		return joinTableMeta{}, err
	}
	for i := range meta.columns {
		col := &meta.columns[i]
		col.key, col.references = joinKeyOf(col.name, pk, fk)
		col.comment = comments[col.name]
	}
	return meta, nil
}

// QueryJoin serves GET /api/tables/join (spec/protocol.md §5.11): every
// lookup and the select run on one read-only transaction.
func (c *PostgresSource) QueryJoin(ctx context.Context, schema *string, spec JoinSpec, opts JoinOpts) (JoinData, error) {
	tx, err := c.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return JoinData{}, err
	}
	defer tx.Rollback()

	realSchema, err := c.resolveSchema(ctx, tx, schema)
	if err != nil {
		return JoinData{}, err
	}
	names := spec.TableNames()
	metas := map[string]joinTableMeta{}
	for _, name := range names {
		if _, ok := metas[name]; ok {
			continue
		}
		if _, err := c.readableTableOID(ctx, tx, realSchema, name); err != nil {
			return JoinData{}, unknownJoinTable(err)
		}
		meta, err := c.joinTableMeta(ctx, tx, realSchema, name)
		if err != nil {
			return JoinData{}, unknownJoinTable(err)
		}
		metas[name] = meta
	}
	tables := make([]joinTableMeta, len(names))
	for i, name := range names {
		tables[i] = metas[name]
	}
	plan, err := planJoin(spec, tables, opts)
	if err != nil {
		return JoinData{}, err
	}

	// The statement is built from catalog names and generated aliases
	// only; every value is a bound $N parameter.
	body, values := buildJoinSelect(plan, pgJoinDialect, &realSchema)
	args := make([]interface{}, 0, 2+len(values))
	args = append(args, opts.Limit+1, opts.Offset)
	for _, v := range values {
		args = append(args, v)
	}
	queryCtx, cancel := c.bounded(ctx)
	defer cancel()
	rows, err := tx.QueryContext(queryCtx, "select "+body, args...)
	if err != nil {
		return JoinData{}, mapSelectDenied(err, spec.Table)
	}
	defer rows.Close()
	out, hasMore, err := scanJoinRows(rows, plan.labels, opts.Limit)
	if err != nil {
		return JoinData{}, mapSelectDenied(err, spec.Table)
	}
	rows.Close()
	if err := tx.Commit(); err != nil {
		return JoinData{}, err
	}
	return JoinData{Columns: plan.columnInfos(), Rows: out, HasMore: hasMore}, nil
}

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
		   and has_table_privilege(c.oid, 'SELECT')
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
	// Same has_table_privilege filter as ListTables, so the count column
	// never names a table the table list won't show.
	rows, err := tx.QueryContext(ctx,
		`select c.relname::text, c.reltuples::bigint
		 from pg_class c
		 join pg_namespace n on n.oid = c.relnamespace
		 where n.nspname = $1 and c.relkind = 'r'
		   and has_table_privilege(c.oid, 'SELECT')
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

// mapSelectDenied turns a residual "permission denied" (SQLSTATE 42501) at
// the row fetch into a NotAllowedError (400) — the allow-list already
// rejects tables the role can't SELECT, so this only catches the edge. It
// also maps a filter value Postgres's text encoding rejects (SQLSTATE
// 22021/22P05) to a FilterError, also 400, never a raw 500
// (docs/adapter-decisions.md §5.4.2 has the cross-backend rationale).
func mapSelectDenied(err error, table string) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "42501":
			return &NotAllowedError{Kind: NotAllowedNotReadable, What: fmt.Sprintf("table %q", table)}
		case "22021", "22P05":
			return filterErr("value invalid for this backend: %s", pgErr.Message)
		}
	}
	return err
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

	if _, err := c.readableTableOID(ctx, tx, realSchema, table); err != nil {
		return TableData{}, err
	}
	realTable := table

	columnNames, err := c.allowedColumns(ctx, tx, realSchema, realTable)
	if err != nil {
		return TableData{}, err
	}

	var sort *string
	if opts.Sort != nil {
		found, ok := findExact(columnNames, *opts.Sort)
		if !ok {
			return TableData{}, &NotAllowedError{Kind: NotAllowedColumn, What: fmt.Sprintf("column %q", *opts.Sort)}
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

	columnComments, err := pgColumnComments(metaCtx, tx, realSchema, realTable)
	if err != nil {
		metaCancel()
		return TableData{}, err
	}
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
		return TableData{}, mapSelectDenied(err, realTable)
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

	if _, err := c.readableTableOID(ctx, tx, realSchema, table); err != nil {
		return nil, err
	}
	realTable := table
	columnNames, err := c.allowedColumns(ctx, tx, realSchema, realTable)
	if err != nil {
		return nil, err
	}
	realColumn, ok := findExact(columnNames, column)
	if !ok {
		return nil, &NotAllowedError{Kind: NotAllowedColumn, What: fmt.Sprintf("column %q", column)}
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

// ReferencedBy serves GET /api/tables/referenced-by (spec/protocol.md §5.9).
func (c *PostgresSource) ReferencedBy(ctx context.Context, schema *string, table string) ([]ReferencedByEntry, error) {
	tx, err := c.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	realSchema, err := c.resolveSchema(ctx, tx, schema)
	if err != nil {
		return nil, err
	}

	targetOID, err := c.readableTableOID(ctx, tx, realSchema, table)
	if err != nil {
		return nil, err
	}

	qctx, cancel := c.bounded(ctx)
	defer cancel()

	// pg_catalog, not information_schema: the reverse (confrelid) filter
	// over the standard-SQL views runs 20-40x slower on a large catalog
	// (docs/adapter-decisions.md §5.9). has_table_privilege is the
	// per-referrer read gate and works across schemas, so cross-schema
	// referrers are reported and gated without a separate allow-list pass.
	// conparentid = 0 excludes a partitioned referrer's per-partition
	// constraint copies (Postgres clones the parent's FK onto each
	// partition) — without it, one logical FK fans out into one entry per
	// partition plus the parent. relkind = 'r' gates the referrer itself the
	// same way targetOID above gates the target: a partitioned table's own
	// (non-inherited) FK constraint survives conparentid = 0 and would
	// otherwise be reported as a referrer name that queryTable/commonValues/
	// referencedBy-as-target then all reject, since none accept relkind = 'p'.
	rows, err := tx.QueryContext(qctx,
		`select rn.nspname, rc.relname, con.conname, fa.attname as from_col, ta.attname as to_col
		 from pg_constraint con
		 join pg_class rc on rc.oid = con.conrelid
		 join pg_namespace rn on rn.oid = rc.relnamespace
		 join lateral unnest(con.conkey, con.confkey) with ordinality
		      as k(from_attnum, to_attnum, n) on true
		 join pg_attribute fa on fa.attrelid = con.conrelid and fa.attnum = k.from_attnum
		 join pg_attribute ta on ta.attrelid = con.confrelid and ta.attnum = k.to_attnum
		 where con.contype = 'f'
		   and con.conparentid = 0
		   and con.confrelid = $1
		   and rc.relkind = 'r'
		   and has_table_privilege(con.conrelid, 'SELECT')
		 order by rn.nspname, rc.relname, con.conname, k.n`, targetOID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var mapped []ReferencedByEntry
	for rows.Next() {
		var refSchema, refTable, constraint, fromCol, toCol string
		if err := rows.Scan(&refSchema, &refTable, &constraint, &fromCol, &toCol); err != nil {
			return nil, err
		}
		entry := ReferencedByEntry{
			Table:      refTable,
			Constraint: constraint,
			Columns:    []ColumnPair{{From: fromCol, To: toCol}},
		}
		if refSchema != realSchema {
			entry.Schema = refSchema
		}
		mapped = append(mapped, entry)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}

	return groupReferencedBy(mapped), nil
}

// fkActionPG maps pg_constraint.confdeltype/confupdtype to the fixed
// vocabulary of spec/protocol.md §5.10.
func fkActionPG(code string) string {
	switch code {
	case "c":
		return "CASCADE"
	case "r":
		return "RESTRICT"
	case "n":
		return "SET NULL"
	case "d":
		return "SET DEFAULT"
	}
	return "NO ACTION"
}

// Structure serves GET /api/tables/structure (spec/protocol.md §5.10).
func (c *PostgresSource) Structure(ctx context.Context, schema *string, table string) (Structure, error) {
	tx, err := c.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return Structure{}, err
	}
	defer tx.Rollback()

	realSchema, err := c.resolveSchema(ctx, tx, schema)
	if err != nil {
		return Structure{}, err
	}
	oid, err := c.readableTableOID(ctx, tx, realSchema, table)
	if err != nil {
		return Structure{}, err
	}

	qctx, cancel := c.bounded(ctx)
	defer cancel()
	out := newStructure()

	// Key columns only (indnkeyatts): trailing indkey entries are INCLUDE
	// columns. An indkey entry of 0 is an expression with no pg_attribute
	// row, so the join is a left join and the entry renders through
	// pg_get_indexdef instead of vanishing.
	rows, err := tx.QueryContext(qctx,
		`select ic.relname::text, am.amname::text, ix.indisunique,
		        pg_get_expr(ix.indpred, ix.indrelid),
		        coalesce(a.attname::text, pg_get_indexdef(ix.indexrelid, k.n::int, true))
		 from pg_index ix
		 join pg_class ic on ic.oid = ix.indexrelid
		 join pg_am am on am.oid = ic.relam
		 join lateral unnest(ix.indkey::int2[]) with ordinality as k(attnum, n) on true
		 left join pg_attribute a on a.attrelid = ix.indrelid and a.attnum = k.attnum
		 where ix.indrelid = $1 and k.n <= ix.indnkeyatts
		 order by ic.relname, k.n`, oid)
	if err != nil {
		return Structure{}, err
	}
	for rows.Next() {
		var name, method, column string
		var unique bool
		var predicate sql.NullString
		if err := rows.Scan(&name, &method, &unique, &predicate, &column); err != nil {
			rows.Close()
			return Structure{}, err
		}
		if n := len(out.Indexes); n > 0 && out.Indexes[n-1].Name == name {
			out.Indexes[n-1].Columns = append(out.Indexes[n-1].Columns, column)
			continue
		}
		out.Indexes = append(out.Indexes, IndexInfo{
			Name: name, Columns: []string{column}, Unique: unique, Method: method,
			Predicate: predicate.String,
		})
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return Structure{}, err
	}

	// PK and UNIQUE need only conkey.
	rows, err = tx.QueryContext(qctx,
		`select con.contype::text, con.conname::text, a.attname::text
		 from pg_constraint con
		 join lateral unnest(con.conkey) with ordinality as k(attnum, n) on true
		 join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum
		 where con.conrelid = $1 and con.contype in ('p', 'u')
		 order by con.contype desc, con.conname, k.n`, oid)
	if err != nil {
		return Structure{}, err
	}
	for rows.Next() {
		var kind, name, column string
		if err := rows.Scan(&kind, &name, &column); err != nil {
			rows.Close()
			return Structure{}, err
		}
		if kind == "p" {
			if out.Constraints.PrimaryKey == nil {
				out.Constraints.PrimaryKey = &ConstraintPK{Name: name}
			}
			out.Constraints.PrimaryKey.Columns = append(out.Constraints.PrimaryKey.Columns, column)
			continue
		}
		if n := len(out.Constraints.Unique); n > 0 && out.Constraints.Unique[n-1].Name == name {
			out.Constraints.Unique[n-1].Columns = append(out.Constraints.Unique[n-1].Columns, column)
			continue
		}
		out.Constraints.Unique = append(out.Constraints.Unique, ConstraintUnique{Name: name, Columns: []string{column}})
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return Structure{}, err
	}

	// FK pairs conkey with confkey; the referenced table comes from confrelid.
	rows, err = tx.QueryContext(qctx,
		`select con.conname::text, rn.nspname::text, rc.relname::text,
		        fa.attname::text, ta.attname::text,
		        con.confdeltype::text, con.confupdtype::text
		 from pg_constraint con
		 join pg_class rc on rc.oid = con.confrelid
		 join pg_namespace rn on rn.oid = rc.relnamespace
		 join lateral unnest(con.conkey, con.confkey) with ordinality
		      as k(from_attnum, to_attnum, n) on true
		 join pg_attribute fa on fa.attrelid = con.conrelid and fa.attnum = k.from_attnum
		 join pg_attribute ta on ta.attrelid = con.confrelid and ta.attnum = k.to_attnum
		 where con.conrelid = $1 and con.contype = 'f'
		 and not exists (select 1 from pg_constraint par where par.oid = con.conparentid and par.conrelid = con.conrelid)
		 order by con.conname, k.n`, oid)
	if err != nil {
		return Structure{}, err
	}
	for rows.Next() {
		var name, refSchema, refTable, from, to, del, upd string
		if err := rows.Scan(&name, &refSchema, &refTable, &from, &to, &del, &upd); err != nil {
			rows.Close()
			return Structure{}, err
		}
		if n := len(out.Constraints.ForeignKeys); n > 0 && out.Constraints.ForeignKeys[n-1].Name == name {
			out.Constraints.ForeignKeys[n-1].Columns = append(out.Constraints.ForeignKeys[n-1].Columns, ColumnPair{From: from, To: to})
			continue
		}
		fk := ConstraintFK{
			Name: name, Table: refTable,
			Columns:  []ColumnPair{{From: from, To: to}},
			OnDelete: fkActionPG(del), OnUpdate: fkActionPG(upd),
		}
		if refSchema != realSchema {
			fk.Schema = refSchema
		}
		out.Constraints.ForeignKeys = append(out.Constraints.ForeignKeys, fk)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return Structure{}, err
	}

	rows, err = tx.QueryContext(qctx,
		`select con.conname::text, pg_get_expr(con.conbin, con.conrelid)
		 from pg_constraint con
		 where con.conrelid = $1 and con.contype = 'c'
		 order by con.conname`, oid)
	if err != nil {
		return Structure{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var name, def string
		if err := rows.Scan(&name, &def); err != nil {
			return Structure{}, err
		}
		out.Constraints.Check = append(out.Constraints.Check, ConstraintCheck{Name: name, Expression: def})
	}
	if err := rows.Err(); err != nil {
		return Structure{}, err
	}
	rows.Close()
	if err := tx.Commit(); err != nil {
		return Structure{}, err
	}
	return out, nil
}

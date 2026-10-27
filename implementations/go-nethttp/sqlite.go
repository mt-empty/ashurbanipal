//go:build sqlite

package ashurbanipal

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

// onlySchema is the only name ListSchemas returns for a single SQLite database.
const onlySchema = "main"

// checkSchema rejects any requested schema other than onlySchema with the
// same NotAllowedError shape Postgres returns for a schema absent from its
// live allow-list, so callers don't need to special-case which backend
// rejected it.
func checkSchema(schema *string) error {
	if schema == nil || *schema == onlySchema {
		return nil
	}
	return &NotAllowedError{Kind: NotAllowedSchema, What: fmt.Sprintf("schema %q", *schema)}
}

// SQLiteSource is optional; SQLite has no per-session schema state, so its
// operations need no schema-pinning transaction (docs/adapter-decisions.md).
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

func init() {
	// SQLITE_INTERRUPT (9): what the driver returns when a canceled context
	// aborts a running statement.
	registerTimeoutDetector(func(err error) bool {
		var coded interface{ Code() int }
		return errors.As(err, &coded) && coded.Code() == 9
	})
}

var sqliteJoinDialect = joinDialect{
	quote:    quoteIdent,
	castText: func(c string) string { return "CAST(" + c + " AS TEXT)" },
	numbered: false,
	ilike:    ilikeLike,
}

// sqliteTypeClass maps a declared type to a spec/protocol.md §5.11.2 class:
// recognised names first, then SQLite's affinity rules
// (docs/adapter-decisions.md §5.11).
func sqliteTypeClass(declared string) *typeClass {
	upper := strings.ToUpper(strings.TrimSpace(declared))
	var c typeClass
	switch base := strings.TrimSpace(strings.SplitN(upper, "(", 2)[0]); {
	case upper == "":
		c = classUntyped
	case base == "UUID":
		c = classUUID
	case base == "BOOLEAN" || base == "BOOL":
		c = classBoolean
	case base == "DATE" || base == "DATETIME" || strings.HasPrefix(base, "TIMESTAMP"):
		c = classTemporal
	case base == "TIME":
		c = classTime
	case base == "JSON" || base == "JSONB":
		return nil
	case strings.Contains(upper, "INT"):
		c = classNumber
	case strings.Contains(upper, "CHAR") || strings.Contains(upper, "CLOB") || strings.Contains(upper, "TEXT"):
		c = classText
	case strings.Contains(upper, "BLOB"):
		c = classBinary
	case strings.Contains(upper, "REAL") || strings.Contains(upper, "FLOA") || strings.Contains(upper, "DOUB"):
		return nil
	default:
		c = classNumber
	}
	return &c
}

func (c *SQLiteSource) joinTableMeta(ctx context.Context, q queryer, table string) (joinTableMeta, error) {
	metaCtx, cancel := c.bounded(ctx)
	rows, err := q.QueryContext(metaCtx,
		fmt.Sprintf("select cid, name, type from pragma_table_info(%s) order by cid", quoteIdent(table)))
	if err != nil {
		cancel()
		return joinTableMeta{}, err
	}
	meta := joinTableMeta{name: table}
	for rows.Next() {
		var cid int64
		var name, declared string
		if err := rows.Scan(&cid, &name, &declared); err != nil {
			rows.Close()
			cancel()
			return joinTableMeta{}, err
		}
		typeName := declared
		if typeName == "" {
			typeName = "unknown"
		}
		meta.columns = append(meta.columns, joinColMeta{name: name, typeName: typeName, class: sqliteTypeClass(declared)})
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		cancel()
		return joinTableMeta{}, err
	}
	rows.Close()
	cancel()

	pk, fk, err := c.keyMetadata(ctx, q, table)
	if err != nil {
		return joinTableMeta{}, err
	}
	for i := range meta.columns {
		col := &meta.columns[i]
		col.key, col.references = joinKeyOf(col.name, pk, fk)
	}
	return meta, nil
}

// QueryJoin serves GET /api/tables/join (spec/protocol.md §5.11): every
// lookup and the select run on one pinned connection.
func (c *SQLiteSource) QueryJoin(ctx context.Context, schema *string, spec JoinSpec, opts JoinOpts) (JoinData, error) {
	if err := checkSchema(schema); err != nil {
		return JoinData{}, err
	}
	conn, err := c.db.Conn(ctx)
	if err != nil {
		return JoinData{}, err
	}
	defer conn.Close()

	allowed, err := c.allowedTablesOn(ctx, conn)
	if err != nil {
		return JoinData{}, err
	}

	names := spec.TableNames()
	metas := map[string]joinTableMeta{}
	for _, name := range names {
		if _, ok := metas[name]; ok {
			continue
		}
		if _, ok := findExact(allowed, name); !ok {
			return JoinData{}, badJoin("unknown table %q", name)
		}
		meta, err := c.joinTableMeta(ctx, conn, name)
		if err != nil {
			return JoinData{}, err
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
	// only; every value is a bound ? parameter.
	body, values := buildJoinSelect(plan, sqliteJoinDialect, nil)
	args := make([]interface{}, 0, len(values)+2)
	for _, v := range values {
		args = append(args, v)
	}
	args = append(args, opts.Limit+1, opts.Offset)
	queryCtx, queryCancel := c.bounded(ctx)
	defer queryCancel()
	dataRows, err := conn.QueryContext(queryCtx, "select "+body, args...)
	if err != nil {
		return JoinData{}, err
	}
	defer dataRows.Close()
	out, hasMore, err := scanJoinRows(dataRows, plan.labels, opts.Limit)
	if err != nil {
		return JoinData{}, err
	}
	return JoinData{Columns: plan.columnInfos(), Rows: out, HasMore: hasMore}, nil
}

// bounded relies on modernc.org/sqlite honoring database/sql context cancellation.
func (c *SQLiteSource) bounded(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(ctx, c.timeout)
}

func (c *SQLiteSource) allowedTables(ctx context.Context) ([]string, error) {
	return c.allowedTablesOn(ctx, c.db)
}

func (c *SQLiteSource) allowedTablesOn(ctx context.Context, q queryer) ([]string, error) {
	ctx, cancel := c.bounded(ctx)
	defer cancel()
	rows, err := q.QueryContext(ctx,
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

// allowedColumns requires an allow-listed table: pragma_table_info cannot bind
// its identifier argument (spec/protocol.md §6).
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

// Composite FKs are omitted rather than risk mislabeling columns (spec/protocol.md §5.4.1).
func (c *SQLiteSource) keyMetadata(ctx context.Context, q queryer, table string) (map[string]bool, map[string]ColumnRef, error) {
	quoted := quoteIdent(table)
	ctx, cancel := c.bounded(ctx)
	defer cancel()

	pkRows, err := q.QueryContext(ctx,
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
	//
	// REFERENCES parent shorthand leaves "to" NULL; ppk resolves it by
	// position against the parent's PK, correlated per FK row since each
	// can reference a different parent — unlike ReferencedBy's single
	// bound parent (docs/adapter-decisions.md §5.4.1).
	fkRows, err := q.QueryContext(ctx,
		fmt.Sprintf(`select fkl.id, fkl.seq, fkl."table", fkl."from", coalesce(fkl."to", ppk.name, 'rowid')
		 from pragma_foreign_key_list(%s) fkl
		 left join pragma_table_info(fkl."table") ppk on ppk.pk = fkl.seq + 1`, quoted))
	if err != nil {
		return nil, nil, err
	}
	type fkRow struct {
		id, seq            int64
		refTable, from, to string
	}
	byConstraint := map[int64][]fkRow{}
	for fkRows.Next() {
		var r fkRow
		if err := fkRows.Scan(&r.id, &r.seq, &r.refTable, &r.from, &r.to); err != nil {
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
			return "", nil, &NotAllowedError{Kind: NotAllowedColumn, What: fmt.Sprintf("column %q", cond.Column)}
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

func (c *SQLiteSource) ListSchemas(ctx context.Context) (SchemaListing, error) {
	def := onlySchema
	return SchemaListing{Schemas: []string{onlySchema}, Default: &def}, nil
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
		return TableData{}, &NotAllowedError{Kind: NotAllowedTable, What: fmt.Sprintf("table %q", table)}
	}

	columnNames, err := c.allowedColumns(ctx, realTable)
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
		whereClause, filterValues, err = sqliteBuildWhereClause(opts.Filter, columnNames)
		if err != nil {
			return TableData{}, err
		}
	}

	pkColumns, fkColumns, err := c.keyMetadata(ctx, c.db, realTable)
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
		return nil, &NotAllowedError{Kind: NotAllowedTable, What: fmt.Sprintf("table %q", table)}
	}
	columns, err := c.allowedColumns(ctx, realTable)
	if err != nil {
		return nil, err
	}
	if _, ok := findExact(columns, column); !ok {
		return nil, &NotAllowedError{Kind: NotAllowedColumn, What: fmt.Sprintf("column %q", column)}
	}
	// No pg_stats equivalent to read; an empty list is the documented "no
	// statistics available" answer (spec/protocol.md §5.5), not a live
	// GROUP BY scan. See docs/adapter-decisions.md.
	return []CommonValueEntry{}, nil
}

// ReferencedBy serves GET /api/tables/referenced-by (spec/protocol.md §5.9).
func (c *SQLiteSource) ReferencedBy(ctx context.Context, schema *string, table string) ([]ReferencedByEntry, error) {
	if err := checkSchema(schema); err != nil {
		return nil, err
	}
	tables, err := c.allowedTables(ctx)
	if err != nil {
		return nil, err
	}
	if _, ok := findExact(tables, table); !ok {
		return nil, &NotAllowedError{Kind: NotAllowedTable, What: fmt.Sprintf("table %q", table)}
	}

	qctx, cancel := c.bounded(ctx)
	defer cancel()

	// No reverse-FK index and no information_schema: walk every table's
	// pragma_foreign_key_list (the schema is parsed in memory on open). The
	// TVF argument m.name is a column reference — not spliced; fkl."table"
	// is bound. COLLATE NOCASE because the pragma returns the referenced
	// name as written in the DDL, which SQLite resolves case-insensitively.
	// The sqlite_master predicate here matches allowedTables(), so every
	// referrer is already allow-listed.
	//
	// "REFERENCES parent" with no parenthesised column list is valid DDL
	// meaning "parent's own primary key", and for that form the pragma
	// reports "to" as NULL rather than filling in the PK name. ppk resolves
	// it: pragma_table_info(table)'s pk column is the 1-indexed position of
	// a column within the parent's primary key, matching fkl.seq's
	// 0-indexed position within the FK's column list — SQLite requires an
	// omitted column list to align position-for-position with the parent
	// PK, so this pairing holds for composite keys too. The 'rowid'
	// fallback covers a parent with no declared primary key, where
	// SQLite's parent key is the implicit rowid.
	rows, err := c.db.QueryContext(qctx,
		`select m.name, fkl.id, fkl."from", coalesce(fkl."to", ppk.name, 'rowid')
		 from sqlite_master m
		 join pragma_foreign_key_list(m.name) fkl
		 left join pragma_table_info(?) ppk on ppk.pk = fkl.seq + 1
		 where m.type = 'table'
		   and m.name not like 'sqlite\_%' escape '\'
		   and fkl."table" = ? collate nocase
		 order by m.name, fkl.id, fkl.seq`, table, table)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var mapped []ReferencedByEntry
	for rows.Next() {
		var refTable, fromCol, toCol string
		var fkID int64
		if err := rows.Scan(&refTable, &fkID, &fromCol, &toCol); err != nil {
			return nil, err
		}
		// SQLite FKs are unnamed; fk_<id> is a per-table-stable synthetic
		// label (spec/protocol.md §5.9 permits this).
		mapped = append(mapped, ReferencedByEntry{
			Table:      refTable,
			Constraint: fmt.Sprintf("fk_%d", fkID),
			Columns:    []ColumnPair{{From: fromCol, To: toCol}},
		})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	return groupReferencedBy(mapped), nil
}

// partialIndexPredicate returns the text after a CREATE INDEX statement's
// top-level WHERE, ignoring quoted text and anything inside parentheses
// (the column list and expression key parts). Only called for indexes
// pragma_index_list flags as partial.
func partialIndexPredicate(sqlText string) (string, bool) {
	var quote byte
	depth := 0
	for i := 0; i < len(sqlText); i++ {
		b := sqlText[i]
		if quote != 0 {
			if b == quote {
				quote = 0
			}
			continue
		}
		switch b {
		case '\'', '"', '`':
			quote = b
		case '[':
			quote = ']'
		case '(':
			depth++
		case ')':
			depth--
		default:
			if depth != 0 || !isASCIISpace(b) {
				continue
			}
			rest := sqlText[i+1:]
			if len(rest) > 5 && strings.EqualFold(rest[:5], "where") && (isASCIISpace(rest[5]) || rest[5] == '(') {
				return strings.TrimSpace(rest[5:]), true
			}
		}
	}
	return "", false
}

func isASCIISpace(b byte) bool {
	return b == ' ' || b == '\t' || b == '\n' || b == '\r' || b == '\f' || b == '\v'
}

// Structure serves GET /api/tables/structure (spec/protocol.md §5.10).
func (c *SQLiteSource) Structure(ctx context.Context, schema *string, table string) (Structure, error) {
	if err := checkSchema(schema); err != nil {
		return Structure{}, err
	}
	tables, err := c.allowedTables(ctx)
	if err != nil {
		return Structure{}, err
	}
	if _, ok := findExact(tables, table); !ok {
		return Structure{}, &NotAllowedError{Kind: NotAllowedTable, What: fmt.Sprintf("table %q", table)}
	}

	qctx, cancel := c.bounded(ctx)
	defer cancel()
	out := newStructure()
	quoted := quoteIdent(table)

	// key = 1 drops trailing rowid/auxiliary entries. An expression key
	// part has a NULL name and no recoverable text.
	rows, err := c.db.QueryContext(qctx,
		fmt.Sprintf(`select il.name, il."unique", il.origin, il.partial, ix.name
		 from pragma_index_list(%s) il
		 join pragma_index_xinfo(il.name) ix
		 where ix.key = 1
		 order by il.name, ix.seqno`, quoted))
	if err != nil {
		return Structure{}, err
	}
	partial := map[string]bool{}
	var uniqueOrigin []string
	for rows.Next() {
		var name, origin string
		var unique, isPartial int64
		var column sql.NullString
		if err := rows.Scan(&name, &unique, &origin, &isPartial, &column); err != nil {
			rows.Close()
			return Structure{}, err
		}
		col := column.String
		if !column.Valid {
			col = "<expression>"
		}
		if n := len(out.Indexes); n > 0 && out.Indexes[n-1].Name == name {
			out.Indexes[n-1].Columns = append(out.Indexes[n-1].Columns, col)
			continue
		}
		if origin == "u" {
			uniqueOrigin = append(uniqueOrigin, name)
		}
		if isPartial != 0 {
			partial[name] = true
		}
		out.Indexes = append(out.Indexes, IndexInfo{
			Name: name, Columns: []string{col}, Unique: unique != 0, Method: "btree",
		})
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return Structure{}, err
	}

	rows, err = c.db.QueryContext(qctx,
		`select name, sql from sqlite_master where type = 'index' and tbl_name = ?`, table)
	if err != nil {
		return Structure{}, err
	}
	sqlOf := map[string]string{}
	for rows.Next() {
		var name string
		var text sql.NullString
		if err := rows.Scan(&name, &text); err != nil {
			rows.Close()
			return Structure{}, err
		}
		if text.Valid {
			sqlOf[name] = text.String
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return Structure{}, err
	}
	for i := range out.Indexes {
		idx := &out.Indexes[i]
		if partial[idx.Name] {
			if p, ok := partialIndexPredicate(sqlOf[idx.Name]); ok {
				idx.Predicate = p
			}
		}
	}
	for _, name := range uniqueOrigin {
		for _, idx := range out.Indexes {
			if idx.Name == name {
				out.Constraints.Unique = append(out.Constraints.Unique, ConstraintUnique{Name: name, Columns: idx.Columns})
			}
		}
	}

	rows, err = c.db.QueryContext(qctx,
		fmt.Sprintf(`select name from pragma_table_info(%s) where pk > 0 order by pk`, quoted))
	if err != nil {
		return Structure{}, err
	}
	var pk []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			rows.Close()
			return Structure{}, err
		}
		pk = append(pk, name)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return Structure{}, err
	}
	if len(pk) > 0 {
		out.Constraints.PrimaryKey = &ConstraintPK{Columns: pk}
	}

	// "to" is NULL for REFERENCES parent shorthand; ppk resolves it from the
	// parent's primary key (docs/adapter-decisions.md §5.4.1).
	rows, err = c.db.QueryContext(qctx,
		fmt.Sprintf(`select fkl.id, fkl."table", fkl."from", coalesce(fkl."to", ppk.name, 'rowid'),
		        fkl.on_delete, fkl.on_update
		 from pragma_foreign_key_list(%s) fkl
		 left join pragma_table_info(fkl."table") ppk on ppk.pk = fkl.seq + 1
		 order by fkl.id, fkl.seq`, quoted))
	if err != nil {
		return Structure{}, err
	}
	defer rows.Close()
	lastID := int64(-1)
	for rows.Next() {
		var id int64
		var refTable, from, to, del, upd string
		if err := rows.Scan(&id, &refTable, &from, &to, &del, &upd); err != nil {
			return Structure{}, err
		}
		if n := len(out.Constraints.ForeignKeys); n > 0 && lastID == id {
			out.Constraints.ForeignKeys[n-1].Columns = append(out.Constraints.ForeignKeys[n-1].Columns, ColumnPair{From: from, To: to})
			continue
		}
		lastID = id
		out.Constraints.ForeignKeys = append(out.Constraints.ForeignKeys, ConstraintFK{
			Name: fmt.Sprintf("fk_%d", id), Table: refTable,
			Columns:  []ColumnPair{{From: from, To: to}},
			OnDelete: strings.ToUpper(del), OnUpdate: strings.ToUpper(upd),
		})
	}
	if err := rows.Err(); err != nil {
		return Structure{}, err
	}
	return out, nil
}

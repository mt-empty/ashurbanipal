//go:build mysql

package ashurbanipal

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/go-sql-driver/mysql"
)

// mysqlVariant selects fork-specific query timeout syntax (`spec/protocol.md` §6).
type mysqlVariant int

const (
	variantMySQL mysqlVariant = iota
	variantMariaDB
)

// MariaDB ignores MySQL timeout hints, so it needs a statement wrapper
// (`spec/protocol.md` §6).
func timedSelect(variant mysqlVariant, timeoutSecs int, body string) string {
	if variant == variantMariaDB {
		return fmt.Sprintf("set statement max_statement_time=%d for select %s", timeoutSecs, body)
	}
	return fmt.Sprintf("select /*+ MAX_EXECUTION_TIME(%d) */ %s", timeoutSecs*1000, body)
}

// quoteIdentMySQL backtick-escapes live-catalog identifiers (`spec/protocol.md` §5).
func quoteIdentMySQL(s string) string {
	return "`" + strings.ReplaceAll(s, "`", "``") + "`"
}

// mysqlBuildWhereClause maps ILIKE through LOWER for collation independence
// (`spec/protocol.md` §5.4.2).
func mysqlBuildWhereClause(conditions []Condition, columnNames []string) (string, []string, error) {
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
		cast := fmt.Sprintf("CAST(%s AS CHAR)", quoteIdentMySQL(cond.Column))

		var inner string
		switch {
		case cond.Op == "ILIKE":
			if cond.Value == nil {
				return "", nil, filterErr("op %q requires a value", cond.Op)
			}
			values = append(values, *cond.Value)
			inner = fmt.Sprintf("LOWER(%s) LIKE LOWER(?)", cast)
		case opTakesValue(cond.Op):
			if cond.Value == nil {
				return "", nil, filterErr("op %q requires a value", cond.Op)
			}
			values = append(values, *cond.Value)
			inner = fmt.Sprintf("%s %s ?", cast, cond.Op)
		default:
			inner = fmt.Sprintf("%s %s", cast, cond.Op)
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

// MySQLSource implements the MySQL backend (`spec/protocol.md` §5).
type MySQLSource struct {
	db         *sql.DB
	timeoutSec int
	timeout    time.Duration

	mu      sync.Mutex
	variant *mysqlVariant // nil until successfully detected
}

// NewMySQLSource bounds catalog and data queries (`spec/protocol.md` §6).
func NewMySQLSource(db *sql.DB, queryTimeoutSecs int) *MySQLSource {
	return &MySQLSource{
		db:         db,
		timeoutSec: queryTimeoutSecs,
		timeout:    time.Duration(queryTimeoutSecs) * time.Second,
	}
}

var _ DbSource = (*MySQLSource)(nil)

func init() {
	// 3024: MySQL's MAX_EXECUTION_TIME; 1969: MariaDB's max_statement_time.
	registerTimeoutDetector(func(err error) bool {
		var myErr *mysql.MySQLError
		return errors.As(err, &myErr) && (myErr.Number == 3024 || myErr.Number == 1969)
	})
}

var mysqlJoinDialect = joinDialect{
	quote:    quoteIdentMySQL,
	castText: func(c string) string { return "CAST(" + c + " AS CHAR)" },
	numbered: false,
	ilike:    ilikeLoweredLike,
}

// mysqlTypeClass maps information_schema types to spec/protocol.md
// §5.11.2 classes (docs/adapter-decisions.md §5.11).
func mysqlTypeClass(dataType, columnType string) *typeClass {
	var c typeClass
	switch strings.ToLower(dataType) {
	case "tinyint", "smallint", "mediumint", "int", "integer", "bigint", "decimal", "numeric":
		c = classNumber
	case "char", "varchar", "tinytext", "text", "mediumtext", "longtext":
		c = classText
	case "date", "datetime", "timestamp":
		c = classTemporal
	case "time":
		c = classTime
	case "binary", "varbinary", "tinyblob", "blob", "mediumblob", "longblob":
		c = classBinary
	case "uuid":
		c = classUUID
	case "enum":
		c = classEnum(columnType)
	default:
		return nil
	}
	return &c
}

func (c *MySQLSource) bounded(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(ctx, c.timeout)
}

// variantOf caches whether SELECT VERSION() contains MariaDB (`spec/protocol.md` §6).
func (c *MySQLSource) variantOf(ctx context.Context) (mysqlVariant, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.variant != nil {
		return *c.variant, nil
	}
	qctx, cancel := c.bounded(ctx)
	defer cancel()
	var version string
	if err := c.db.QueryRowContext(qctx, "select version()").Scan(&version); err != nil {
		return 0, err
	}
	v := variantMySQL
	if strings.Contains(strings.ToLower(version), "mariadb") {
		v = variantMariaDB
	}
	c.variant = &v
	return v, nil
}

// pinnedTx keeps schema resolution on one connection (`spec/protocol.md` §5).
func (c *MySQLSource) pinnedTx(ctx context.Context) (*sql.Tx, error) {
	return c.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
}

func (c *MySQLSource) allowedSchemasInTx(ctx context.Context, tx queryer, variant mysqlVariant) ([]string, error) {
	ctx, cancel := c.bounded(ctx)
	defer cancel()
	rows, err := tx.QueryContext(ctx, timedSelect(variant, c.timeoutSec,
		`schema_name from information_schema.schemata
		 where schema_name not in ('mysql', 'information_schema', 'performance_schema', 'sys')
		 order by schema_name`))
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

// resolveSchemaInTx reads the connection's default database (`spec/protocol.md` §5).
func (c *MySQLSource) resolveSchemaInTx(ctx context.Context, tx queryer, variant mysqlVariant, requested *string) (string, error) {
	schemas, err := c.allowedSchemasInTx(ctx, tx, variant)
	if err != nil {
		return "", err
	}
	var resolved string
	if requested != nil {
		resolved = *requested
	} else {
		ctx, cancel := c.bounded(ctx)
		defer cancel()
		if err := tx.QueryRowContext(ctx, timedSelect(variant, c.timeoutSec, "database()")).Scan(&resolved); err != nil {
			return "", err
		}
	}
	real, ok := findExact(schemas, resolved)
	if !ok {
		return "", &NotAllowedError{Kind: NotAllowedSchema, What: fmt.Sprintf("schema %q", resolved)}
	}
	return real, nil
}

func (c *MySQLSource) allowedTablesInTx(ctx context.Context, tx queryer, variant mysqlVariant, schema string) ([]string, error) {
	ctx, cancel := c.bounded(ctx)
	defer cancel()
	rows, err := tx.QueryContext(ctx, timedSelect(variant, c.timeoutSec,
		`table_name from information_schema.tables
		 where table_schema = ? and table_type = 'BASE TABLE'
		 order by table_name`), schema)
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

func (c *MySQLSource) allowedColumnsInTx(ctx context.Context, tx queryer, variant mysqlVariant, schema, table string) ([]string, error) {
	ctx, cancel := c.bounded(ctx)
	defer cancel()
	rows, err := tx.QueryContext(ctx, timedSelect(variant, c.timeoutSec,
		`column_name from information_schema.columns
		 where table_schema = ? and table_name = ?
		 order by ordinal_position`), schema, table)
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

type mysqlFKCandidate struct {
	column                         string
	refSchema, refTable, refColumn sql.NullString
}

// keyMetadataInTx joins MySQL's repeating PRIMARY name on table name and
// omits composite FKs (`spec/protocol.md` §5.4.1).
func (c *MySQLSource) keyMetadataInTx(ctx context.Context, tx queryer, variant mysqlVariant, schema, table string) (map[string]bool, map[string]ColumnRef, error) {
	ctx, cancel := c.bounded(ctx)
	defer cancel()
	rows, err := tx.QueryContext(ctx, timedSelect(variant, c.timeoutSec,
		`tc.constraint_name, tc.constraint_type, kcu.column_name,
		        kcu.referenced_table_schema, kcu.referenced_table_name, kcu.referenced_column_name
		 from information_schema.table_constraints tc
		 join information_schema.key_column_usage kcu
		   on kcu.constraint_name = tc.constraint_name
		  and kcu.table_schema = tc.table_schema
		  and kcu.table_name = tc.table_name
		 where tc.table_schema = ?
		   and tc.table_name = ?
		   and tc.constraint_type in ('PRIMARY KEY', 'FOREIGN KEY')`), schema, table)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()

	pkColumns := map[string]bool{}
	fkCandidates := map[string][]mysqlFKCandidate{}
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
			fkCandidates[constraintName] = append(fkCandidates[constraintName], mysqlFKCandidate{
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
			if first.refSchema.String != schema {
				ref.Schema = first.refSchema.String
			}
			fkColumns[first.column] = ref
		}
	}
	return pkColumns, fkColumns, nil
}

func (c *MySQLSource) joinTableMeta(ctx context.Context, tx queryer, variant mysqlVariant, schema, table string) (joinTableMeta, error) {
	metaCtx, cancel := c.bounded(ctx)
	defer cancel()
	rows, err := tx.QueryContext(metaCtx, timedSelect(variant, c.timeoutSec,
		`column_name, data_type, column_comment, collation_name, column_type
		 from information_schema.columns
		 where table_schema = ? and table_name = ?
		 order by ordinal_position`), schema, table)
	if err != nil {
		return joinTableMeta{}, err
	}
	meta := joinTableMeta{name: table}
	for rows.Next() {
		var name, dataType, comment, columnType string
		var collation sql.NullString
		if err := rows.Scan(&name, &dataType, &comment, &collation, &columnType); err != nil {
			rows.Close()
			return joinTableMeta{}, err
		}
		col := joinColMeta{name: name, typeName: dataType, class: mysqlTypeClass(dataType, columnType), comment: comment}
		if collation.Valid {
			cl := collation.String
			col.collation = &cl
		}
		meta.columns = append(meta.columns, col)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return joinTableMeta{}, err
	}
	rows.Close()

	pk, fk, err := c.keyMetadataInTx(ctx, tx, variant, schema, table)
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
// lookup and the select run on one pinned transaction.
func (c *MySQLSource) QueryJoin(ctx context.Context, schema *string, spec JoinSpec, opts JoinOpts) (JoinData, error) {
	variant, err := c.variantOf(ctx)
	if err != nil {
		return JoinData{}, err
	}
	tx, err := c.pinnedTx(ctx)
	if err != nil {
		return JoinData{}, err
	}
	defer tx.Rollback()
	realSchema, err := c.resolveSchemaInTx(ctx, tx, variant, schema)
	if err != nil {
		return JoinData{}, err
	}
	allowed, err := c.allowedTablesInTx(ctx, tx, variant, realSchema)
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
		meta, err := c.joinTableMeta(ctx, tx, variant, realSchema, name)
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
	body, values := buildJoinSelect(plan, mysqlJoinDialect, &realSchema)
	args := make([]interface{}, 0, len(values)+2)
	for _, v := range values {
		args = append(args, v)
	}
	args = append(args, opts.Limit+1, opts.Offset)
	queryCtx, queryCancel := c.bounded(ctx)
	defer queryCancel()
	rows, err := tx.QueryContext(queryCtx, timedSelect(variant, c.timeoutSec, body), args...)
	if err != nil {
		return JoinData{}, mapSelectDeniedMySQL(err, spec.Table)
	}
	defer rows.Close()
	out, hasMore, err := scanJoinRows(rows, plan.labels, opts.Limit)
	if err != nil {
		return JoinData{}, mapSelectDeniedMySQL(err, spec.Table)
	}
	rows.Close()
	if err := tx.Commit(); err != nil {
		return JoinData{}, err
	}
	return JoinData{Columns: plan.columnInfos(), Rows: out, HasMore: hasMore}, nil
}

func (c *MySQLSource) ListSchemas(ctx context.Context) ([]string, error) {
	variant, err := c.variantOf(ctx)
	if err != nil {
		return nil, err
	}
	tx, err := c.pinnedTx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	schemas, err := c.allowedSchemasInTx(ctx, tx, variant)
	if err != nil {
		return nil, err
	}
	if schemas == nil {
		schemas = []string{}
	}
	return schemas, tx.Commit()
}

func (c *MySQLSource) ListTables(ctx context.Context, schema *string) ([]TableInfo, error) {
	variant, err := c.variantOf(ctx)
	if err != nil {
		return nil, err
	}
	tx, err := c.pinnedTx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	realSchema, err := c.resolveSchemaInTx(ctx, tx, variant, schema)
	if err != nil {
		return nil, err
	}

	qctx, cancel := c.bounded(ctx)
	defer cancel()
	rows, err := tx.QueryContext(qctx, timedSelect(variant, c.timeoutSec,
		`table_name, table_comment from information_schema.tables
		 where table_schema = ? and table_type = 'BASE TABLE'
		 order by table_name`), realSchema)
	if err != nil {
		return nil, err
	}
	var out []TableInfo
	for rows.Next() {
		var name, comment string
		if err := rows.Scan(&name, &comment); err != nil {
			rows.Close()
			return nil, err
		}
		t := TableInfo{Name: name}
		// Empty comments are omitted (`spec/protocol.md` §5.2).
		if comment != "" {
			t.Comment = &comment
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

func (c *MySQLSource) TableCounts(ctx context.Context, schema *string) ([]CountEntry, error) {
	variant, err := c.variantOf(ctx)
	if err != nil {
		return nil, err
	}
	tx, err := c.pinnedTx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	realSchema, err := c.resolveSchemaInTx(ctx, tx, variant, schema)
	if err != nil {
		return nil, err
	}

	qctx, cancel := c.bounded(ctx)
	defer cancel()
	// table_rows is a potentially stale InnoDB estimate (`spec/protocol.md` §5.3).
	rows, err := tx.QueryContext(qctx, timedSelect(variant, c.timeoutSec,
		`table_name, cast(table_rows as signed) from information_schema.tables
		 where table_schema = ? and table_type = 'BASE TABLE'
		 order by table_name`), realSchema)
	if err != nil {
		return nil, err
	}
	var out []CountEntry
	for rows.Next() {
		var name string
		var count sql.NullInt64
		if err := rows.Scan(&name, &count); err != nil {
			rows.Close()
			return nil, err
		}
		entry := CountEntry{Table: name, ApproxRows: -1}
		// NULL means no estimate yet: emit -1 (`spec/protocol.md` §5.3).
		if count.Valid {
			entry.ApproxRows = count.Int64
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

// mapSelectDeniedMySQL maps residual error 1142 to NotAllowed: MySQL has no
// SELECT privilege gate (`spec/protocol.md` §2).
func mapSelectDeniedMySQL(err error, table string) error {
	var myErr *mysql.MySQLError
	if errors.As(err, &myErr) && myErr.Number == 1142 {
		return &NotAllowedError{Kind: NotAllowedNotReadable, What: fmt.Sprintf("table %q", table)}
	}
	return err
}

func (c *MySQLSource) QueryTable(ctx context.Context, schema *string, table string, opts QueryOpts) (TableData, error) {
	variant, err := c.variantOf(ctx)
	if err != nil {
		return TableData{}, err
	}
	tx, err := c.pinnedTx(ctx)
	if err != nil {
		return TableData{}, err
	}
	defer tx.Rollback()
	realSchema, err := c.resolveSchemaInTx(ctx, tx, variant, schema)
	if err != nil {
		return TableData{}, err
	}

	tables, err := c.allowedTablesInTx(ctx, tx, variant, realSchema)
	if err != nil {
		return TableData{}, err
	}
	realTable, ok := findExact(tables, table)
	if !ok {
		return TableData{}, &NotAllowedError{Kind: NotAllowedTable, What: fmt.Sprintf("table %q", table)}
	}

	columnNames, err := c.allowedColumnsInTx(ctx, tx, variant, realSchema, realTable)
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
		whereClause, filterValues, err = mysqlBuildWhereClause(opts.Filter, columnNames)
		if err != nil {
			return TableData{}, err
		}
	}

	metaCtx, metaCancel := c.bounded(ctx)
	// data_type and column_comment both sit as plain columns on
	// information_schema.columns — unlike Postgres, no separate
	// pg_attribute join is needed to get comments, and no
	// ordinal-position-vs-attnum drift is possible.
	metaRows, err := tx.QueryContext(metaCtx, timedSelect(variant, c.timeoutSec,
		`column_name, data_type, column_comment
		 from information_schema.columns
		 where table_schema = ? and table_name = ?
		 order by ordinal_position`), realSchema, realTable)
	if err != nil {
		metaCancel()
		return TableData{}, err
	}
	type colMeta struct{ name, typ, comment string }
	var columnMeta []colMeta
	for metaRows.Next() {
		var cm colMeta
		if err := metaRows.Scan(&cm.name, &cm.typ, &cm.comment); err != nil {
			metaRows.Close()
			metaCancel()
			return TableData{}, err
		}
		columnMeta = append(columnMeta, cm)
	}
	if err := metaRows.Err(); err != nil {
		metaRows.Close()
		metaCancel()
		return TableData{}, err
	}
	metaRows.Close()
	metaCancel()

	pkColumns, fkColumns, err := c.keyMetadataInTx(ctx, tx, variant, realSchema, realTable)
	if err != nil {
		return TableData{}, err
	}

	columns := make([]ColumnInfo, 0, len(columnMeta))
	for _, cm := range columnMeta {
		col := ColumnInfo{Name: cm.name, Type: cm.typ}
		if ref, ok := fkColumns[cm.name]; ok {
			r := ref
			col.References = &r
		}
		switch {
		case pkColumns[cm.name]:
			col.Key = KeyPK
		case col.References != nil:
			col.Key = KeyFK
		}
		if cm.comment != "" {
			col.Comment = cm.comment
		}
		columns = append(columns, col)
	}

	selectParts := make([]string, len(columns))
	for i, col := range columns {
		selectParts[i] = fmt.Sprintf("CAST(%s AS CHAR)", quoteIdentMySQL(col.Name))
	}
	selectList := joinComma(selectParts)

	// Table-qualified, same reason as postgres.go/sqlite.go: an
	// unqualified `order by` would resolve to the CAST-output column in
	// selectList, sorting lexicographically instead of by the real typed
	// value.
	orderClause := ""
	if sort != nil {
		direction := "asc"
		if opts.Descending {
			direction = "desc"
		}
		orderClause = fmt.Sprintf(" order by %s.%s %s", quoteIdentMySQL(realTable), quoteIdentMySQL(*sort), direction)
	}

	// Identifiers spliced here are schema-validated (realSchema via
	// resolveSchemaInTx, realTable/columns via allowedTablesInTx/
	// allowedColumnsInTx, sort via the findExact check above, filter
	// columns via mysqlBuildWhereClause's own allow-list check); every
	// value is a bound ? parameter.
	sqlBody := fmt.Sprintf("%s from %s.%s%s%s limit ? offset ?",
		selectList, quoteIdentMySQL(realSchema), quoteIdentMySQL(realTable), whereClause, orderClause)
	query := timedSelect(variant, c.timeoutSec, sqlBody)

	args := make([]interface{}, 0, len(filterValues)+2)
	for _, v := range filterValues {
		args = append(args, v)
	}
	args = append(args, opts.Limit, opts.Offset)

	queryCtx, queryCancel := c.bounded(ctx)
	defer queryCancel()
	rows, err := tx.QueryContext(queryCtx, query, args...)
	if err != nil {
		return TableData{}, mapSelectDeniedMySQL(err, realTable)
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

	var totalApprox sql.NullInt64
	err = tx.QueryRowContext(queryCtx, timedSelect(variant, c.timeoutSec,
		`cast(table_rows as signed) from information_schema.tables
		 where table_schema = ? and table_name = ?`), realSchema, realTable).Scan(&totalApprox)
	if err != nil {
		return TableData{}, err
	}
	total := int64(-1)
	if totalApprox.Valid {
		total = totalApprox.Int64
	}

	if err := tx.Commit(); err != nil {
		return TableData{}, err
	}
	return TableData{Columns: columns, Rows: out, TotalApprox: total}, nil
}

func (c *MySQLSource) CommonValues(ctx context.Context, schema *string, table, column string) ([]CommonValueEntry, error) {
	variant, err := c.variantOf(ctx)
	if err != nil {
		return nil, err
	}
	tx, err := c.pinnedTx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	realSchema, err := c.resolveSchemaInTx(ctx, tx, variant, schema)
	if err != nil {
		return nil, err
	}
	tables, err := c.allowedTablesInTx(ctx, tx, variant, realSchema)
	if err != nil {
		return nil, err
	}
	realTable, ok := findExact(tables, table)
	if !ok {
		return nil, &NotAllowedError{Kind: NotAllowedTable, What: fmt.Sprintf("table %q", table)}
	}
	columns, err := c.allowedColumnsInTx(ctx, tx, variant, realSchema, realTable)
	if err != nil {
		return nil, err
	}
	if _, ok := findExact(columns, column); !ok {
		return nil, &NotAllowedError{Kind: NotAllowedColumn, What: fmt.Sprintf("column %q", column)}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	// MySQL has no portable common-value statistics (`spec/protocol.md` §5.5).
	return []CommonValueEntry{}, nil
}

// ReferencedBy serves GET /api/tables/referenced-by (spec/protocol.md §5.9).
func (c *MySQLSource) ReferencedBy(ctx context.Context, schema *string, table string) ([]ReferencedByEntry, error) {
	variant, err := c.variantOf(ctx)
	if err != nil {
		return nil, err
	}
	tx, err := c.pinnedTx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	realSchema, err := c.resolveSchemaInTx(ctx, tx, variant, schema)
	if err != nil {
		return nil, err
	}
	allowed, err := c.allowedTablesInTx(ctx, tx, variant, realSchema)
	if err != nil {
		return nil, err
	}
	// One membership structure, shared by the target-table check and the
	// referrer post-filter below — MySQL/MariaDB have no cross-schema
	// privilege predicate (docs/adapter-decisions.md §5.9).
	allowedSet := make(map[string]bool, len(allowed))
	for _, t := range allowed {
		allowedSet[t] = true
	}
	if !allowedSet[table] {
		return nil, &NotAllowedError{Kind: NotAllowedTable, What: fmt.Sprintf("table %q", table)}
	}

	qctx, cancel := c.bounded(ctx)
	defer cancel()

	// table_schema = ? keeps referrers to the resolved database — MySQL /
	// MariaDB have no cross-schema privilege predicate
	// (docs/adapter-decisions.md §5.9). Read key_column_usage, not
	// referential_constraints, whose referenced-name column MariaDB nulls
	// for a role lacking privilege on the referenced table.
	rows, err := tx.QueryContext(qctx, timedSelect(variant, c.timeoutSec,
		`kcu.table_name, kcu.constraint_name, kcu.column_name, kcu.referenced_column_name
		 from information_schema.key_column_usage kcu
		 where kcu.referenced_table_schema = ? and kcu.referenced_table_name = ?
		   and kcu.table_schema = ?
		 order by kcu.table_name, kcu.constraint_name, kcu.ordinal_position`),
		realSchema, table, realSchema)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var mapped []ReferencedByEntry
	for rows.Next() {
		var refTable, constraint, fromCol, toCol string
		if err := rows.Scan(&refTable, &constraint, &fromCol, &toCol); err != nil {
			return nil, err
		}
		// Keep the referrer set inside the same allow-list every other
		// route on this backend serves from.
		if !allowedSet[refTable] {
			continue
		}
		mapped = append(mapped, ReferencedByEntry{
			Table:      refTable,
			Constraint: constraint,
			Columns:    []ColumnPair{{From: fromCol, To: toCol}},
		})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}

	return groupReferencedBy(mapped), nil
}

// Structure serves GET /api/tables/structure (spec/protocol.md §5.10).
func (c *MySQLSource) Structure(ctx context.Context, schema *string, table string) (Structure, error) {
	variant, err := c.variantOf(ctx)
	if err != nil {
		return Structure{}, err
	}
	tx, err := c.pinnedTx(ctx)
	if err != nil {
		return Structure{}, err
	}
	defer tx.Rollback()

	realSchema, err := c.resolveSchemaInTx(ctx, tx, variant, schema)
	if err != nil {
		return Structure{}, err
	}
	allowed, err := c.allowedTablesInTx(ctx, tx, variant, realSchema)
	if err != nil {
		return Structure{}, err
	}
	if _, ok := findExact(allowed, table); !ok {
		return Structure{}, &NotAllowedError{Kind: NotAllowedTable, What: fmt.Sprintf("table %q", table)}
	}

	qctx, cancel := c.bounded(ctx)
	defer cancel()
	out := newStructure()

	// MariaDB's statistics view has no expression column; MySQL 8.0.13+
	// reports a functional key part there with a NULL column_name.
	keyPart := "coalesce(s.column_name, s.expression)"
	if variant == variantMariaDB {
		keyPart = "s.column_name"
	}
	rows, err := tx.QueryContext(qctx, timedSelect(variant, c.timeoutSec,
		`s.index_name, cast(s.non_unique as signed), s.index_type, `+keyPart+`
		 from information_schema.statistics s
		 where s.table_schema = ? and s.table_name = ?
		 order by s.index_name, s.seq_in_index`), realSchema, table)
	if err != nil {
		return Structure{}, err
	}
	for rows.Next() {
		var name, method string
		var nonUnique int64
		var column sql.NullString
		if err := rows.Scan(&name, &nonUnique, &method, &column); err != nil {
			rows.Close()
			return Structure{}, err
		}
		if n := len(out.Indexes); n > 0 && out.Indexes[n-1].Name == name {
			out.Indexes[n-1].Columns = append(out.Indexes[n-1].Columns, column.String)
			continue
		}
		out.Indexes = append(out.Indexes, IndexInfo{
			Name: name, Columns: []string{column.String}, Unique: nonUnique == 0,
			Method: strings.ToLower(method),
		})
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return Structure{}, err
	}

	rows, err = tx.QueryContext(qctx, timedSelect(variant, c.timeoutSec,
		`tc.constraint_type, tc.constraint_name, kcu.column_name
		 from information_schema.table_constraints tc
		 join information_schema.key_column_usage kcu
		   on kcu.constraint_schema = tc.constraint_schema
		  and kcu.constraint_name = tc.constraint_name
		  and kcu.table_schema = tc.table_schema
		  and kcu.table_name = tc.table_name
		 where tc.table_schema = ? and tc.table_name = ?
		   and tc.constraint_type in ('PRIMARY KEY', 'UNIQUE')
		 order by tc.constraint_type desc, tc.constraint_name, kcu.ordinal_position`),
		realSchema, table)
	if err != nil {
		return Structure{}, err
	}
	for rows.Next() {
		var kind, name, column string
		if err := rows.Scan(&kind, &name, &column); err != nil {
			rows.Close()
			return Structure{}, err
		}
		if kind == "PRIMARY KEY" {
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

	// Read key_column_usage for the referenced table, not
	// referential_constraints, which MariaDB nulls for a role lacking
	// privilege on it (same reason as ReferencedBy).
	rows, err = tx.QueryContext(qctx, timedSelect(variant, c.timeoutSec,
		`kcu.constraint_name, kcu.referenced_table_schema, kcu.referenced_table_name,
		        kcu.column_name, kcu.referenced_column_name, rc.delete_rule, rc.update_rule
		 from information_schema.key_column_usage kcu
		 join information_schema.referential_constraints rc
		   on rc.constraint_schema = kcu.constraint_schema
		  and rc.constraint_name = kcu.constraint_name
		  and rc.table_name = kcu.table_name
		 where kcu.table_schema = ? and kcu.table_name = ?
		   and kcu.referenced_table_name is not null
		 order by kcu.constraint_name, kcu.ordinal_position`), realSchema, table)
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
			OnDelete: strings.ToUpper(del), OnUpdate: strings.ToUpper(upd),
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

	// MySQL before 8.0.16 has no check_constraints view: report [].
	var hasChecks int64
	if err := tx.QueryRowContext(qctx, timedSelect(variant, c.timeoutSec,
		`count(*) from information_schema.tables
		 where table_schema = 'information_schema' and table_name = 'CHECK_CONSTRAINTS'`)).Scan(&hasChecks); err != nil {
		return Structure{}, err
	}
	if hasChecks > 0 {
		// MariaDB names unnamed table-level checks per table, so its view
		// carries table_name for the join; MySQL's has none.
		ccTable := ""
		if variant == variantMariaDB {
			ccTable = "and cc.table_name = tc.table_name "
		}
		rows, err = tx.QueryContext(qctx, timedSelect(variant, c.timeoutSec,
			`tc.constraint_name, cc.check_clause
			 from information_schema.table_constraints tc
			 join information_schema.check_constraints cc
			   on cc.constraint_schema = tc.constraint_schema
			  and cc.constraint_name = tc.constraint_name `+ccTable+`
			 where tc.table_schema = ? and tc.table_name = ?
			   and tc.constraint_type = 'CHECK'
			 order by tc.constraint_name`), realSchema, table)
		if err != nil {
			return Structure{}, err
		}
		defer rows.Close()
		for rows.Next() {
			var name string
			var clause sql.NullString
			if err := rows.Scan(&name, &clause); err != nil {
				return Structure{}, err
			}
			out.Constraints.Check = append(out.Constraints.Check, ConstraintCheck{Name: name, Expression: clause.String})
		}
		if err := rows.Err(); err != nil {
			return Structure{}, err
		}
		rows.Close()
	}
	if err := tx.Commit(); err != nil {
		return Structure{}, err
	}
	return out, nil
}

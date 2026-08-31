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
			return "", nil, &NotAllowedError{What: fmt.Sprintf("column %q", cond.Column)}
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
		return "", &NotAllowedError{What: fmt.Sprintf("schema %q", resolved)}
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
		return &NotAllowedError{What: fmt.Sprintf("table %q", table)}
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
		return TableData{}, &NotAllowedError{What: fmt.Sprintf("table %q", table)}
	}

	columnNames, err := c.allowedColumnsInTx(ctx, tx, variant, realSchema, realTable)
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
		return nil, &NotAllowedError{What: fmt.Sprintf("table %q", table)}
	}
	columns, err := c.allowedColumnsInTx(ctx, tx, variant, realSchema, realTable)
	if err != nil {
		return nil, err
	}
	if _, ok := findExact(columns, column); !ok {
		return nil, &NotAllowedError{What: fmt.Sprintf("column %q", column)}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	// MySQL has no portable common-value statistics (`spec/protocol.md` §5.5).
	return []CommonValueEntry{}, nil
}

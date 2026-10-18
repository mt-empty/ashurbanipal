package ashurbanipal

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"
)

// Bounds for GET /api/tables/join (spec/protocol.md §5.11.1).
const (
	MaxJoinBytes  = 8192
	MaxJoinTables = 4
	MaxJoinPairs  = 3
)

// BadJoinError is anything wrong with a join value (spec/protocol.md §5.11.1):
// its shape, an unknown table or column, an incompatible pair. The handler
// maps it to 400 invalid_join.
type BadJoinError struct {
	Reason string
}

func (e *BadJoinError) Error() string { return "invalid join: " + e.Reason }

func badJoin(format string, args ...interface{}) *BadJoinError {
	return &BadJoinError{Reason: fmt.Sprintf(format, args...)}
}

// BadParamError is a request parameter outside its allowed values; 400 invalid_parameter.
type BadParamError struct {
	Reason string
}

func (e *BadParamError) Error() string { return "invalid parameter: " + e.Reason }

// unknownJoinTable reports a table named in the join value as a bad join;
// not_readable stays as it is.
func unknownJoinTable(err error) error {
	var na *NotAllowedError
	if errors.As(err, &na) && na.Kind == NotAllowedTable {
		return badJoin("unknown %s", na.What)
	}
	return err
}

// ColumnPos names a column of the table at a position (0 is the base table).
type ColumnPos struct {
	Join   int
	Column string
}

type OnPair struct {
	Left  ColumnPos
	Right string
}

type JoinEntry struct {
	Left  bool // false is an inner join
	Table string
	On    []OnPair
}

// JoinSpec is the decoded join parameter. Positions: 0 is Table, 1.. the
// entries of Joins in order.
type JoinSpec struct {
	Table   string
	Joins   []JoinEntry
	Columns []ColumnPos // nil means every column of every table
}

// TableNames returns the table name at each position.
func (s JoinSpec) TableNames() []string {
	names := []string{s.Table}
	for _, j := range s.Joins {
		names = append(names, j.Table)
	}
	return names
}

type wireColumnPos struct {
	Join   *int    `json:"join"`
	Column *string `json:"column"`
}

type wireOnPair struct {
	Left  *wireColumnPos `json:"left"`
	Right *string        `json:"right"`
}

type wireJoinEntry struct {
	Type  *string      `json:"type"`
	Table *string      `json:"table"`
	On    []wireOnPair `json:"on"`
}

type wireJoinSpec struct {
	Table   *string          `json:"table"`
	Joins   []wireJoinEntry  `json:"joins"`
	Columns *[]wireColumnPos `json:"columns"`
}

func (w *wireColumnPos) toPos(what string) (ColumnPos, error) {
	if w == nil || w.Join == nil || w.Column == nil {
		return ColumnPos{}, badJoin("%s needs join and column", what)
	}
	if *w.Join < 0 {
		return ColumnPos{}, badJoin("%s: join position %d is negative", what, *w.Join)
	}
	return ColumnPos{Join: *w.Join, Column: *w.Column}, nil
}

// ParseJoin validates the join object's structure only; names and types are
// checked against the catalog by planJoin.
func ParseJoin(raw string) (JoinSpec, error) {
	if len(raw) > MaxJoinBytes {
		return JoinSpec{}, badJoin("join too long: %d bytes (max %d)", len(raw), MaxJoinBytes)
	}
	dec := json.NewDecoder(strings.NewReader(raw))
	dec.DisallowUnknownFields()
	var w wireJoinSpec
	if err := dec.Decode(&w); err != nil {
		return JoinSpec{}, badJoin("join must be a JSON object of the documented shape: %s", err)
	}
	if _, err := dec.Token(); err != io.EOF {
		return JoinSpec{}, badJoin("join must be a single JSON object")
	}
	if w.Table == nil {
		return JoinSpec{}, badJoin("join needs a table")
	}
	if len(w.Joins) == 0 {
		return JoinSpec{}, badJoin("join needs at least one entry in joins")
	}
	if len(w.Joins)+1 > MaxJoinTables {
		return JoinSpec{}, badJoin("too many tables: %d (max %d)", len(w.Joins)+1, MaxJoinTables)
	}
	spec := JoinSpec{Table: *w.Table}
	for i, e := range w.Joins {
		position := i + 1
		if e.Type == nil || e.Table == nil {
			return JoinSpec{}, badJoin("join %d needs type and table", position)
		}
		entry := JoinEntry{Table: *e.Table}
		switch *e.Type {
		case "inner":
		case "left":
			entry.Left = true
		default:
			return JoinSpec{}, badJoin("join %d: type must be \"inner\" or \"left\", got %q", position, *e.Type)
		}
		if len(e.On) == 0 || len(e.On) > MaxJoinPairs {
			return JoinSpec{}, badJoin("join %d: on needs 1 to %d pairs, got %d", position, MaxJoinPairs, len(e.On))
		}
		for _, p := range e.On {
			if p.Right == nil {
				return JoinSpec{}, badJoin("join %d: on pair needs left and right", position)
			}
			left, err := p.Left.toPos(fmt.Sprintf("join %d: on.left", position))
			if err != nil {
				return JoinSpec{}, err
			}
			if left.Join >= position {
				return JoinSpec{}, badJoin("join %d: on.left refers to position %d, which is not an earlier table", position, left.Join)
			}
			entry.On = append(entry.On, OnPair{Left: left, Right: *p.Right})
		}
		spec.Joins = append(spec.Joins, entry)
	}
	if w.Columns != nil {
		if len(*w.Columns) == 0 {
			return JoinSpec{}, badJoin("columns must not be empty when present")
		}
		seen := map[ColumnPos]bool{}
		for _, c := range *w.Columns {
			pos, err := c.toPos("columns")
			if err != nil {
				return JoinSpec{}, err
			}
			if seen[pos] {
				return JoinSpec{}, badJoin("columns lists (%d, %q) twice", pos.Join, pos.Column)
			}
			seen[pos] = true
			spec.Columns = append(spec.Columns, pos)
		}
	}
	return spec, nil
}

// typeClass is the comparison class of a column type (spec/protocol.md
// §5.11.2). id carries an enumerated type's identity.
type typeClass struct {
	kind string
	id   string
}

var (
	classNumber   = typeClass{kind: "number"}
	classText     = typeClass{kind: "text"}
	classUUID     = typeClass{kind: "uuid"}
	classBoolean  = typeClass{kind: "boolean"}
	classTemporal = typeClass{kind: "temporal"}
	classTime     = typeClass{kind: "time"}
	classBinary   = typeClass{kind: "binary"}
	// classUntyped is a SQLite column with no declared type; it pairs only
	// with itself.
	classUntyped = typeClass{kind: "untyped"}
)

func classEnum(id string) typeClass { return typeClass{kind: "enum", id: id} }

// joinColMeta is one column as the live catalog reports it.
type joinColMeta struct {
	name       string
	typeName   string
	class      *typeClass
	collation  *string // set where two text collations can clash (MySQL)
	key        KeyKind
	references *ColumnRef
	comment    string
}

type joinTableMeta struct {
	name    string
	columns []joinColMeta
}

func (t joinTableMeta) index(column string) (int, error) {
	for i, c := range t.columns {
		if c.name == column {
			return i, nil
		}
	}
	return 0, &NotAllowedError{Kind: NotAllowedColumn, What: fmt.Sprintf("column %q", column)}
}

// joinIndex is index for a name inside the join value, where a miss is a bad join.
func (t joinTableMeta) joinIndex(column string) (int, error) {
	i, err := t.index(column)
	if err != nil {
		return 0, badJoin("%s has no column %q", t.name, column)
	}
	return i, nil
}

// JoinColumnInfo is one response column of GET /api/tables/join.
type JoinColumnInfo struct {
	Name       string     `json:"name"`
	Type       string     `json:"type"`
	Join       int        `json:"join"`
	Table      string     `json:"table"`
	Column     string     `json:"column"`
	Key        KeyKind    `json:"key,omitempty"`
	References *ColumnRef `json:"references,omitempty"`
	Comment    string     `json:"comment,omitempty"`
}

// JoinData is the response body of GET /api/tables/join (§5.11.4).
type JoinData struct {
	Columns []JoinColumnInfo     `json:"columns"`
	Rows    []map[string]*string `json:"rows"`
	HasMore bool                 `json:"has_more"`
}

// JoinOpts parameterizes GET /api/tables/join besides the join object.
type JoinOpts struct {
	Limit      int64
	Offset     int64
	Sort       *string
	SortJoin   *int
	Descending bool
	Filter     []Condition
}

type resolvedCondition struct {
	cond Condition
	pos  int
	col  int
}

type joinOn struct{ leftPos, leftCol, rightCol int }

// joinPlan is a request resolved against the catalog. Everything that
// reaches SQL text in buildJoinSelect comes from tables, never the request.
type joinPlan struct {
	tables     []joinTableMeta
	left       []bool
	ons        [][]joinOn
	selection  [][2]int // (position, column index)
	labels     []string
	filter     []resolvedCondition
	sort       *[2]int
	descending bool
}

func describeCol(t joinTableMeta, c joinColMeta) string {
	return fmt.Sprintf("%s.%s (%s)", t.name, c.name, c.typeName)
}

var floatTypeRe = regexp.MustCompile(`(?i)real|float|double`)

func unjoinable(position int, t joinTableMeta, c joinColMeta) error {
	why := ""
	if floatTypeRe.MatchString(c.typeName) {
		why = ": floating-point values are not compared exactly"
	}
	return badJoin("join %d on: %s cannot be used in a join%s", position, describeCol(t, c), why)
}

func checkJoinPair(position int, lt joinTableMeta, lc joinColMeta, rt joinTableMeta, rc joinColMeta) error {
	if lc.class == nil {
		return unjoinable(position, lt, lc)
	}
	if rc.class == nil {
		return unjoinable(position, rt, rc)
	}
	if *lc.class != *rc.class {
		return badJoin("join %d on: %s cannot be joined to %s", position, describeCol(lt, lc), describeCol(rt, rc))
	}
	if *lc.class == classText && lc.collation != nil && rc.collation != nil && *lc.collation != *rc.collation {
		return badJoin("join %d on: %s and %s use different text collations (%s and %s)",
			position, describeCol(lt, lc), describeCol(rt, rc), *lc.collation, *rc.collation)
	}
	return nil
}

// assignJoinLabels: a column keeps its own name when that is unique among
// the returned columns, otherwise it becomes name_join; a numeric suffix
// breaks any remaining tie.
func assignJoinLabels(names []string, joins []int) []string {
	counts := map[string]int{}
	for _, n := range names {
		counts[n]++
	}
	used := map[string]bool{}
	for _, n := range names {
		if counts[n] == 1 {
			used[n] = true
		}
	}
	labels := make([]string, len(names))
	for i, n := range names {
		if counts[n] == 1 {
			labels[i] = n
			continue
		}
		base := fmt.Sprintf("%s_%d", n, joins[i])
		label := base
		for k := 2; used[label]; k++ {
			label = fmt.Sprintf("%s_%d", base, k)
		}
		used[label] = true
		labels[i] = label
	}
	return labels
}

// planJoin resolves a request against the catalog; tables[i] is the
// metadata of position i.
func planJoin(spec JoinSpec, tables []joinTableMeta, opts JoinOpts) (*joinPlan, error) {
	p := &joinPlan{tables: tables, descending: opts.Descending}
	for i, entry := range spec.Joins {
		position := i + 1
		p.left = append(p.left, entry.Left)
		var ons []joinOn
		for _, pair := range entry.On {
			lt := tables[pair.Left.Join]
			lc, err := lt.joinIndex(pair.Left.Column)
			if err != nil {
				return nil, err
			}
			rc, err := tables[position].joinIndex(pair.Right)
			if err != nil {
				return nil, err
			}
			if err := checkJoinPair(position, lt, lt.columns[lc], tables[position], tables[position].columns[rc]); err != nil {
				return nil, err
			}
			ons = append(ons, joinOn{leftPos: pair.Left.Join, leftCol: lc, rightCol: rc})
		}
		p.ons = append(p.ons, ons)
	}

	if spec.Columns != nil {
		for _, c := range spec.Columns {
			if c.Join >= len(tables) {
				return nil, badJoin("columns: position %d is not in the join", c.Join)
			}
			idx, err := tables[c.Join].joinIndex(c.Column)
			if err != nil {
				return nil, err
			}
			p.selection = append(p.selection, [2]int{c.Join, idx})
		}
	} else {
		for pos, t := range tables {
			for col := range t.columns {
				p.selection = append(p.selection, [2]int{pos, col})
			}
		}
	}
	names := make([]string, len(p.selection))
	joins := make([]int, len(p.selection))
	for i, s := range p.selection {
		names[i] = tables[s[0]].columns[s[1]].name
		joins[i] = s[0]
	}
	p.labels = assignJoinLabels(names, joins)

	for i, c := range opts.Filter {
		pos := 0
		if c.Join != nil {
			pos = *c.Join
		}
		if pos < 0 || pos >= len(tables) {
			return nil, filterErr("condition %d: join position %d is not in the join", i, pos)
		}
		if !validOps[c.Op] {
			return nil, filterErr("condition %d has invalid op %q", i, c.Op)
		}
		if opTakesValue(c.Op) != (c.Value != nil) {
			return nil, filterErr("condition %d: op %q has the wrong value arity", i, c.Op)
		}
		col, err := tables[pos].index(c.Column)
		if err != nil {
			return nil, err
		}
		p.filter = append(p.filter, resolvedCondition{cond: c, pos: pos, col: col})
	}

	switch {
	case opts.Sort == nil && opts.SortJoin != nil:
		return nil, &BadParamError{Reason: "sort_join needs sort"}
	case opts.Sort != nil:
		pos := 0
		if opts.SortJoin != nil {
			pos = *opts.SortJoin
		}
		if pos < 0 || pos >= len(tables) {
			return nil, &BadParamError{Reason: fmt.Sprintf("sort_join: position %d is not in the join", pos)}
		}
		idx, err := tables[pos].index(*opts.Sort)
		if err != nil {
			return nil, err
		}
		p.sort = &[2]int{pos, idx}
	}
	return p, nil
}

type ilikeStyle int

const (
	ilikeNative ilikeStyle = iota
	ilikeLike
	ilikeLoweredLike
)

// joinDialect is how a backend spells the pieces that differ between engines.
type joinDialect struct {
	quote    func(string) string
	castText func(string) string
	numbered bool // $n placeholders (Postgres) instead of ?
	ilike    ilikeStyle
}

// buildJoinSelect renders "<select list> from … limit … offset …" (no
// leading select, so MySQL can wrap it in its timeout hint) and the filter
// values in placeholder order. Numbered dialects reserve $1/$2 for limit and
// offset; others bind filter values first, then limit, then offset.
func buildJoinSelect(p *joinPlan, d joinDialect, schema *string) (string, []string) {
	alias := func(pos, col int) string {
		return fmt.Sprintf("t%d.%s", pos, d.quote(p.tables[pos].columns[col].name))
	}
	parts := make([]string, len(p.selection))
	for i, s := range p.selection {
		parts[i] = fmt.Sprintf("%s as c%d", d.castText(alias(s[0], s[1])), i)
	}
	fromItem := func(pos int) string {
		name := d.quote(p.tables[pos].name)
		if schema != nil {
			return fmt.Sprintf("%s.%s t%d", d.quote(*schema), name, pos)
		}
		return fmt.Sprintf("%s t%d", name, pos)
	}
	var sb strings.Builder
	sb.WriteString(strings.Join(parts, ", "))
	sb.WriteString(" from " + fromItem(0))
	for i, left := range p.left {
		position := i + 1
		kind := "inner join"
		if left {
			kind = "left join"
		}
		conds := make([]string, len(p.ons[i]))
		for k, on := range p.ons[i] {
			conds[k] = fmt.Sprintf("%s = %s", alias(position, on.rightCol), alias(on.leftPos, on.leftCol))
		}
		sb.WriteString(fmt.Sprintf(" %s %s on %s", kind, fromItem(position), strings.Join(conds, " and ")))
	}

	var values []string
	next := 3
	placeholder := func() string {
		if d.numbered {
			s := fmt.Sprintf("$%d", next)
			next++
			return s
		}
		return "?"
	}
	var clause strings.Builder
	for i, rc := range p.filter {
		c := rc.cond
		cast := d.castText(alias(rc.pos, rc.col))
		var inner string
		switch {
		case !opTakesValue(c.Op):
			inner = fmt.Sprintf("%s %s", cast, opSQL(c.Op))
		case c.Op == "ILIKE":
			values = append(values, *c.Value)
			switch d.ilike {
			case ilikeNative:
				inner = fmt.Sprintf("%s ILIKE %s", cast, placeholder())
			case ilikeLike:
				inner = fmt.Sprintf("%s LIKE %s", cast, placeholder())
			default:
				inner = fmt.Sprintf("LOWER(%s) LIKE LOWER(%s)", cast, placeholder())
			}
		default:
			values = append(values, *c.Value)
			inner = fmt.Sprintf("%s %s %s", cast, opSQL(c.Op), placeholder())
		}
		if i > 0 {
			if c.Logic != nil && *c.Logic == "OR" {
				clause.WriteString(" OR ")
			} else {
				clause.WriteString(" AND ")
			}
		}
		if c.Not {
			clause.WriteString("(NOT (" + inner + "))")
		} else {
			clause.WriteString("(" + inner + ")")
		}
	}
	if clause.Len() > 0 {
		sb.WriteString(" where " + clause.String())
	}
	if p.sort != nil {
		dir := "asc"
		if p.descending {
			dir = "desc"
		}
		sb.WriteString(fmt.Sprintf(" order by %s %s", alias(p.sort[0], p.sort[1]), dir))
	}
	if d.numbered {
		sb.WriteString(" limit $1 offset $2")
	} else {
		sb.WriteString(" limit ? offset ?")
	}
	return sb.String(), values
}

func (p *joinPlan) columnInfos() []JoinColumnInfo {
	out := make([]JoinColumnInfo, len(p.selection))
	for i, s := range p.selection {
		t := p.tables[s[0]]
		c := t.columns[s[1]]
		out[i] = JoinColumnInfo{
			Name: p.labels[i], Type: c.typeName, Join: s[0], Table: t.name, Column: c.name,
			Key: c.key, References: c.references, Comment: c.comment,
		}
	}
	return out
}

// scanJoinRows reads up to limit rows keyed by label and reports whether a
// further row exists (the query asked for limit+1).
func scanJoinRows(rows interface {
	Next() bool
	Scan(...interface{}) error
	Err() error
}, labels []string, limit int64) ([]map[string]*string, bool, error) {
	out := []map[string]*string{}
	hasMore := false
	for rows.Next() {
		if int64(len(out)) >= limit {
			hasMore = true
			break
		}
		cells := make([]interface{}, len(labels))
		values := make([]cellValue, len(labels))
		for i := range values {
			cells[i] = &values[i]
		}
		if err := rows.Scan(cells...); err != nil {
			return nil, false, err
		}
		row := make(map[string]*string, len(labels))
		for i, label := range labels {
			row[label] = values[i].asJSON()
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		return nil, false, err
	}
	return out, hasMore, nil
}

// joinKeyOf merges PK/FK metadata onto a column.
func joinKeyOf(name string, pk map[string]bool, fk map[string]ColumnRef) (KeyKind, *ColumnRef) {
	var ref *ColumnRef
	if r, ok := fk[name]; ok {
		ref = &r
	}
	switch {
	case pk[name]:
		return KeyPK, ref
	case ref != nil:
		return KeyFK, ref
	}
	return "", nil
}

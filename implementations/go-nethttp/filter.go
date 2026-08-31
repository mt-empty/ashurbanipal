package ashurbanipal

import (
	"encoding/json"
	"fmt"
	"strings"
)

// MaxFilterBytes bounds the URL-decoded filter JSON (spec/protocol.md §5.4.2).
const MaxFilterBytes = 8192

// MaxConditions caps conditions per request (spec/protocol.md §5.4.2).
const MaxConditions = 10

// Wire operators must come from this allow-list before reaching SQL (spec/protocol.md §5.4.2).
var validOps = map[string]bool{
	"=": true, "!=": true, ">": true, "<": true, ">=": true, "<=": true,
	"LIKE": true, "ILIKE": true, "IS NULL": true, "IS NOT NULL": true,
}

func opTakesValue(op string) bool {
	return op != "IS NULL" && op != "IS NOT NULL"
}

// Condition holds untrusted filter input; BuildWhereClause validates Column
// against the live schema before SQL (spec/protocol.md §5.4.2).
type Condition struct {
	Logic  *string `json:"logic,omitempty"`
	Not    bool    `json:"not,omitempty"`
	Column string  `json:"column"`
	Op     string  `json:"op"`
	Value  *string `json:"value,omitempty"`
}

type FilterError struct {
	Reason string
}

func (e *FilterError) Error() string { return "invalid filter: " + e.Reason }

func filterErr(format string, args ...interface{}) *FilterError {
	return &FilterError{Reason: fmt.Sprintf(format, args...)}
}

// ParseFilter validates the JSON AST (spec/protocol.md §5.4.2); the frontend
// parses DSL text (spec/filter-dsl.md).
func ParseFilter(raw string) ([]Condition, error) {
	if len(raw) > MaxFilterBytes {
		return nil, filterErr("filter too long: %d bytes (max %d)", len(raw), MaxFilterBytes)
	}

	decoder := json.NewDecoder(strings.NewReader(raw))
	decoder.DisallowUnknownFields()
	var conditions []Condition
	if err := decoder.Decode(&conditions); err != nil {
		return nil, filterErr("filter must be a JSON array of conditions: %s", err)
	}
	if decoder.More() {
		return nil, filterErr("filter must be a single JSON array of conditions")
	}

	if len(conditions) > MaxConditions {
		return nil, filterErr("too many conditions: %d (max %d)", len(conditions), MaxConditions)
	}

	for i, cond := range conditions {
		if i == 0 && cond.Logic != nil {
			return nil, filterErr("logic must be absent on the first condition")
		}
		if i > 0 && cond.Logic == nil {
			return nil, filterErr("condition %d is missing logic (\"AND\" or \"OR\")", i)
		}
		if cond.Logic != nil && *cond.Logic != "AND" && *cond.Logic != "OR" {
			return nil, filterErr("condition %d has invalid logic %q", i, *cond.Logic)
		}
		if !validOps[cond.Op] {
			return nil, filterErr("condition %d has invalid op %q", i, cond.Op)
		}
		takesValue := opTakesValue(cond.Op)
		if takesValue && cond.Value == nil {
			return nil, filterErr("op %q requires a value", cond.Op)
		}
		if !takesValue && cond.Value != nil {
			return nil, filterErr("op %q takes no value", cond.Op)
		}
	}
	return conditions, nil
}

// opSQL returns a literal allow-listed SQL fragment, never wire text (spec/protocol.md §5.4.2).
func opSQL(op string) string {
	switch op {
	case "=":
		return "="
	case "!=":
		return "!="
	case ">":
		return ">"
	case "<":
		return "<"
	case ">=":
		return ">="
	case "<=":
		return "<="
	case "LIKE":
		return "LIKE"
	case "ILIKE":
		return "ILIKE"
	case "IS NULL":
		return "IS NULL"
	case "IS NOT NULL":
		return "IS NOT NULL"
	default:
		panic("opSQL called with an op BuildWhereClause's validOps check should have rejected: " + op)
	}
}

// BuildWhereClause renders conditions into a " where ..." SQL fragment
// with $N placeholders (numbered from $3: $1/$2 are reserved for
// limit/offset by QueryTable's caller) and the ordered bind values. Every
// column is matched against columnNames (the live information_schema
// allow-list) before being spliced in — the same discipline `sort` gets
// (spec/protocol.md §6). Conditions are joined by their own logic tokens,
// relying on SQL's native AND-tighter-than-OR precedence; there is no
// grouping/nesting in the AST.
func BuildWhereClause(conditions []Condition, columnNames []string) (string, []string, error) {
	if len(conditions) == 0 {
		return "", nil, nil
	}

	allowed := make(map[string]bool, len(columnNames))
	for _, c := range columnNames {
		allowed[c] = true
	}

	var values []string
	var clause strings.Builder
	nextParam := 3
	for i, cond := range conditions {
		if !allowed[cond.Column] {
			return "", nil, &NotAllowedError{What: fmt.Sprintf("column %q", cond.Column)}
		}
		// Defense in depth: BuildWhereClause is exported, so a future
		// caller could feed it conditions straight from JSON without
		// going through ParseFilter first — re-checking here is what
		// makes opSQL's hardcoded table load-bearing, not decorative
		// (PORTING.md hardening item 6).
		if !validOps[cond.Op] {
			return "", nil, filterErr("condition %d has invalid op %q", i, cond.Op)
		}

		quotedColumn := quoteIdent(cond.Column)
		var inner string
		if opTakesValue(cond.Op) {
			if cond.Value == nil {
				return "", nil, filterErr("op %q requires a value", cond.Op)
			}
			inner = fmt.Sprintf("%s::text %s $%d", quotedColumn, opSQL(cond.Op), nextParam)
			values = append(values, *cond.Value)
			nextParam++
		} else {
			inner = fmt.Sprintf("%s::text %s", quotedColumn, opSQL(cond.Op))
		}

		var wrapped string
		if cond.Not {
			wrapped = "(NOT (" + inner + "))"
		} else {
			wrapped = "(" + inner + ")"
		}

		if i > 0 {
			if cond.Logic == nil {
				return "", nil, filterErr("condition %d is missing logic", i)
			}
			if *cond.Logic == "OR" {
				clause.WriteString(" OR ")
			} else {
				clause.WriteString(" AND ")
			}
		}
		clause.WriteString(wrapped)
	}
	return " where " + clause.String(), values, nil
}

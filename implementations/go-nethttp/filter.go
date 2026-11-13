package ashurbanipal

import (
	"bytes"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"
)

// MaxFilterBytes bounds the URL-decoded filter JSON (spec/protocol.md §5.4.2).
const MaxFilterBytes = 8192

// MaxConditions caps conditions per request (spec/protocol.md §5.4.2).
const MaxConditions = 10

// MaxInItems caps an IN list (spec/protocol.md §5.4.2).
const MaxInItems = 1000

// Wire operators must come from this allow-list before reaching SQL (spec/protocol.md §5.4.2).
var validOps = map[string]bool{
	"=": true, "!=": true, ">": true, "<": true, ">=": true, "<=": true,
	"LIKE": true, "ILIKE": true, "IN": true, "BETWEEN": true, "IS NULL": true, "IS NOT NULL": true,
}

func opTakesValue(op string) bool {
	return op != "IS NULL" && op != "IS NOT NULL"
}

// opIsPattern: LIKE/ILIKE always compare the text cast, whatever the column's class.
func opIsPattern(op string) bool {
	return op == "LIKE" || op == "ILIKE"
}

// FilterValue is a condition's value: a JSON string for most ops, an array
// of strings for IN and BETWEEN.
type FilterValue struct {
	Items []string
	List  bool
}

// StringValue is the single-string value of a non-list op.
func StringValue(v string) *FilterValue { return &FilterValue{Items: []string{v}} }

func (v *FilterValue) UnmarshalJSON(b []byte) error {
	if t := bytes.TrimLeft(b, " \t\r\n"); len(t) > 0 && t[0] == '[' {
		// Pointers, so a null item decodes to nil instead of "".
		var raw []*string
		if err := json.Unmarshal(b, &raw); err != nil {
			return err
		}
		items := make([]string, len(raw))
		for i, r := range raw {
			if r == nil {
				return fmt.Errorf("list item %d is not a string", i)
			}
			items[i] = *r
		}
		*v = FilterValue{Items: items, List: true}
		return nil
	}
	var one string
	if err := json.Unmarshal(b, &one); err != nil {
		return err
	}
	*v = FilterValue{Items: []string{one}}
	return nil
}

func (v FilterValue) MarshalJSON() ([]byte, error) {
	if v.List {
		return json.Marshal(v.Items)
	}
	return json.Marshal(v.Items[0])
}

// checkValueShape checks a value against its op (spec/protocol.md §5.4.2).
func checkValueShape(i int, op string, v *FilterValue) error {
	switch {
	case !opTakesValue(op) && v != nil:
		return filterErr("condition %d: op %q takes no value", i, op)
	case !opTakesValue(op):
		return nil
	case v == nil:
		return filterErr("condition %d: op %q requires a value", i, op)
	case op == "IN":
		if !v.List || len(v.Items) < 1 || len(v.Items) > MaxInItems {
			return filterErr("condition %d: op \"IN\" needs an array of 1 to %d strings", i, MaxInItems)
		}
	case op == "BETWEEN":
		if !v.List || len(v.Items) != 2 {
			return filterErr("condition %d: op \"BETWEEN\" needs an array of two strings, [low, high]", i)
		}
	case v.List:
		return filterErr("condition %d: op %q needs a string value", i, op)
	}
	return nil
}

// Condition holds untrusted filter input; tableWhereClause validates Column
// against the live schema before SQL (spec/protocol.md §5.4.2).
type Condition struct {
	Logic  *string      `json:"logic,omitempty"`
	Not    bool         `json:"not,omitempty"`
	Column string       `json:"column"`
	Op     string       `json:"op"`
	Value  *FilterValue `json:"value,omitempty"`
	// Join is a table position, accepted only by ParseFilterForJoin
	// (spec/protocol.md §5.11.3).
	Join *int `json:"join,omitempty"`
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
	return parseFilter(raw, false)
}

// ParseFilterForJoin is ParseFilter for GET /api/tables/join: a condition
// may carry a join table position.
func ParseFilterForJoin(raw string) ([]Condition, error) {
	return parseFilter(raw, true)
}

var conditionKeys = keyShape{"logic": nil, "not": nil, "column": nil, "op": nil, "value": nil, "join": nil}

func parseFilter(raw string, allowJoin bool) ([]Condition, error) {
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
	if err := checkKeys(raw, conditionKeys); err != nil {
		return nil, filterErr("filter must be a JSON array of conditions: %s", err)
	}

	if len(conditions) > MaxConditions {
		return nil, filterErr("too many conditions: %d (max %d)", len(conditions), MaxConditions)
	}

	for i, cond := range conditions {
		if cond.Join != nil && !allowJoin {
			return nil, filterErr("join is only valid on the join route")
		}
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
		if err := checkValueShape(i, cond.Op, cond.Value); err != nil {
			return nil, err
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
		panic("opSQL called with an op the validOps check should have rejected: " + op)
	}
}

// valueForm is the form a value compared in its column's own type must have
// (spec/protocol.md §5.4.2).
type valueForm int

const (
	formNone valueForm = iota // not checked: SQLite does not enforce column types
	formNumber
	formFloat
	formDate
	formTimestamp
	formTimestampTz // may end in a time-zone offset (Postgres timestamptz)
	formTime
	formTimeTz // may end in a time-zone offset (Postgres timetz)
)

var (
	numberRe    = regexp.MustCompile(`^[+-]?[0-9]{1,35}(\.[0-9]{1,30})?$`)
	floatRe     = regexp.MustCompile(`^[+-]?[0-9]{1,35}(\.[0-9]{1,30})?([eE][+-]?[0-9]{1,3})?$`)
	timeRe      = regexp.MustCompile(`^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9](\.[0-9]{1,6})?)?$`)
	timeTzRe    = regexp.MustCompile(`^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9](\.[0-9]{1,6})?)?(Z|[+-][0-9]{2}([0-9]{2}|:[0-9]{2}(:[0-9]{2})?)?)?$`)
	dateRe      = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}$`)
	timestampRe = regexp.MustCompile(`^([0-9]{4}-[0-9]{2}-[0-9]{2})([ T](.*))?$`)
)

// realDate reports whether a YYYY-MM-DD string names a day in years 0001-9999.
func realDate(s string) bool {
	if !dateRe.MatchString(s) || s[:4] == "0000" {
		return false
	}
	_, err := time.Parse("2006-01-02", s)
	return err == nil
}

func (f valueForm) accepts(v string) bool {
	switch f {
	case formNone:
		return true
	case formNumber:
		return numberRe.MatchString(v)
	case formFloat:
		return floatRe.MatchString(v)
	case formDate:
		return realDate(v)
	case formTimestamp, formTimestampTz:
		tr := timeRe
		if f == formTimestampTz {
			tr = timeTzRe
		}
		m := timestampRe.FindStringSubmatch(v)
		return m != nil && realDate(m[1]) && (m[2] == "" || tr.MatchString(m[3]))
	case formTimeTz:
		return timeTzRe.MatchString(v)
	default:
		return timeRe.MatchString(v)
	}
}

// describe names the expected form in an error title.
func (f valueForm) describe() string {
	switch f {
	case formNumber:
		return "a decimal number such as -12 or 0.5"
	case formFloat:
		return "a number such as 0.5 or 1.5e-3"
	case formDate:
		return "a date such as 2016-01-31"
	case formTimestamp:
		return "a date such as 2016-01-31, optionally with a time such as 10:30:00"
	case formTimestampTz:
		return "a date such as 2016-01-31, optionally with a time such as 10:30:00 and an offset such as +02:00"
	case formTimeTz:
		return "a time such as 10:30, optionally with an offset such as +02:00"
	default:
		return "a time such as 10:30 or 10:30:00.5"
	}
}

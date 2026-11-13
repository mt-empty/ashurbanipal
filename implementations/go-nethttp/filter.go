package ashurbanipal

import (
	"bytes"
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
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

// isBadValueSQLState reports whether an engine's SQLSTATE names a bad value,
// which in a filtered query is the filter's (spec/protocol.md §5.4.2).
func isBadValueSQLState(code string) bool {
	switch code {
	case "22P02", "22003", "22007", "22008", "22021", "22P05":
		return true
	}
	return false
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
	case "IN":
		return "IN"
	case "BETWEEN":
		return "BETWEEN"
	case "IS NULL":
		return "IS NULL"
	case "IS NOT NULL":
		return "IS NOT NULL"
	default:
		panic("opSQL called with an op the validOps check should have rejected: " + op)
	}
}

// valueForm is the form a value compared in its column's own type must have
// (spec/protocol.md §5.4.2): the common form, widened to every value the
// engine stores and renders for that type, so a cell's own text always
// filters back to its row.
type valueForm int

const (
	formNone         valueForm = iota // not checked: SQLite does not enforce column types
	formMysqlDecimal                  // at most 35 integer and 30 fraction digits: the DECIMAL(65,30) cast's bound
	formMysqlFloat
	formMysqlDate // years 0001-9999, or the zero date 0000-00-00
	formMysqlDatetime
	formMysqlTime // hours up to ±838
	formPgNumeric // any number of digits, NaN or ±Infinity
	formPgFloat
	formPgDate // years from 0001 with an optional " BC", above 9999, or ±infinity
	formPgTimestamp
	formPgTimestampTz // may carry a time-zone offset
	formPgTime        // hours 00-23, or exactly 24:00
	formPgTimeTz
)

const (
	clockTail = `:[0-5][0-9](:[0-5][0-9](\.[0-9]{1,6})?)?`
	pgClock   = `(([01][0-9]|2[0-3])` + clockTail + `|24:00(:00(\.0{1,6})?)?)`
	tzOffset  = `(Z|[+-][0-9]{2}([0-9]{2}|:[0-9]{2}(:[0-9]{2})?)?)?`
)

var (
	mysqlDecimalRe    = regexp.MustCompile(`^[+-]?[0-9]{1,35}(\.[0-9]{1,30})?$`)
	mysqlFloatRe      = regexp.MustCompile(`^[+-]?[0-9]{1,35}(\.[0-9]{1,30})?([eE][+-]?[0-9]{1,3})?$`)
	mysqlTimeRe       = regexp.MustCompile(`^-?([0-9]{2,3})` + clockTail + `$`)
	pgNumericRe       = regexp.MustCompile(`^[+-]?[0-9]+(\.[0-9]+)?$`)
	pgFloatRe         = regexp.MustCompile(`^[+-]?[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]{1,3})?$`)
	pgSpecialNumberRe = regexp.MustCompile(`(?i)^(nan|[+-]?infinity)$`)
	pgInfinityRe      = regexp.MustCompile(`(?i)^-?infinity$`)
	timeRe            = regexp.MustCompile(`^([01][0-9]|2[0-3])` + clockTail + `$`)
	pgTimeRe          = regexp.MustCompile(`^` + pgClock + `$`)
	pgTimeTzRe        = regexp.MustCompile(`^` + pgClock + tzOffset + `$`)
	dateRe            = regexp.MustCompile(`^([0-9]{4,7})-([0-9]{2})-([0-9]{2})$`)
)

// calendarDate reports whether s is a real YYYY-MM-DD date from year 0001;
// wideYears allows up to 7 year digits. A bc year counts back from 1 BC,
// which is a leap year.
func calendarDate(s string, wideYears, bc bool) bool {
	m := dateRe.FindStringSubmatch(s)
	if m == nil || (!wideYears && len(m[1]) != 4) {
		return false
	}
	y, _ := strconv.Atoi(m[1])
	month, _ := strconv.Atoi(m[2])
	day, _ := strconv.Atoi(m[3])
	if y < 1 {
		return false
	}
	leapYear := y
	if bc {
		leapYear = y - 1
	}
	days := [13]int{0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31}
	if leapYear%4 == 0 && (leapYear%100 != 0 || leapYear%400 == 0) {
		days[2] = 29
	}
	return month >= 1 && month <= 12 && day >= 1 && day <= days[month]
}

func mysqlDate(s string) bool { return s == "0000-00-00" || calendarDate(s, false, false) }

// timestampOf: a date accepted by dateOK, optionally followed by a space or
// T and a time accepted by timeOK.
func timestampOf(v string, dateOK, timeOK func(string) bool) bool {
	if i := strings.IndexAny(v, " T"); i >= 0 {
		return dateOK(v[:i]) && timeOK(v[i+1:])
	}
	return dateOK(v)
}

// pgDateBC calls f with v minus a trailing " BC", and whether it had one.
func pgDateBC(v string, f func(string, bool) bool) bool {
	if rest, ok := strings.CutSuffix(v, " BC"); ok {
		return f(rest, true)
	}
	return f(v, false)
}

func mysqlTime(v string) bool {
	m := mysqlTimeRe.FindStringSubmatch(v)
	if m == nil {
		return false
	}
	h, _ := strconv.Atoi(m[1])
	return h <= 838
}

func (f valueForm) accepts(v string) bool {
	pgDate := func(d string, bc bool) bool { return calendarDate(d, true, bc) }
	switch f {
	case formNone:
		return true
	case formMysqlDecimal:
		return mysqlDecimalRe.MatchString(v)
	case formMysqlFloat:
		return mysqlFloatRe.MatchString(v)
	case formMysqlDate:
		return mysqlDate(v)
	case formMysqlDatetime:
		return timestampOf(v, mysqlDate, timeRe.MatchString)
	case formMysqlTime:
		return mysqlTime(v)
	case formPgNumeric:
		return pgSpecialNumberRe.MatchString(v) || pgNumericRe.MatchString(v)
	case formPgFloat:
		return pgSpecialNumberRe.MatchString(v) || pgFloatRe.MatchString(v)
	case formPgDate:
		return pgInfinityRe.MatchString(v) || pgDateBC(v, pgDate)
	case formPgTimestamp, formPgTimestampTz:
		timeOK := pgTimeRe.MatchString
		if f == formPgTimestampTz {
			timeOK = pgTimeTzRe.MatchString
		}
		return pgInfinityRe.MatchString(v) || pgDateBC(v, func(t string, bc bool) bool {
			return timestampOf(t, func(d string) bool { return pgDate(d, bc) }, timeOK)
		})
	case formPgTime:
		return pgTimeRe.MatchString(v)
	case formPgTimeTz:
		return pgTimeTzRe.MatchString(v)
	}
	return false
}

// describe names the expected form in an error title.
func (f valueForm) describe() string {
	switch f {
	case formMysqlDecimal:
		return "a decimal number such as -12 or 0.5"
	case formMysqlFloat:
		return "a number such as 0.5 or 1.5e-3"
	case formMysqlDate:
		return "a date such as 2016-01-31"
	case formMysqlDatetime, formPgTimestamp:
		return "a date such as 2016-01-31, optionally with a time such as 10:30:00"
	case formMysqlTime:
		return "a time such as 10:30 or -100:00:00"
	case formPgNumeric:
		return "a decimal number such as -12, 0.5 or NaN"
	case formPgFloat:
		return "a number such as 0.5, 1.5e-3 or Infinity"
	case formPgDate:
		return "a date such as 2016-01-31, 0044-03-15 BC or infinity"
	case formPgTimestampTz:
		return "a date such as 2016-01-31, optionally with a time such as 10:30:00 and an offset such as +02:00"
	case formPgTimeTz:
		return "a time such as 10:30, optionally with an offset such as +02:00"
	default:
		return "a time such as 10:30 or 10:30:00.5"
	}
}

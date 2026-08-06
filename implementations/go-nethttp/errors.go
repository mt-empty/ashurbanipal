package ashurbanipal

import "strings"

// quoteIdent escapes an identifier for splicing into SQL text by doubling
// embedded `"` (the standard Postgres quoted-identifier escape), not
// fmt's %q: %q applies Go string-literal escaping (backslash-escapes an
// embedded `"`), but Postgres's scheme diverges on that exact input.
// Callers must only pass a value already exact-matched against a live
// schema-catalog lookup (spec/protocol.md §6); this function does no
// validation of its own, it only makes an already-validated name
// syntactically safe to splice.
func quoteIdent(s string) string {
	return "\"" + strings.ReplaceAll(s, "\"", "\"\"") + "\""
}

// NotAllowedError means a table/column/sort name did not match the live
// schema allow-list (spec/protocol.md §6: no unvalidated identifier ever
// reaches SQL text). The HTTP handler maps this to 400.
type NotAllowedError struct {
	What string
}

func (e *NotAllowedError) Error() string { return "not allowed: " + e.What }

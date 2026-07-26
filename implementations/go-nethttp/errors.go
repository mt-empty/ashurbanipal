package ashurbanipal

// quoteIdent double-quotes a SQL identifier by plain concatenation, not
// fmt's %q: %q applies Go string-literal escaping (backslash-escapes an
// embedded `"`), but Postgres quoted-identifier escaping doubles it
// instead — the two schemes diverge on the exact input this guards
// against. Callers must only pass a value already exact-matched against a
// live schema-catalog lookup (spec/protocol.md §6); this function does no
// validation of its own.
func quoteIdent(s string) string {
	return "\"" + s + "\""
}

// NotAllowedError means a table/column/sort name did not match the live
// schema allow-list (spec/protocol.md §6: no unvalidated identifier ever
// reaches SQL text). The HTTP handler maps this to 400.
type NotAllowedError struct {
	What string
}

func (e *NotAllowedError) Error() string { return "not allowed: " + e.What }

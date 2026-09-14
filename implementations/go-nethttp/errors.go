package ashurbanipal

import (
	"fmt"
	"strings"
)

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

// NotAllowedKind identifies which allow-list (or privilege check) rejected
// a request — maps 1:1 onto spec/protocol.md §2's unknown_source/
// unknown_schema/unknown_table/unknown_column/not_readable error codes.
type NotAllowedKind int

const (
	NotAllowedSource NotAllowedKind = iota
	NotAllowedSchema
	NotAllowedTable
	NotAllowedColumn
	// NotAllowedNotReadable: cleared the allow-list but the connected role
	// can't actually SELECT it (Postgres 42501, MySQL/MariaDB residual 1142).
	NotAllowedNotReadable
)

// Code returns the spec/protocol.md §2 machine-readable error code for this kind.
func (k NotAllowedKind) Code() string {
	switch k {
	case NotAllowedSource:
		return "unknown_source"
	case NotAllowedSchema:
		return "unknown_schema"
	case NotAllowedTable:
		return "unknown_table"
	case NotAllowedColumn:
		return "unknown_column"
	case NotAllowedNotReadable:
		return "not_readable"
	default:
		panic(fmt.Sprintf("NotAllowedKind.Code called with unhandled kind %d", k))
	}
}

// NotAllowedError means a table/column/sort/schema/source name did not
// match the live schema allow-list, or (Kind == NotAllowedNotReadable)
// cleared it but the role can't actually SELECT it (spec/protocol.md §6: no
// unvalidated identifier ever reaches SQL text). The HTTP handler maps this
// to 400.
type NotAllowedError struct {
	Kind NotAllowedKind
	What string
}

func (e *NotAllowedError) Error() string { return "not allowed: " + e.What }

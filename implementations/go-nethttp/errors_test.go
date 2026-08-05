package ashurbanipal

import "testing"

func TestQuoteIdentDoublesEmbeddedQuotes(t *testing.T) {
	cases := map[string]string{
		"users":                    `"users"`,
		`foo"bar`:                  `"foo""bar"`,
		`a"; drop table users; --`: `"a""; drop table users; --"`,
	}
	for in, want := range cases {
		if got := quoteIdent(in); got != want {
			t.Errorf("quoteIdent(%q) = %q, want %q", in, got, want)
		}
	}
}

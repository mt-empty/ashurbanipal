package ashurbanipal

import "testing"

func TestAcceptsGzip(t *testing.T) {
	cases := []struct {
		headers []string
		want    bool
	}{
		{nil, false},
		{[]string{""}, false},
		{[]string{"gzip"}, true},
		{[]string{"GZIP"}, true},
		{[]string{"x-gzip"}, true},
		{[]string{"gzip, deflate, br, zstd"}, true},
		{[]string{"br", "gzip"}, true},
		{[]string{"gzip;q=0"}, false},
		{[]string{"gzip; q=0.000"}, false},
		{[]string{"gzip;q=0.5"}, true},
		{[]string{"br"}, false},
		{[]string{"identity"}, false},
		{[]string{"*"}, true},
		{[]string{"*;q=0"}, false},
		{[]string{"gzip;q=0, *"}, false},
		{[]string{"*;q=0, gzip"}, true},
		{[]string{"gzip;q=abc"}, false},
	}
	for _, c := range cases {
		if got := acceptsGzip(c.headers); got != c.want {
			t.Errorf("acceptsGzip(%q) = %v, want %v", c.headers, got, c.want)
		}
	}
}

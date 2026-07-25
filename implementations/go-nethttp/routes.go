package ashurbanipal

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/big"
	"net/http"
	"net/url"
	"strings"
)

const (
	protocolHeader = "x-ashurbanipal-protocol"
	// protocolVersion is bumped only for non-additive wire changes; must
	// track implementations/rust/src/routes.rs's PROTOCOL_VERSION and the
	// Spring Boot starter's own constant (spec/protocol.md §7).
	protocolVersion = "1"
)

// Router mounts the Ashurbanipal viewer's six routes (the UI plus five API
// routes) at cfg's base path into a plain http.Handler — no framework
// choice baked in, so it mounts into any net/http-compatible mux (stdlib
// ServeMux, Chi, or anything else).
//
// Router returns (nil, err) when EnabledFor names a production-like value
// (spec/protocol.md §4) — fail-closed via the error return, not a panic,
// so a host's own main() fails to start exactly like the Rust binary does
// when Config::from_toml rejects it, with no separate validation step to
// forget to call.
//
// When cfg is not enabled for the running environment — including the
// zero value Config{}, which MUST mean disabled (implementation.md §5.5
// item 2) — Router returns a handler that 404s every request,
// indistinguishable from the viewer never having been mounted at all
// (spec/protocol.md §4).
func Router(cfg Config, db *sql.DB) (http.Handler, error) {
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	if !cfg.IsEnabled() {
		return http.NotFoundHandler(), nil
	}

	limits := cfg.Limits.withDefaults()
	catalog := newCatalog(db, limits.QueryTimeoutSecs)
	client := &http.Client{}
	base := cfg.basePath()

	mux := http.NewServeMux()
	mux.HandleFunc("GET "+base, serveHTML)
	mux.Handle("GET "+base+"/api/tables", withProtocolHeader(listTablesHandler(catalog)))
	mux.Handle("GET "+base+"/api/table-counts", withProtocolHeader(tableCountsHandler(catalog)))
	mux.Handle("GET "+base+"/api/tables/data", withProtocolHeader(tableDataHandler(catalog, limits)))
	mux.Handle("GET "+base+"/api/tables/common-values", withProtocolHeader(commonValuesHandler(catalog)))
	mux.Handle("GET "+base+"/api/siblings", withProtocolHeader(siblingsHandler(client, cfg.Siblings)))
	return mux, nil
}

// withProtocolHeader stamps every API response, success or error
// (spec/protocol.md §2/§7), with the protocol version header. The HTML
// route (serveHTML) is wired directly, without this wrapper, since §5.1
// carries no protocol header.
func withProtocolHeader(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set(protocolHeader, protocolVersion)
		h(w, r)
	}
}

func serveHTML(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write(dbviewerHTML)
}

func writeJSON(w http.ResponseWriter, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func httpTextError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(status)
	fmt.Fprintln(w, msg)
}

// writeError maps a Catalog error to the wire's two error classes
// (spec/protocol.md §2): a *NotAllowedError or *FilterError is a client
// mistake (400, plain text); anything else is a database failure (500).
// Status code is the contract — wording is implementation-defined and
// asserted nowhere else.
func writeError(w http.ResponseWriter, err error) {
	var notAllowed *NotAllowedError
	var filter *FilterError
	switch {
	case errors.As(err, &notAllowed), errors.As(err, &filter):
		httpTextError(w, http.StatusBadRequest, err.Error())
	default:
		httpTextError(w, http.StatusInternalServerError, fmt.Sprintf("database error: %s", err))
	}
}

func listTablesHandler(c *Catalog) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tables, err := c.ListTables(r.Context())
		if err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, struct {
			Tables []TableInfo `json:"tables"`
		}{tables})
	}
}

func tableCountsHandler(c *Catalog) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		counts, err := c.TableCounts(r.Context())
		if err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, struct {
			Counts []CountEntry `json:"counts"`
		}{counts})
	}
}

func tableDataHandler(c *Catalog, limits Limits) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		if !q.Has("table") {
			httpTextError(w, http.StatusBadRequest, "table parameter is required")
			return
		}
		table := q.Get("table")

		// An empty (or whitespace-only) filter param means "no filter",
		// same as an absent param; a valid-but-empty JSON array means the
		// same thing (spec/protocol.md §5.4.2).
		var conditions []Condition
		if raw := q.Get("filter"); strings.TrimSpace(raw) != "" {
			parsed, err := ParseFilter(raw)
			if err != nil {
				writeError(w, err)
				return
			}
			if len(parsed) > 0 {
				conditions = parsed
			}
		}

		requestedLimit, err := parseSaturating(q, "limit")
		if err != nil {
			httpTextError(w, http.StatusBadRequest, err.Error())
			return
		}
		limit := int64(limits.DefaultPageSize)
		if requestedLimit != nil {
			limit = *requestedLimit
		}
		limit = clamp64(limit, 1, int64(limits.MaxPageSize))

		requestedOffset, err := parseSaturating(q, "offset")
		if err != nil {
			httpTextError(w, http.StatusBadRequest, err.Error())
			return
		}
		offset := int64(0)
		if requestedOffset != nil {
			offset = *requestedOffset
		}

		var sort *string
		if s := q.Get("sort"); s != "" {
			sort = &s
		}

		descending := false
		switch order := q.Get("order"); order {
		case "", "asc":
		case "desc":
			descending = true
		default:
			httpTextError(w, http.StatusBadRequest, fmt.Sprintf("invalid order %q (expected \"asc\" or \"desc\")", order))
			return
		}

		data, err := c.QueryTable(r.Context(), table, QueryOpts{
			Limit:      limit,
			Offset:     offset,
			Sort:       sort,
			Descending: descending,
			Filter:     conditions,
		})
		if err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, data)
	}
}

func commonValuesHandler(c *Catalog) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		if !q.Has("table") || !q.Has("column") {
			httpTextError(w, http.StatusBadRequest, "table and column parameters are required")
			return
		}
		values, err := c.CommonValues(r.Context(), q.Get("table"), q.Get("column"))
		if err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, struct {
			Values []CommonValueEntry `json:"values"`
		}{values})
	}
}

func siblingsHandler(client *http.Client, siblings []Sibling) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		statuses := checkSiblings(r.Context(), client, siblings)
		writeJSON(w, struct {
			Siblings []SiblingStatus `json:"siblings"`
		}{statuses})
	}
}

func clamp64(v, lo, hi int64) int64 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

// parseSaturating parses a query param as an arbitrary-precision integer
// and saturates it into [0, math.MaxInt64], mirroring the Rust
// reference's deserialize_saturating_u32 and the Spring Boot starter's
// own parseSaturating: spec/protocol.md §5.4 requires limit/offset to be
// clamped, never rejected, for any out-of-range numeric value. Binding
// the param straight into a native int type (as a naive query-param
// decode would) lets a value outside that type's range 400 before this
// code ever runs; parsing as math/big.Int first and saturating sidesteps
// that. Only genuinely non-numeric text ("abc", "1.5", "") still 400s.
func parseSaturating(q url.Values, key string) (*int64, error) {
	if !q.Has(key) {
		return nil, nil
	}
	raw := strings.TrimSpace(q.Get(key))
	if raw == "" {
		return nil, nil
	}
	n, ok := new(big.Int).SetString(raw, 10)
	if !ok {
		return nil, fmt.Errorf("invalid integer parameter %q: %q", key, raw)
	}
	if n.Sign() < 0 {
		n = big.NewInt(0)
	} else if n.Cmp(big.NewInt(math.MaxInt64)) > 0 {
		n = big.NewInt(math.MaxInt64)
	}
	v := n.Int64()
	return &v, nil
}

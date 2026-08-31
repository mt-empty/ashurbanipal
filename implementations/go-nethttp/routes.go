package ashurbanipal

import (
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
	// protocolVersion is bumped only for non-additive wire changes (spec/protocol.md §7).
	protocolVersion = "1"
)

// NamedSource pairs a DbSource with the name a request's "source" query
// param selects it by (spec/protocol.md §1's "Resolved source" rules).
// Order matters: the first entry in the slice passed to Router is the
// default a request with no "source" param resolves to, and api/sources
// (§5.8) lists names in that same order.
type NamedSource struct {
	Name   string
	Source DbSource
}

// Router mounts the Ashurbanipal viewer's routes (the UI plus the API
// routes) at cfg's base path into a plain http.Handler — no framework
// choice baked in, so it mounts into any net/http-compatible mux (stdlib
// ServeMux, Chi, or anything else).
//
// sources is the one seam to the database (see DbSource in db.go); hosts
// construct them before routing. sources MUST be non-empty — a host with
// nothing to browse should pass Enabled: false instead of an empty slice.
//
// When cfg.Enabled is false — including the zero value Config{}, which
// MUST mean disabled — Router returns a handler that 404s every request,
// indistinguishable from the viewer never having been mounted at all
// (spec/protocol.md §4).
func Router(cfg Config, sources []NamedSource) http.Handler {
	if !cfg.IsEnabled() {
		return http.NotFoundHandler()
	}
	if len(sources) == 0 {
		panic("ashurbanipal.Router: at least one source is required")
	}

	limits := cfg.Limits.WithDefaults()
	client := &http.Client{}
	base := cfg.basePath()

	mux := http.NewServeMux()
	mux.HandleFunc("GET "+base, serveHTML)
	mux.Handle("GET "+base+"/api/sources", withProtocolHeader(listSourcesHandler(sources)))
	mux.Handle("GET "+base+"/api/schemas", withProtocolHeader(listSchemasHandler(sources)))
	mux.Handle("GET "+base+"/api/tables", withProtocolHeader(listTablesHandler(sources)))
	mux.Handle("GET "+base+"/api/table-counts", withProtocolHeader(tableCountsHandler(sources)))
	mux.Handle("GET "+base+"/api/tables/data", withProtocolHeader(tableDataHandler(sources, limits)))
	mux.Handle("GET "+base+"/api/tables/common-values", withProtocolHeader(commonValuesHandler(sources)))
	mux.Handle("GET "+base+"/api/siblings", withProtocolHeader(siblingsHandler(client, cfg.Siblings)))
	return mux
}

// resolveSource resolves the "source" query param against sources the same
// way a schema name resolves against a live catalog list (spec/protocol.md
// §1/§6): absent means the first-registered default, present means an
// exact match or a *NotAllowedError — never a fallback guess.
func resolveSource(sources []NamedSource, requested *string) (DbSource, error) {
	if requested == nil {
		return sources[0].Source, nil
	}
	for _, s := range sources {
		if s.Name == *requested {
			return s.Source, nil
		}
	}
	return nil, &NotAllowedError{What: fmt.Sprintf("source %q", *requested)}
}

// querySource returns the "source" query param as a *string, nil when
// absent — mirrors querySchema.
func querySource(q url.Values) *string {
	if !q.Has("source") {
		return nil
	}
	s := q.Get("source")
	return &s
}

type SourceEntry struct {
	Name string `json:"name"`
}

func listSourcesHandler(sources []NamedSource) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		entries := make([]SourceEntry, len(sources))
		for i, s := range sources {
			entries[i].Name = s.Name
		}
		writeJSON(w, struct {
			Sources []SourceEntry `json:"sources"`
		}{entries})
	}
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

// writeError maps a DbSource error to the wire's two error classes
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

// querySchema returns the "schema" query param as a *string, nil when
// absent — the same optionality QueryOpts.Sort already uses, so an absent
// param and a resolved current_schema() fallback stay distinguishable all
// the way down to each backend's own resolveSchema.
func querySchema(q url.Values) *string {
	if !q.Has("schema") {
		return nil
	}
	s := q.Get("schema")
	return &s
}

func listSchemasHandler(sources []NamedSource) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		c, err := resolveSource(sources, querySource(r.URL.Query()))
		if err != nil {
			writeError(w, err)
			return
		}
		schemas, err := c.ListSchemas(r.Context())
		if err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, struct {
			Schemas []string `json:"schemas"`
		}{schemas})
	}
}

func listTablesHandler(sources []NamedSource) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		c, err := resolveSource(sources, querySource(q))
		if err != nil {
			writeError(w, err)
			return
		}
		tables, err := c.ListTables(r.Context(), querySchema(q))
		if err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, struct {
			Tables []TableInfo `json:"tables"`
		}{tables})
	}
}

func tableCountsHandler(sources []NamedSource) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		c, err := resolveSource(sources, querySource(q))
		if err != nil {
			writeError(w, err)
			return
		}
		counts, err := c.TableCounts(r.Context(), querySchema(q))
		if err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, struct {
			Counts []CountEntry `json:"counts"`
		}{counts})
	}
}

func tableDataHandler(sources []NamedSource, limits Limits) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		c, err := resolveSource(sources, querySource(q))
		if err != nil {
			writeError(w, err)
			return
		}
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

		data, err := c.QueryTable(r.Context(), querySchema(q), table, QueryOpts{
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

func commonValuesHandler(sources []NamedSource) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		c, err := resolveSource(sources, querySource(q))
		if err != nil {
			writeError(w, err)
			return
		}
		if !q.Has("table") || !q.Has("column") {
			httpTextError(w, http.StatusBadRequest, "table and column parameters are required")
			return
		}
		values, err := c.CommonValues(r.Context(), querySchema(q), q.Get("table"), q.Get("column"))
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

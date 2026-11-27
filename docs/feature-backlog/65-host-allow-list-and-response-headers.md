# Host allow-list and host-chosen response headers

> **Status:** DONE · **Area:** spec, ports, conformance, docs · **Ref:** part A (`Host` allow-list) shipped; part B (`[headers]`) declined 2026-11-27

Two config additions that close the cross-origin gaps found by the
2026-11-25 red-team run: an optional `Host` allow-list against DNS
rebinding, and a `[headers]` table so a host can add its own response
headers, with a safe framing default. Both add a config key, need a
`spec/protocol.md` change and touch every port's router setup, so one spec
revision covers both.

Part A shipped as `spec/protocol.md` §3.1, in every port.

**Part B was declined (user, 2026-11-27).** A host already adds response
headers with its own framework's middleware (Spring Security, helmet,
Flask-Talisman and the like). A `[headers]` table would duplicate that,
could clash with it (two CSPs are both enforced), and would need a config
key, validation and a protected-name list in every port. A framing default
would also block hosts that embed the viewer. The viewer sets no policy
headers; `readme.md` "Security" tells hosts to add their own. The part B
design below is kept as the record of what was considered.

## 1. The ask

- **A — `Host` allow-list.** A host lists the names its instance is reached
  at. A request whose `Host` header is not on the list gets the same 404 as
  a disabled viewer.
- **B — host-chosen headers.** A host adds headers such as
  `Content-Security-Policy` or `Referrer-Policy` to every response under the
  mount, from config. Without config, the HTML page sends
  `X-Frame-Options: DENY`.

## 2. Why

### A — DNS rebinding reads every table

No port looks at `Host`: every router matches on the path alone (e.g.
`implementations/rust/axum/src/routes.rs:49-85`,
`implementations/go-nethttp/routes.go:58-69`). There is no login, so the
network is the only gate, and a browser on that network can be turned
against it:

1. An engineer on the VPN opens `http://evil.example:4000`. Its DNS answer
   has a very short lifetime.
2. The attacker's DNS now answers with the internal Ashurbanipal address.
3. The page's script fetches `http://evil.example:4000/__ashurbanipal/api/tables/data?table=users`.
   The browser sees the same origin, so it lets the script read the rows.

The red team reproduced the server side: `curl -H 'Host: attacker.example'`
returned real rows from the axum demo. CORS does not help, because the
request is same-origin after the rebind; `Sec-Fetch-Site` does not help for
the same reason. The browser always sends the name from the page's URL in
`Host`, and the attacker cannot change that, so checking it stops the attack.

### B — no framing protection, and no shared way to add a CSP

The HTML route sends only `content-type`, `vary` and `content-encoding`
(`implementations/rust/axum/src/routes.rs:157-167`). Without
`X-Frame-Options` or `frame-ancestors`, any site can frame the viewer. The
UI is read-only, so the clickjacking risk is low, but the fix is free.

A CSP is the host's call by design (`PORTING.md`, "CSP and inline
scripts"), but today each host adds one through its own framework's
middleware, which differs in every language. One config key gives every
port the same documented recipe.

## 3. Design

### A — `allowed_hosts` (done)

Shipped as `spec/protocol.md` §3.1, which holds the full rule. Decided
(user, 2026-11-25):

- **Optional.** Absent or empty means no check. When absent, the router
  logs a warning when it is built; nothing is added to `/api/siblings`.
- **Entry form.** `name` or `name:port`, IPv6 in brackets. An entry with
  no port matches any port (not the scheme's default port). No wildcards.
- **Bad entries** match nothing and are logged; they never stop startup or
  turn the check off.
- **Reject with 404** on every route under the mount, before anything else
  runs. Rust actix-web and Node fall through to the host app, the same as
  their disabled router.
- **Raw `Host` only** (HTTP/2: `:authority`); never `X-Forwarded-Host`,
  `Forwarded` or a framework's proxy-aware host.
- **Config.** Rust and Flask: `allowed_hosts`; Go: `AllowedHosts`; Node:
  `allowedHosts`; Spring: `ashurbanipal.allowed-hosts`.
- **Tests.** `conformance/runner/host_allow_list.rs`, run by each port's
  two-source CI job (`CONFORMANCE_ALLOWED_HOSTS=1`), plus each port's own
  matcher tests.

### B — `[headers]`

```toml
[headers]
"Content-Security-Policy" = "default-src 'self'; script-src 'self' 'unsafe-inline'; frame-ancestors 'none'"
"Referrer-Policy" = "no-referrer"
```

- **Scope.** Every response under the mount: the HTML page and every API
  response, errors included. **Confirm:** one table for all, rather than
  separate `[headers.ui]` and `[headers.api]`.
- **Protected names.** A host cannot set `Content-Type`, `Content-Length`,
  `Content-Encoding`, `Vary`, `X-Content-Type-Options` or
  `X-Ashurbanipal-Protocol`; those are the protocol's (§2, §7). Matching is
  case-insensitive.
- **Validation.** A name must be an RFC 9110 token; a value must not contain
  CR, LF or NUL.
- **Bad config fails at startup.** A protected name, an invalid name or an
  invalid value stops router construction with a clear error, the way
  "enabled with no sources" already does. Sibling config is never rejected,
  only warned about, but a security header that is silently dropped looks
  exactly like a working one. **Confirm** this exception.
- **Default.** With no `X-Frame-Options` in `[headers]`, the HTML page sends
  `X-Frame-Options: DENY`. A host that wants framing sets its own value, or
  an empty string to send none. **Confirm** shipping the default.
- **Kill switch.** A disabled router registers no routes, so it sends no
  headers.

### Spec changes (`spec/protocol.md`)

- Done for part A: §3.1, and §3's "MUST NOT add authentication" rule now
  says a `Host` check is not authentication.
- Still to write: a section for `[headers]`, the protected names, the
  startup failure, and the framing default.
- §7: none of this changes a response for an existing caller that is not
  rejected, so v1 stands.

### Config shape per port

- **Rust, Flask:** TOML keys as above.
- **Go, Node:** the same fields on the host-built config struct or object.
- **Spring:** `ashurbanipal.headers.*`.
  Header names hold `-`, so YAML keys need Spring's bracket form
  (`"[Content-Security-Policy]"`) to keep their case.

## 4. Tests

- **Conformance.** Part A's checks are done (`host_allow_list.rs`). The
  demo hosts still need to read one `[headers]` entry from an environment
  variable, so the shared kit can check over HTTP:
  - the configured header is on the HTML page and on an API error response;
  - `X-Frame-Options: DENY` is on the HTML page when none is configured.
- **Port tests** for what HTTP cannot observe: the startup failure on a
  protected name or a CR/LF value.
- `PORTING.md`: add the protected header list (the raw-`Host` rule is
  done, under "What you MUST NOT do").

## 5. Out of scope

- Anything reachable without a browser. A client already on the network can
  send any `Host` with `curl`; network rules remain the only defence there.
- An instance exposed under its real name by mistake. The `Host` check
  passes for that name; the kill switch remains the defence.
- Ashurbanipal choosing a CSP for the host.

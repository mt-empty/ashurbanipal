# Refuse a root mount in Flask and Spring

> **Status:** DONE · **Area:** flask, spring, docs · **Ref:** PR #326

`spec/protocol.md` §3 says `{mount}` MUST NOT be the root path, and that an
implementation MUST refuse a root mount when it builds the router. Go and
Node already do. Flask and Spring only logged a deprecation warning, added
after 0.15.0. This story turns that warning into a refusal.

## 1. The ask

- **Flask:** a root mount (`router(..., mount="/")`, or
  `register_blueprint(bp, url_prefix="/")`) raises `ValueError` at
  registration, instead of logging a warning.
- **Spring:** `ashurbanipal.base-path=/` fails startup with a clear message,
  instead of logging a warning. A `spring.mvc.servlet.path` of its own does
  not make a mount root; only a root `base-path` does.

## 2. Why

- A root mount takes `/` and the ten `/api/...` names from the host. Werkzeug
  quietly picks one of two `/` rules, and Spring fails at startup if the host
  has its own `GET /`, so a root mount is a route collision even before the
  `Host` check.
- Every other port already refuses one: Go panics, Node throws, and axum and
  actix-web hardcode `/__ashurbanipal`. Until Flask and Spring refuse too, the
  spec's MUST holds in four ports of six.

## 3. Where

- **Flask** `implementations/flask-python/ashurbanipal/routes.py`:
  `_remember_registration` logs the warning when the registration prefix is
  empty. Raise there instead. `record` runs inside `register_blueprint`, so
  the host sees the error at setup, not on the first request. Also reject
  `mount="/"` in `router()` itself, so the error names the argument.
- **Spring** `AshurbanipalAutoConfiguration.kt`: the
  `ashurbanipalHostAllowListFilter` bean logs the warning when
  `ViewerMount.root` is true. Fail startup there, or earlier in
  `AshurbanipalProperties`' `init` block next to its other validation. Then
  `ViewerMount.root` and its `"$path/"` page variant can go.
- **Tests** that pin today's warning-only behaviour:
  - Flask `tests/test_host_routes.py::test_a_root_mount_leaves_the_host_routes_alone`
    becomes a refusal test.
  - Spring `HostAllowListTest` ``a root mount never covers the host's other routes``
    and `MultipartExceptionResolverTest` ``a root mount leaves the host's other paths alone``
    become refusal tests, or go.
- **Docs:** the Flask and Spring rows of `docs/adapter-decisions.md` §3, and
  the `mount` and `base-path` notes in both ports' READMEs.

## 4. When

In 0.16.0, the first release after 0.15.0. The plan was to ship the warning
in one release and the refusal in the next, but no one was known to use a
root mount, and one never worked reliably (Werkzeug picks one of two `/`
rules; Spring fails if the host has its own `GET /`). So the refusal replaced
the warning before any release shipped it. It breaks a host mounted at `/`,
so the CHANGELOG entry carries a `!` and the migration line: mount the viewer
under a path of its own.

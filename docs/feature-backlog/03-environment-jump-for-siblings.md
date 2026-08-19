# Jump between dev / int / staging environments of the same app

**Ask:** a way to switch environments for the same service, not just between
different sibling services.

**Impact / constraints:**
- No existing config models this. `config.rs`'s `siblings` list
  (`design.md` §7) represents *other services* — each with its own
  independent `dbviewer_url`, `name`, `health_path` — not other environments
  of *this* service. There's no field anywhere for "this app's URL in
  staging" vs. "this app's URL in dev."
- Also brushes against the kill-switch design: `Config::is_enabled()`
  (`config.rs`) is a bare on/off flag the host controls; Ashurbanipal itself
  has no notion of which environment it's in. Any env-jump UI has to be
  careful not to imply or enable cross-environment access the backend
  wouldn't actually allow — e.g. a link to a staging instance is fine (it's
  just a URL, same shape as a sibling link), but the UI shouldn't create any
  impression that Ashurbanipal itself is brokering that access.
- Simplest framing: this might just be "siblings, but for the same app" —
  i.e. reuse the sibling list/health-check/link-out mechanism entirely,
  just with a naming convention (e.g. `name: "myapp (staging)"`) rather than
  a new config concept. Worth deciding whether that reuse is good enough or
  whether it deserves its own first-class config shape. See
  `06-dynamic-sibling-discovery.md` — both point at the same underlying
  limitation: the sibling list is static, hand-maintained TOML.

# Dynamic sibling discovery

> **Status:** OPEN · **Area:** ports, spec

**Where logged:** `design.md` §2 (non-goal), §9 (deferred).

**What it is:** siblings are a static, hand-maintained TOML list
(`name`/`base_url`/`health_path`); no service-registry or k8s-based
auto-discovery of sibling services.

**Tidbits:** story 03 (done) gave sibling entries environment labels, but
the list itself is still static config. This story is about where the list
comes from.

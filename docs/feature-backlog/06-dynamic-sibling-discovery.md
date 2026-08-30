# Dynamic sibling discovery

**Where logged:** `design.md` §2 (non-goal), §9 (deferred).

**What it is:** siblings are a static, hand-maintained TOML list
(`name`/`base_url`/`health_path`); no service-registry or k8s-based
auto-discovery of sibling services.

**Tidbits:** the backend-config-side version of the same limitation
`03-environment-jump-for-siblings.md` is about — both are "the sibling list
can't currently represent anything dynamic," just at different layers
(config source vs. what a sibling entry can mean).

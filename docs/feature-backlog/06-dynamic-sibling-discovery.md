# Dynamic sibling discovery

> **Status:** OPEN · **Area:** ports, spec

**Where logged:** `docs/design.md` §2 (non-goal), §9 (deferred).

**What it is:** the sibling list is static configuration
(`spec/protocol.md` §5.6): `name`, optional `label`, `base_url` and
`health_path` per sibling. A host can already build that list in code
before it mounts the router. What is missing is a list that changes while
the host runs, fed by a service registry or Kubernetes.

**Tidbits:**
- §5.6 says "The sibling list is static configuration", so this is a spec
  change.
- A discovered sibling's `label` must still be a string the host writes.
  §5.6 forbids deriving it from any other signal, such as a Kubernetes
  namespace (§4).
- The health check fetches every listed `base_url` origin, so the
  discovery source must be one the host trusts.

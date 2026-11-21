# Sibling health-check caching / background polling

> **Status:** OPEN · **Area:** spec, ports

**What it is:** `/api/siblings` checks every sibling on each request, with
no cache (`docs/design.md` §4.1, "Siblings are checked on request";
`spec/protocol.md` §5.6). The frontend polls it only while the pop-up is
open (`frontend/src/features/siblings.ts`).

**Trigger:** a real deployment where that per-request fan-out to N
siblings becomes measurable load (`docs/design.md` §9).

**Fix:** a per-source cache filled on demand, with a 15 s TTL and one
in-flight check shared by every caller. It caps the fan-out at once per
15 s however many viewers there are, and does no work while nobody looks.
A background poller gives the same cap but polls even when the tool sits
idle, which is the usual case.

**Needs:** a change to §5.6's "synchronously per request" rule and to
`docs/design.md` §9's "background-polled cache", in the same PR as the
ports that add the cache.

# Sibling health-check caching / background polling

> **Status:** OPEN · **Area:** ports

**Where logged:** `design.md` §4 (`GET /siblings`), §9 (deferred, with a
concrete trigger).

**What it is:** `/siblings` currently does parallel per-request HTTP health
checks synchronously (no caching); the frontend fetches it at page load,
then every ~15s only while the Other services pop-up is open (plus backoff
retries, 15s to 60s, after a failure). The
documented next step, *if* per-request checks turn out too chatty/slow with
many configured siblings, is a background-polled cache at the same 15s
cadence — not a vague someday, a named trigger condition.

**Tidbits:** worth revisiting if/when a real deployment's sibling count
grows large enough that each open pop-up's 15s refresh fanning out into N parallel
HTTP requests server-side becomes measurable load.

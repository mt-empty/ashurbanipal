# Sibling health-check caching / background polling

**Where logged:** `design.md` §4 (`GET /siblings`), §9 (deferred, with a
concrete trigger).

**What it is:** `/siblings` currently does parallel per-request HTTP health
checks synchronously (no caching); the frontend polls it every ~15s. The
documented next step, *if* per-request checks turn out too chatty/slow with
many configured siblings, is a background-polled cache at the same 15s
cadence — not a vague someday, a named trigger condition.

**Tidbits:** worth revisiting if/when a real deployment's sibling count
grows large enough that every client's 15s poll fanning out into N parallel
HTTP requests server-side becomes measurable load.

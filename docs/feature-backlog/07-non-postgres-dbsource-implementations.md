# Non-Postgres `DbSource` implementations

**Where logged:** `design.md` §2 (non-goal), §5, §9 (deferred).

**What it is:** v1 ships exactly one `DbSource` implementation
(`PgPoolSource`). The trait boundary exists specifically so a
`deadpool-postgres`/`tokio-postgres`/non-Postgres adapter could be added
later without touching route handlers.

**Tidbits:** purely backend/architectural, no frontend surface. Named in
`design.md` §5 as "intentionally the only piece of the crate designed for a
hypothetical future backend; everything else stays concrete to v1's scope" —
worth remembering as the one deliberate exception if a "why isn't everything
this flexible" question ever comes up.

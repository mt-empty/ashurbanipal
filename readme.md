# Ashurbanipal

<img src="docs/media/icon.svg" alt="" width="32" height="32" align="left"> 

A self-contained, embeddable database browser(read only). no separate DB client, no extra credentials, no build step.

## Why

Getting a row out of a database that isn't on your laptop currently means:

- Did you request AWS access? Wait for approval.
- Approved? Now add your username and SSH key to a separate repo nobody's heard of, and wait for *that* owner to approve you too.
- Follow a Confluence page to wire up AWS + SSH + your pick of DBeaver/pgcli/psql/pgAdmin/TablePlus.
    - ssh timeout out, oh too bad
- Get your session killed by fucking Okta re-auth every few hours. Repeat.
    - blindly accept the MFA prompt, or else your session dies and you have to start over
- Right now the bastion host is being patched, so none of the above even
  works.
- You don't need to have db access, you just need to slice your stories thinly enough so you can test your code without needing db access
- ram is expensive, I really can't afford another app running on my laptop

all I need is to just see a row in the db, so I can complete my story.

Ashurbanipal lib skips the whole chain by not needing a new connection at all, 
it runs inside the process that already has one. If your service can query
its own database, you can look at a table from your browser.

## Showcase

<!-- TODO: replace with the real capture. Suggested to record end-to-end
     against `mise run demo` (seeded db, http://localhost:4000/__ashurbanipal):
     pick a table -> sort/filter with the DSL -> click-to-filter on a cell ->
     expand a jsonb cell -> open the record (vertical row) view -> jump via
     a sibling link. ~15-20s, no narration needed. -->
![Ashurbanipal demo](docs/media/demo.gif)

## What it does

- Lists tables with approximate row counts (and table/column comments, if
  your schema has them).
- Search-as-you-type sidebar to jump to a table.
- Paginated table data with sort and a small SQL-like filter DSL.
- Click a cell to filter by that exact value; a popover suggests common
  values for a column, read straight from Postgres's planner statistics —
  no `SELECT DISTINCT` scan.
- `jsonb` cells pretty-print in a hover preview; a per-row "record" view lays
  a wide row out as a vertical `column: value` list instead of scrolling.
- Per-cell copy button, and a raw-JSON payload viewer for the current page.
- Show/hide columns.
- Links to sibling services with live health checks, so you can jump between
  databases in a multi-service setup.

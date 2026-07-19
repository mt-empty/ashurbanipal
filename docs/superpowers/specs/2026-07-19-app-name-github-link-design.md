# App name → GitHub link

## What

The sidebar `<h1>Ashurbanipal</h1>` in `src/frontend/dbviewer.html` becomes a
link to `https://github.com/mt-empty/ashurbanipal`.

## Behavior

- Clicking the app name opens the GitHub repo in a new tab
  (`target="_blank" rel="noopener"`), preserving the user's current
  dbviewer session/state in the original tab.
- Visually unchanged: the link inherits the existing `<h1>` styling
  (no underline/link-color), so it reads as a title that happens to be
  clickable rather than a conventional hyperlink.

## Scope

Single-element markup change in `dbviewer.html`. No JS, no CSS additions
beyond ensuring the anchor doesn't pick up default link styling.

# AI-suggested join names

> **Status:** OPEN · **Area:** frontend, docs, e2e

## 1. The ask

When a user saves a join (story 41), they type a name by hand. The browser
may already hold a small language model that can propose one from the join,
for example `Orders with customer and gift`. Offer that as a suggestion, only
where the model is already on the device. Never trigger a download.

## 2. Browser support

Checked 2026-10-18; the Chrome rows again on 2026-11-21. Re-check before building; the API is contested and may change.

| Browser | Status |
|---|---|
| Chrome desktop | On by default since 148. Windows 10/11, macOS 13+, Linux, ChromeOS on Chromebook Plus. |
| Chrome Android / iOS | Not supported. |
| Edge | Canary and Dev only (Phi-4-mini). Not in stable. |
| Firefox | Not shipped. Mozilla opposes the API. |
| Safari | Not shipped. WebKit's position is negative. |

In practice: desktop Chrome, on a machine that meets the hardware bar
(about 22 GB free disk, and a GPU with more than 4 GB VRAM or 16 GB RAM
with 4+ CPU cores), where the model is already downloaded.

Docs:
- Chrome: [Prompt API](https://developer.chrome.com/docs/ai/prompt-api),
  [inform users of the model download](https://developer.chrome.com/docs/ai/inform-users-of-model-download)
- Spec: [Prompt API (WebML CG)](https://webmachinelearning.github.io/prompt-api/)
- MDN: [Prompt API](https://developer.mozilla.org/en-US/docs/Web/API/Prompt_API)
- Edge: [Prompt API](https://learn.microsoft.com/microsoft-edge/web-platform/prompt-api)

## 3. Design

- Feature-detect: `'LanguageModel' in self`, then
  `await LanguageModel.availability({ expectedInputs, expectedOutputs })`
  with `languages: ['en']` on both, and the same options later passed to
  `create()`.
- Show the control only when the result is exactly `'available'`. Treat
  `downloadable`, `downloading`, `unavailable`, `null` and a missing API the
  same way: show nothing. No button, no message, no fallback request to any
  server, and no heuristic name such as `orders + users`. Never call `create()` unless the model is already available:
  Chrome's Prompt API page says `create()` is what triggers the download.
- A page cannot choose the model or its size. The browser decides.
- Check availability when the join dialog opens, not once at page load, so
  a finished download or a removed model is seen.
- The model runs on the device. The join text goes nowhere else, and no
  setting or key is needed.
- A `Suggest name` control in the join dialog footer fills the Name field.
  The user can edit it. Never fill it without a click. The click also
  satisfies the user-activation rule for `create()`.
- Prompt: table names and column names of the join only. Column names are
  schema, not data; row values are never sent. Ask for one name of at most
  60 characters (the Name field's `maxlength`), then trim the answer.
- The control shows its own loading state while the model runs
  (`docs/ui-guidelines.md` R9). Abort on dialog close. Call
  `session.destroy()` after each suggestion.
- Wrap `create()` and `prompt()` in try/catch. The model can vanish (Chrome
  removes it below 10 GB free disk), so a stale `available` is possible. On
  failure, hide the control and leave the Name field untouched.
- Limits: not available in Web Workers. A host that embeds the UI in a
  cross-origin iframe needs `allow="language-model"`, or the control stays
  hidden.
- The join dialog footer (`.dialog-foot` in `frontend/src/index.html`)
  already holds the Name field and three buttons. Place the control on a
  design canvas board before building.

## 4. Open questions

- Is the first prompt after browser start slow enough to need more than an
  in-place loading state?

## 5. Tests

- Playwright browsers do not ship the model, so stub `window.LanguageModel`
  with `page.addInitScript`.
- Cases: API missing, each non-`available` value (no control shown, and
  `create()` never called), `available` with a good answer, `create()`
  rejecting, abort on dialog close.

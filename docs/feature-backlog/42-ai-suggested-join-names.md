# AI-suggested join names

> **Status:** OPEN · **Area:** frontend, docs, e2e · **Ungroomed:** idea only, not refined

## 1. The ask

When a user saves a join (story 41), they type a name by hand. The browser
may ship a small language model that can propose one from the join text, for
example `Orders with customer and gift`. Offer that as a suggestion, only
where the browser provides the model.

## 2. Idea

- Chrome has built-in AI APIs (Prompt API and others, backed by a small
  on-device model). Firefox's equivalent is, as far as we know, limited to
  extensions or behind a flag. Check current support when grooming.
- Feature-detect the API. If it is missing, show nothing: no button, no
  message, no fallback request to any server.
- The model runs on the device. The join text goes nowhere else, and no
  setting or key is needed.
- A `Suggest name` control in the join dialog footer fills the Name field.
  The user can edit it. Never fill it without a click.

## 3. Open questions

- Which browsers and versions support it, and is the download of the model
  a surprise for the user?
- Prompt: join text only, or table names plus column names? Column names
  are schema, not data; row values are never sent.
- Fallback when the model is unavailable or slow: none, or a plain
  heuristic name such as `orders + users`.
- Does it need a user gesture and a loading state (story 37)?
- Test approach: Playwright browsers do not ship the model, so stub the API.

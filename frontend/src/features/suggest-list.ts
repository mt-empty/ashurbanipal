import { el } from "../core/dom.js";
export interface Suggestion {
  label: string;
  insert: string;
  // Right-aligned beside the label: a type, a row count, or the reason a row is blocked.
  note?: string;
  // A small badge after the note (`foreign key`, `indexed`).
  tag?: string;
  // The row shows greyed and cannot be taken.
  blocked?: boolean;
}

interface SuggestOptions {
  input: HTMLInputElement | HTMLTextAreaElement;
  popup: HTMLElement;
  list: HTMLElement;
  // Prefix of the option ids, so each field's aria-activedescendant is unique.
  idPrefix: string;
  // Called with the chosen row and the text before the word it completes; the
  // caller writes the value and decides what to suggest next.
  accept: (suggestion: Suggestion, head: string) => void;
  // Runs once the popup is visible, for positioning it.
  place?: () => void;
}

export interface SuggestList {
  show(matches: Suggestion[], head: string, index: number): void;
  close(): void;
  // Bumped on every show and close, so a slow lookup can tell its text has changed.
  token(): number;
}

// A listbox of suggestions under a text field: the arrow keys move a highlight,
// Tab accepts (the first row when none is highlighted), Enter accepts only a
// highlighted row so it still submits otherwise, Escape and a click elsewhere
// close it. The field keeps focus throughout.
export function createSuggestList(opts: SuggestOptions): SuggestList {
  const { input, popup, list, idPrefix } = opts;
  let matches: Suggestion[] = [];
  let index = -1; // highlighted row, -1 = none
  let head = ""; // text before the word being completed
  let token = 0;

  const close = (): void => {
    token++;
    matches = [];
    index = -1;
    head = "";
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    popup.hidden = true;
  };

  const accept = (i: number): void => {
    if (matches[i] && !matches[i].blocked) opts.accept(matches[i], head);
  };

  const render = (): void => {
    list.replaceChildren(
      ...matches.map((suggestion, i) => {
        const btn = el("button");
        btn.type = "button";
        const text = [suggestion.label, suggestion.note, suggestion.tag].filter(Boolean).join(" · ");
        btn.title = text; // long values are cut off with an ellipsis
        const name = el("span");
        name.textContent = suggestion.label;
        btn.appendChild(name);
        if (suggestion.note || suggestion.tag) {
          const note = el("span", "sg-note", suggestion.note ?? "");
          if (suggestion.tag) {
            const tag = el("span", "sg-tag", suggestion.tag);
            note.appendChild(tag);
          }
          btn.appendChild(note);
        }
        if (suggestion.blocked) btn.setAttribute("aria-disabled", "true");
        btn.className = i === index ? "active" : "";
        btn.id = `${idPrefix}-${i}`;
        btn.setAttribute("role", "option");
        btn.setAttribute("aria-selected", String(i === index));
        // Keeps focus (and the caret) in the field — otherwise the button
        // would steal focus, firing its blur handler and closing this
        // popup before its own click handler runs.
        btn.onmousedown = (e) => e.preventDefault();
        btn.onclick = () => accept(i);
        return btn;
      }),
    );
    // Arrow-key moves change .active without mouse involvement, so the
    // list has to scroll itself.
    list.children[index]?.scrollIntoView({ block: "nearest" });
    if (index >= 0) input.setAttribute("aria-activedescendant", `${idPrefix}-${index}`);
    else input.removeAttribute("aria-activedescendant");
  };

  const field: HTMLElement = input; // one addEventListener overload, not the union of two
  field.addEventListener("keydown", (e: KeyboardEvent) => {
    if (matches.length === 0) return;
    const count = matches.length;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      index = (index + 1) % count;
      render();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      index = index <= 0 ? count - 1 : index - 1;
      render();
    } else if (e.key === "Enter" && index >= 0) {
      e.preventDefault();
      accept(index);
    } else if (e.key === "Tab") {
      e.preventDefault();
      accept(index >= 0 ? index : matches.findIndex((m) => !m.blocked));
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  });
  field.addEventListener("blur", close);
  // addEventListener, not `document.onpointerdown =`: the single IDL slot on
  // document is shared global state any other module could silently overwrite
  // (frontend-style-guide.md §3).
  document.addEventListener("pointerdown", (e) => {
    if (matches.length > 0 && !input.contains(e.target as Node) && !popup.contains(e.target as Node)) close();
  });

  return {
    show(next, nextHead, nextIndex) {
      matches = next;
      head = nextHead;
      index = nextIndex;
      render();
      popup.hidden = false;
      opts.place?.();
      input.setAttribute("aria-expanded", "true");
    },
    close,
    token: () => token,
  };
}

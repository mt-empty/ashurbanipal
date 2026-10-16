import { $ } from "../core/dom.js";

// A button that opens a menu of rows, each a label on the left and a note on
// the right; a row with a `blocked` note stays visible, greyed, and cannot be
// picked. One shared popover (inside the join dialog, so the dialog's inert
// backdrop does not cover it) serves every dropdown.
export interface DropdownOption {
  value: string;
  label: string;
  // Right-aligned: the type, or the reason a row cannot be picked.
  note?: string;
  blocked?: boolean;
}

export interface DropdownOptions {
  ariaLabel: string;
  options: DropdownOption[];
  value: string;
  // Shown on the button when nothing is picked.
  placeholder: string;
  // Shown on the button instead of the picked option's label.
  display?: string;
  mono?: boolean;
  invalid?: boolean;
  onPick: (value: string) => void;
}

const pop = (): HTMLElement => $("dd-pop");
let anchor: HTMLElement | null = null;
let lastLabel = "";

// The aria-label of the dropdown last opened, so a form that re-renders can put focus back on it.
export function lastDropdownLabel(): string {
  return lastLabel;
}

function closeMenu(): void {
  if (pop().matches(":popover-open")) pop().hidePopover();
}

function open(button: HTMLButtonElement, opts: DropdownOptions): void {
  if (anchor) anchor.style.anchorName = "";
  anchor = button;
  lastLabel = opts.ariaLabel;
  button.style.anchorName = "--dd-anchor";
  const list = $("dd-pop-list");
  list.setAttribute("aria-label", opts.ariaLabel);
  list.replaceChildren(
    ...opts.options.map((o) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "dd-row";
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(o.value === opts.value));
      row.dataset.value = o.value;
      const name = document.createElement("span");
      name.textContent = o.label;
      row.appendChild(name);
      if (o.note) {
        const note = document.createElement("span");
        note.className = "dd-note";
        note.textContent = o.note;
        row.appendChild(note);
      }
      if (o.blocked) {
        row.setAttribute("aria-disabled", "true");
        row.classList.add("blocked");
      }
      row.onclick = () => {
        if (o.blocked) return;
        closeMenu();
        opts.onPick(o.value);
      };
      return row;
    }),
  );
  pop().showPopover();
  const start =
    list.querySelector<HTMLElement>('[aria-selected="true"]') ??
    list.querySelector<HTMLElement>(".dd-row:not(.blocked)");
  start?.focus();
  start?.scrollIntoView({ block: "nearest" });
}

export function createDropdown(opts: DropdownOptions): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `dd${opts.mono ? " mono" : ""}${opts.invalid ? " bad" : ""}`;
  button.setAttribute("aria-label", opts.ariaLabel);
  button.setAttribute("aria-haspopup", "listbox");
  const picked = opts.options.find((o) => o.value === opts.value);
  const text = opts.display ?? picked?.label ?? opts.placeholder;
  button.textContent = `${text} ▾`;
  if (!picked && opts.display === undefined) button.classList.add("empty");
  button.onclick = () => open(button, opts);
  return button;
}

// Arrow keys move through the rows; the popover itself handles Escape and
// light dismiss.
pop().addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  const rows = [...pop().querySelectorAll<HTMLElement>(".dd-row:not(.blocked)")];
  if (rows.length === 0) return;
  e.preventDefault();
  const at = rows.indexOf(document.activeElement as HTMLElement);
  const next = e.key === "ArrowDown" ? (at + 1) % rows.length : (at <= 0 ? rows.length : at) - 1;
  rows[next].focus();
});
pop().addEventListener("toggle", (e) => {
  if ((e as ToggleEvent).newState === "closed" && anchor) {
    anchor.style.anchorName = "";
    anchor.focus({ preventScroll: true });
  }
});

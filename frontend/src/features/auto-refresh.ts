import { loadData } from "../bootstrap/reload.js";
import { $, el, reportError } from "../core/dom.js";
import { formatClock } from "../lib/format.js";
import { startCountdown, stopCountdown } from "./load-bar.js";
import { showViewNotice } from "./view-notice.js";

// Opt-in re-fetch of the current view on a fixed interval. Off on every page
// load and never persisted. The countdown restarts whenever the last in-flight
// fetch ends, so a tick is only ever skipped for a fetch the user started.

const STEPS: ReadonlyArray<{ ms: number; label: string }> = [
  { ms: 0, label: "Off" },
  { ms: 5_000, label: "5 s" },
  { ms: 10_000, label: "10 s" },
  { ms: 15_000, label: "15 s" },
  { ms: 30_000, label: "30 s" },
  { ms: 60_000, label: "1 min" },
];
const MAX_FAILURES = 5;
const IDLE_MS = 30 * 60_000;
const IDLE_NOTICE = "Auto-refresh turned off after 30 minutes without activity.";
// Matches the .row-new wash the chip accompanies.
const CHIP_MS = 3000;

let intervalMs = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let chipTimer: ReturnType<typeof setTimeout> | undefined;
let deadline = 0;
let fetching = false;
let failures = 0;
let lastInput = Date.now();

function arm(remainingMs: number): void {
  clearTimeout(timer);
  deadline = Date.now() + remainingMs;
  startCountdown(intervalMs, intervalMs - remainingMs);
  timer = setTimeout(tick, remainingMs);
}

function restart(): void {
  if (intervalMs > 0 && !document.hidden) arm(intervalMs);
}

function disarm(): void {
  clearTimeout(timer);
  stopCountdown();
}

const isIdle = () => Date.now() - lastInput > IDLE_MS;

function tick(): void {
  if (isIdle()) {
    stop(IDLE_NOTICE);
    return;
  }
  if (fetching) return;
  void loadData({ resetScroll: false, highlightNew: true, auto: true }).finally(() => {
    // A load that never fetched (no view yet) leaves nothing else to restart the countdown.
    if (intervalMs > 0 && Date.now() >= deadline) restart();
  });
}

function render(): void {
  const on = intervalMs > 0;
  $("refresh-split").classList.toggle("on", on);
  const suffix = $("refresh-interval");
  suffix.hidden = !on;
  $("refresh").setAttribute("aria-label", "refresh");
  if (on) {
    const { label } = STEPS.find((s) => s.ms === intervalMs) ?? STEPS[0];
    suffix.textContent = ` · ${label}`;
    $("refresh").setAttribute("aria-label", `refresh, automatically every ${label}`);
  }
  for (const radio of document.querySelectorAll<HTMLInputElement>("#refresh-pop-list input")) {
    radio.checked = Number(radio.value) === intervalMs;
  }
}

function noteInput(): void {
  lastInput = Date.now();
}
const INPUT_EVENTS = ["pointermove", "pointerdown", "keydown", "scroll", "touchstart"];

function chooseInterval(ms: number): void {
  intervalMs = ms;
  failures = 0;
  noteInput();
  // Same handler and options, so adding again is a no-op; they only listen while the interval is on.
  for (const type of INPUT_EVENTS) {
    if (ms > 0) document.addEventListener(type, noteInput, { passive: true, capture: true });
    else document.removeEventListener(type, noteInput, { capture: true });
  }
  if (ms > 0) restart();
  else disarm();
  render();
}

function stop(notice?: string): void {
  chooseInterval(0);
  if (notice) showViewNotice(notice);
}

export function setFetching(on: boolean): void {
  fetching = on;
  if (!on) restart();
}

export function noteLoadOk(): void {
  failures = 0;
  const updated = $("row-updated");
  updated.textContent = ` · updated ${formatClock(new Date())}`;
  updated.hidden = false;
}

export function noteTickFailed(e: unknown): void {
  if (++failures < MAX_FAILURES) return;
  const last = e instanceof Error ? e.message : String(e);
  stop();
  reportError(new Error(`Auto-refresh turned off after ${MAX_FAILURES} failed refreshes. Last error: ${last}.`));
}

// Also the manual refresh's count; 0 hides it, so a chip never outlives the view it described.
export function setNewChip(count: number): void {
  const chip = $("row-new-chip");
  clearTimeout(chipTimer);
  chip.hidden = count === 0;
  if (count === 0) return;
  chip.textContent = `+${count} new`;
  chipTimer = setTimeout(() => {
    chip.hidden = true;
  }, CHIP_MS);
}

export function startAutoRefresh(): void {
  const list = $("refresh-pop-list");
  list.replaceChildren(
    ...STEPS.map(({ ms, label }) => {
      const radio = el("input");
      radio.type = "radio";
      radio.name = "refresh-interval";
      radio.value = String(ms);
      radio.onchange = () => {
        chooseInterval(ms);
        $("refresh-pop").hidePopover();
        $("refresh-menu-btn").focus();
      };
      const row = el("label");
      row.append(radio, label);
      return row;
    }),
  );
  render();

  document.addEventListener("visibilitychange", () => {
    if (intervalMs === 0) return;
    if (document.hidden) {
      disarm();
      return;
    }
    // Checked here, not left to the next tick: the first input after a long absence would reset the idle clock.
    if (isIdle()) {
      stop(IDLE_NOTICE);
      return;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) tick();
    else arm(remaining);
  });
}

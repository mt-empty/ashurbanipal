import { loadData } from "../bootstrap/reload.js";
import { $, el, reportError } from "../core/dom.js";
import { formatClock } from "../lib/format.js";
import { startCountdown, stopCountdown } from "./load-bar.js";
import { showViewNotice } from "./view-notice.js";

// Opt-in re-fetch of the current view on a fixed interval (story 38). Off on
// every page load and never persisted. The countdown restarts whenever any
// fetch ends, so a tick is only ever skipped for a fetch the user started.

const STEPS: ReadonlyArray<{ seconds: number; label: string }> = [
  { seconds: 0, label: "Off" },
  { seconds: 5, label: "5 s" },
  { seconds: 10, label: "10 s" },
  { seconds: 15, label: "15 s" },
  { seconds: 30, label: "30 s" },
  { seconds: 60, label: "1 min" },
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
let busy = 0;
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

function tick(): void {
  if (Date.now() - lastInput > IDLE_MS) {
    stop(IDLE_NOTICE);
    return;
  }
  if (busy > 0) return;
  void loadData({ resetScroll: false, highlightNew: true, auto: true }).finally(() => {
    // A load that never fetched (no view yet) leaves nothing else to restart the countdown.
    if (intervalMs > 0 && Date.now() >= deadline) restart();
  });
}

function render(): void {
  const step = STEPS.find((s) => s.seconds * 1000 === intervalMs) ?? STEPS[0];
  const on = intervalMs > 0;
  $("refresh-split").classList.toggle("on", on);
  const suffix = $("refresh-interval");
  suffix.hidden = !on;
  suffix.textContent = on ? ` · ${step.label}` : "";
  $("refresh").setAttribute("aria-label", on ? `refresh, automatically every ${step.label}` : "refresh");
  for (const radio of document.querySelectorAll<HTMLInputElement>("#refresh-pop-list input")) {
    radio.checked = Number(radio.value) * 1000 === intervalMs;
  }
}

function chooseInterval(seconds: number): void {
  intervalMs = seconds * 1000;
  failures = 0;
  lastInput = Date.now();
  clearTimeout(timer);
  if (intervalMs > 0) restart();
  else stopCountdown();
  render();
}

function stop(notice?: string): void {
  chooseInterval(0);
  if (notice) showViewNotice(notice);
}

export function fetchStarted(): void {
  busy++;
}

export function fetchEnded(): void {
  busy--;
  restart();
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

export function showNewChip(count: number): void {
  const chip = $("row-new-chip");
  chip.textContent = `+${count} new`;
  chip.hidden = false;
  clearTimeout(chipTimer);
  chipTimer = setTimeout(() => {
    chip.hidden = true;
  }, CHIP_MS);
}

export function startAutoRefresh(): void {
  const list = $("refresh-pop-list");
  list.replaceChildren(
    ...STEPS.map(({ seconds, label }) => {
      const radio = el("input");
      radio.type = "radio";
      radio.name = "refresh-interval";
      radio.value = String(seconds);
      radio.onchange = () => {
        chooseInterval(seconds);
        $("refresh-pop").hidePopover();
        $("refresh-menu-btn").focus();
      };
      const row = el("label");
      row.append(radio, label);
      return row;
    }),
  );
  render();

  const noteInput = () => {
    lastInput = Date.now();
  };
  for (const type of ["pointermove", "pointerdown", "keydown", "scroll", "touchstart"]) {
    document.addEventListener(type, noteInput, { passive: true, capture: true });
  }

  document.addEventListener("visibilitychange", () => {
    if (intervalMs === 0) return;
    if (document.hidden) {
      clearTimeout(timer);
      stopCountdown();
      return;
    }
    if (Date.now() - lastInput > IDLE_MS) {
      stop(IDLE_NOTICE);
      return;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) tick();
    else arm(remaining);
  });
}

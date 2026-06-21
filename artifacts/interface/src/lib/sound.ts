// Tiny UI sound engine. Uses the Web Audio API to synthesize short blips
// at runtime so we don't have to ship any asset files. Three timbres:
//
//   "click"   — soft single blip (60ms). For low-stakes affirmations
//               like "hide", "unhide", tab switches.
//   "confirm" — two-note rising chirp (~120ms). For high-stakes /
//               dopamine-bearing actions: send chat, execute a
//               recommendation, create an action, enter the terminal.
//   "soft"    — even quieter click for noisy taps.
//
// All sounds can be silenced via a `bunny:sound-muted` localStorage
// toggle so we can wire a mute control later without code changes here.

type Sound = "click" | "confirm" | "soft";

let ctx: AudioContext | null = null;
let unlocked = false;

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return null;
    try {
      ctx = new Ctor();
    } catch {
      return null;
    }
  }
  return ctx;
}

// Most browsers require a user gesture before AudioContext makes noise.
// Wire a one-shot resume on the first pointer/keydown so the very first
// playSound() call after page load actually plays.
function ensureUnlocked(): void {
  if (unlocked || typeof window === "undefined") return;
  const ac = getCtx();
  if (!ac) return;
  const resume = () => {
    if (ac.state === "suspended") void ac.resume();
    unlocked = true;
    window.removeEventListener("pointerdown", resume);
    window.removeEventListener("keydown", resume);
  };
  window.addEventListener("pointerdown", resume, { once: true });
  window.addEventListener("keydown", resume, { once: true });
}

if (typeof window !== "undefined") ensureUnlocked();

function isMuted(): boolean {
  try {
    if (typeof window === "undefined") return false;
    if (window.localStorage.getItem("bunny:sound-muted") === "1") return true;
    return false;
  } catch {
    return false;
  }
}

function blip(
  ac: AudioContext,
  freq: number,
  durationMs: number,
  startOffsetMs: number,
  peakGain: number,
  type: OscillatorType = "sine",
): void {
  const now = ac.currentTime + startOffsetMs / 1000;
  const end = now + durationMs / 1000;
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, now);
  // Quick attack, exponential-ish decay. Setting to 0 with exponentialRamp
  // throws, so end at a very small positive value.
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.linearRampToValueAtTime(peakGain, now + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, end);
  osc.connect(gain);
  gain.connect(ac.destination);
  osc.start(now);
  osc.stop(end + 0.02);
}

// When a component plays its own deliberate sound for a gesture (e.g. the
// "confirm" chirp on send), we record the moment so the global button-sound
// fallback below can tell a click was already voiced and skip it — otherwise
// those buttons would play their sound PLUS the generic click.
let explicitUntil = 0;
const EXPLICIT_WINDOW_MS = 80;

// Mark that a deliberate sound just played for the current gesture, suppressing
// the global button fallback. `playSound` calls this itself; the separate
// `useClickSound` hook (its own AudioContext) calls it directly.
export function noteExplicitSound(): void {
  explicitUntil = Date.now() + EXPLICIT_WINDOW_MS;
}

// Play a tone WITHOUT touching the explicit-sound suppression window. Both the
// public `playSound` (which marks) and the global button fallback (which must
// NOT mark, or a rapid second click elsewhere would be wrongly suppressed) use
// this.
function emit(kind: Sound): void {
  if (isMuted()) return;
  const ac = getCtx();
  if (!ac) return;
  // If still locked, the resume listener above will fire on this same
  // gesture; the scheduled tones below will play once it transitions.
  if (ac.state === "suspended") void ac.resume();

  switch (kind) {
    case "confirm":
      // Two-note rising chirp. C5 → E5-ish. Triangle wave gives a
      // slightly warmer, "satisfying" timbre than a pure sine.
      blip(ac, 523.25, 70, 0, 0.08, "triangle");
      blip(ac, 783.99, 90, 55, 0.07, "triangle");
      return;
    case "soft":
      blip(ac, 660, 35, 0, 0.025, "sine");
      return;
    case "click":
    default:
      blip(ac, 880, 50, 0, 0.05, "sine");
      return;
  }
}

// Public entry: a deliberate, component-triggered sound. Marks the suppression
// window so the global button fallback below won't also fire for this gesture.
export function playSound(kind: Sound = "click"): void {
  noteExplicitSound();
  emit(kind);
}

// Install a single document-level listener so EVERY button makes a sound,
// including the many raw <button> elements that don't call playSound directly.
// It runs in the bubble phase, i.e. AFTER React's own onClick handlers, so any
// component that already voiced a deliberate sound (which marks `explicitUntil`)
// suppresses the generic click here and we don't double up. It plays via `emit`
// (NOT `playSound`) so it never marks the window itself — otherwise a rapid
// second click on another button would be wrongly muted.
//
// Opt a button out with `data-sound="off"`. Disabled buttons are skipped.
//
// The installed flag lives on `window`, not in a module variable, so Vite HMR
// reloading this module can't stack a second listener (and double every click).
const INSTALL_KEY = "__bunnyButtonSoundsInstalled";
export function installButtonSounds(): void {
  if (typeof document === "undefined" || typeof window === "undefined") return;
  const w = window as unknown as Record<string, boolean | undefined>;
  if (w[INSTALL_KEY]) return;
  w[INSTALL_KEY] = true;
  document.addEventListener(
    "click",
    (e) => {
      const start = e.target as Element | null;
      if (!start || typeof start.closest !== "function") return;
      const btn = start.closest<HTMLElement>(
        "button, [role='button'], a[role='button']",
      );
      if (!btn) return;
      if (
        (btn as HTMLButtonElement).disabled ||
        btn.getAttribute("aria-disabled") === "true" ||
        btn.dataset["sound"] === "off"
      ) {
        return;
      }
      // A component already voiced this gesture (e.g. a "confirm" chirp).
      if (Date.now() < explicitUntil) return;
      emit("click");
    },
    false,
  );
}

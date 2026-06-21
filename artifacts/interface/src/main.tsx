import { Buffer } from "buffer";
import { createRoot } from "react-dom/client";
import App from "./App";
import { LanguageProvider } from "./i18n";
import { installButtonSounds } from "./lib/sound";
import { ThemeProvider } from "./theme";
import "./index.css";

// @react-pdf/renderer (pdfkit/fontkit) expects Node's global Buffer, which the
// browser doesn't provide — without this polyfill PDF report generation throws
// "Buffer is not defined".
if (typeof globalThis.Buffer === "undefined") {
  globalThis.Buffer = Buffer;
}

// Aborting an in-flight fetch (SSE streams torn down on navigation, unmount, or
// an API-server restart) rejects with a DOMException named "AbortError". A
// DOMException is NOT `instanceof Error`, so when such a rejection slips past a
// stream's own catch it surfaces to `window` as an uncaught non-Error value and
// trips the full-page runtime-error overlay. These aborts are benign — swallow
// only them, leaving every real error untouched.
function isBenignAbort(reason: unknown): boolean {
  return (
    (reason instanceof DOMException && reason.name === "AbortError") ||
    (typeof reason === "object" &&
      reason !== null &&
      (reason as { name?: unknown }).name === "AbortError")
  );
}

// Mirrors the `error` handler below. Two benign shapes reach here:
//   1. A recognizable AbortError value on `e.reason`.
//   2. A rejection with NO reason attached (`e.reason == null`) — a torn-down
//      fetch/abort (e.g. an API-server restart killing an open stream) can
//      reject with `undefined`/`null`, which a dev runtime-error overlay reports as
//      "(unknown runtime error)" with an empty stack / "the error was not an
//      error object". This stays narrow: a thrown string or object literal is a
//      non-null non-Error value and is left untouched so real bugs still surface.
window.addEventListener("unhandledrejection", (e) => {
  if (isBenignAbort(e.reason) || e.reason == null) e.preventDefault();
});

// Some aborts surface to `window` as an uncaught `error` event rather than an
// unhandledrejection. Two benign shapes reach here:
//   1. A recognizable AbortError value on `e.error`.
//   2. An `error` event with NO error object attached (`e.error` is null) — this
//      is how a torn-down fetch/abort (e.g. an API-server restart killing an
//      open stream), a "ResizeObserver loop" notification, and cross-origin
//      "Script error." all surface. A dev runtime-error overlay reports
//      these as "(unknown runtime error)" / "the error was not an error object".
// Genuine app bugs (TypeError, React render errors, thrown Errors) always carry
// a real Error on `e.error`, so swallowing only the no-error-object case stays
// narrow and never masks a real failure.
window.addEventListener("error", (e) => {
  if (isBenignAbort(e.error) || e.error == null) e.preventDefault();
});

// Give every button a click sound (delegated, so raw <button> tags are covered
// too). Components that voice their own sound suppress this one.
installButtonSounds();

createRoot(document.getElementById("root")!).render(
  <ThemeProvider>
    <LanguageProvider>
      <App />
    </LanguageProvider>
  </ThemeProvider>,
);

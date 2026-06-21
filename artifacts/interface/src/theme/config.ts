export const THEMES = ["light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

// Persisted user choice. Read once before React mounts by the inline boot
// script in index.html (to avoid a light/dark flash), and again by the
// ThemeProvider on mount.
export const THEME_STORAGE_KEY = "bunny.theme";

export function isTheme(v: unknown): v is Theme {
  return typeof v === "string" && (THEMES as readonly string[]).includes(v);
}

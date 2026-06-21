import { createContext, useContext } from "react";
import type { Theme } from "./config";

export interface ThemeContextValue {
  theme: Theme;
  setTheme: (t: Theme) => void;
  toggleTheme: () => void;
}

// Created in its own module (no provider, no side effects) so its identity is
// stable across HMR — mirrors the i18n LangContext split. If this lived next to
// the provider, editing the provider would hot-replace this module and mint a
// NEW context object, making already-mounted consumers throw "useTheme must be
// used within ThemeProvider".
export const ThemeContext = createContext<ThemeContextValue | null>(null);

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}

import { useCallback } from 'react';
// User preferences: UI language + light/dark theme. Persisted to localStorage and
// applied to <html> (the `dark` class drives Tailwind's `dark:` variants, which are
// already written throughout the app). Kept separate from the data store on purpose.
import { create } from "zustand";
import { translate, type Lang } from "./i18n";

export type Theme = "light" | "dark";

const LANG_KEY = "tp-lang";
const THEME_KEY = "tp-theme";

function initialLang(): Lang {
  const saved = localStorage.getItem(LANG_KEY);
  if (saved === "zh" || saved === "en" || saved === "ja") return saved;
  // Guess from the browser once; default to English otherwise.
  const nav = navigator.language.toLowerCase();
  if (nav.startsWith("zh")) return "zh";
  if (nav.startsWith("ja")) return "ja";
  return "en";
}

function initialTheme(): Theme {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle("dark", theme === "dark");
}

interface PrefsState {
  lang: Lang;
  theme: Theme;
  setLang: (lang: Lang) => void;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
}

export const usePrefs = create<PrefsState>((set, get) => {
  const lang = initialLang();
  const theme = initialTheme();
  applyTheme(theme); // apply on store creation (import time) to avoid a flash

  return {
    lang,
    theme,
    setLang: (lang) => {
      localStorage.setItem(LANG_KEY, lang);
      set({ lang });
    },
    setTheme: (theme) => {
      localStorage.setItem(THEME_KEY, theme);
      applyTheme(theme);
      set({ theme });
    },
    toggleTheme: () => get().setTheme(get().theme === "dark" ? "light" : "dark"),
  };
});

// Translation hook: re-renders components when the language changes.
export function useT(): (key: string, vars?: Record<string, string | number>) => string {
  const lang = usePrefs((s) => s.lang);
  return useCallback((key: string, vars?: Record<string, string | number>) => translate(key, lang, vars), [lang]);
}

/**
 * 在 React 之外取文案（store 里拼给人看的字串时要用）。
 *
 * 用它拼出来的文字**不会**在切语言时自己更新——所以凡是用了它的地方，
 * 都必须有人在语言变了之后重新拼一遍。见 Workspace 里跟着 lang 重载产物那一处。
 */
export const tOutsideReact = (key: string, vars?: Record<string, string | number>): string =>
  translate(key, usePrefs.getState().lang, vars);

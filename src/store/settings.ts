/**
 * Application settings plus the side effects that follow from them (theme class,
 * CSS variables for fonts).
 */

import { create } from "zustand";

import { applyAccent } from "@/features/settings/accent";
import ipc from "@/lib/ipc";
import { type AppSettings, defaultSettings } from "@/lib/types";

const THEME_KEY = "opencat.theme";

/** Apply the theme to `<html>` and remember it for the pre-paint script. */
export function applyTheme(theme: AppSettings["theme"]) {
  const prefersDark =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches;
  const dark = theme === "dark" || (theme === "system" && prefersDark);
  document.documentElement.classList.toggle("dark", dark);
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* storage can be unavailable; the in-memory setting still applies */
  }
}

/** Push font sizes onto the document so Tailwind classes can inherit them. */
function applyTypography(settings: AppSettings) {
  const root = document.documentElement;
  root.style.setProperty("--ui-font-size", `${settings.uiFontSize}px`);
  root.style.setProperty("--editor-font-size", `${settings.editorFontSize}px`);
  if (settings.uiFontFamily) {
    root.style.setProperty("--ui-font-family", settings.uiFontFamily);
  } else {
    root.style.removeProperty("--ui-font-family");
  }
  if (settings.editorFontFamily) {
    root.style.setProperty("--editor-font-family", settings.editorFontFamily);
  }
  applyAccent(settings.accent);
}

interface SettingsState {
  settings: AppSettings;
  loaded: boolean;
  error: string | null;
  load: () => Promise<void>;
  /** Merge a patch locally and persist it (debounced by the caller if needed). */
  update: (patch: Partial<AppSettings>) => Promise<void>;
  /** Reset to defaults and persist. */
  reset: () => Promise<void>;
}

export const useSettings = create<SettingsState>((set, get) => ({
  settings: defaultSettings(),
  loaded: false,
  error: null,

  load: async () => {
    try {
      const settings = await ipc.app.getSettings();
      applyTheme(settings.theme);
      applyTypography(settings);
      set({ settings, loaded: true, error: null });
    } catch (error) {
      // A failed load must not brick the app: fall back to defaults.
      const settings = defaultSettings();
      applyTheme(settings.theme);
      set({
        settings,
        loaded: true,
        error: (error as { message?: string })?.message ?? "could not load settings",
      });
    }
  },

  update: async (patch) => {
    const next = { ...get().settings, ...patch };
    // Apply immediately so the UI feels instant, then persist.
    if (patch.theme) applyTheme(next.theme);
    applyTypography(next);
    set({ settings: next });
    try {
      const stored = await ipc.app.saveSettings(next);
      set({ settings: stored, error: null });
    } catch (error) {
      set({ error: (error as { message?: string })?.message ?? "could not save settings" });
    }
  },

  reset: async () => {
    await get().update(defaultSettings());
  },
}));

/** React to OS theme changes while the preference is "system". */
export function watchSystemTheme() {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const handler = () => {
    if (useSettings.getState().settings.theme === "system") {
      applyTheme("system");
    }
  };
  media.addEventListener("change", handler);
  return () => media.removeEventListener("change", handler);
}

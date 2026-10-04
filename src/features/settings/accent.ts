/**
 * Accent palettes.
 *
 * `AppSettings.accent` stores a name ("violet"), while the design tokens want
 * three CSS custom properties, so the mapping between the two lives here. The
 * variables are written onto `<html>` — the same element the theme class lands
 * on — which is what lets a swatch preview immediately instead of after the
 * settings round trip.
 */

export interface AccentSwatch {
  id: string;
  label: string;
  accent: string;
  hover: string;
}

export const ACCENTS: AccentSwatch[] = [
  { id: "violet", label: "Violet", accent: "#7c3aed", hover: "#6d28d9" },
  { id: "blue", label: "Blue", accent: "#2563eb", hover: "#1d4ed8" },
  { id: "cyan", label: "Cyan", accent: "#0891b2", hover: "#0e7490" },
  { id: "emerald", label: "Emerald", accent: "#059669", hover: "#047857" },
  { id: "amber", label: "Amber", accent: "#d97706", hover: "#b45309" },
  { id: "rose", label: "Rose", accent: "#e11d48", hover: "#be123c" },
  { id: "slate", label: "Slate", accent: "#475569", hover: "#334155" },
];

/** The colour to paint a swatch with, tolerating a raw hex value in settings. */
export function accentColor(id: string): string {
  return ACCENTS.find((candidate) => candidate.id === id)?.accent ?? id;
}

/**
 * Push an accent onto the document.
 *
 * `--accent-soft` is derived with `color-mix` against `--surface` rather than
 * hard-coded, because the token has to be a pale tint in the light theme and a
 * dark wash in the dark one.
 */
export function applyAccent(id: string): void {
  const root = document.documentElement;
  const swatch = ACCENTS.find((candidate) => candidate.id === id);
  const accent = swatch?.accent ?? (/^(#|rgb|hsl)/i.test(id) ? id : null);
  if (!accent) return;
  root.style.setProperty("--accent", accent);
  root.style.setProperty("--accent-hover", swatch?.hover ?? accent);
  root.style.setProperty(
    "--accent-soft",
    `color-mix(in oklab, ${accent} 18%, var(--surface))`,
  );
}

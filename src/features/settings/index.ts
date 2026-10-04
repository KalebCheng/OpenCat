/**
 * Settings feature surface.
 *
 * The dialog is the only component the shell mounts; the accent palette is
 * exported too, because the shell (or the settings store) has to re-apply it at
 * boot — the dialog may never be opened in a session.
 */

export { SettingsDialog, type SettingsDialogProps } from "./SettingsDialog";
export { ACCENTS, applyAccent, accentColor, type AccentSwatch } from "./accent";

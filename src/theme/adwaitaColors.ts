/*
 * adwaitaColors — the Adwaita / app design-language color tables, kept in their own
 * module so both the theme model (`theme.ts`) and the resolver (`cssColor.ts`) can read
 * them without an import cycle (`theme.ts → cssColor.ts → adwaitaColors.ts`). `cssColor.ts`
 * is the *mechanism* that maps a CSS-variable name to a value, reading the two tables here;
 * CSS itself reads the variables natively and needs neither. Self-contained scaffolding for
 * the Adwaita styling migration (see STYLING-PLAN.md). Re-exported from `theme.ts`, which
 * stays the public entry point for these tokens.
 */

/** Light/dark color scheme — the key into the Adwaita / app color tables below. */
export type Scheme = 'light' | 'dark';

/**
 * App-owned semantic colors with no libadwaita equivalent — `info` and `hint`
 * (used by diagnostics: info-circle, lightbulb). Reified as first-class tokens
 * shaped like Adwaita's semantic sets: a `-color` (standalone, on neutral bg),
 * `-bg-color` (fill), and `-fg-color` (text on the fill). Keyed by CSS-variable
 * name so the same map drives `lookupCSSColor` and the emitted CSS variables
 * (see `appColorVariables`). Values track the Adwaita palette per scheme — the
 * standalone color lightens on dark / darkens on light, like Adwaita's own.
 */
export const APP_COLORS: Record<string, Record<Scheme, string>> = {
  '--info-color': { dark: '#78aeff', light: '#1565c0' },
  '--info-bg-color': { dark: '#3584e4', light: '#3584e4' },
  '--info-fg-color': { dark: '#ffffff', light: '#ffffff' },
  '--hint-color': { dark: '#7bdff4', light: '#00788c' },
  '--hint-bg-color': { dark: '#218998', light: '#0d96a8' },
  '--hint-fg-color': { dark: '#ffffff', light: '#ffffff' },
};

/**
 * Last-resort concrete values for the libadwaita colors our chrome maps onto, so a
 * no-display run (tests, offscreen snapshots) still gets a sane color when the probe
 * can't resolve. Captured from live libadwaita (poc/adwaita-probe). Not exhaustive —
 * only the names we actually resolve through the bridge.
 */
export const FALLBACK_COLORS: Record<string, Record<Scheme, string>> = {
  '--window-bg-color': { dark: '#222226', light: '#fafafb' },
  '--window-fg-color': { dark: '#ffffff', light: '#000006' },
  '--view-bg-color': { dark: '#1d1d20', light: '#ffffff' },
  '--view-fg-color': { dark: '#ffffff', light: '#000006' },
  '--accent-color': { dark: '#81d0ff', light: '#0461be' },
  '--accent-bg-color': { dark: '#3584e4', light: '#3584e4' },
  '--accent-fg-color': { dark: '#ffffff', light: '#ffffff' },
  '--popover-bg-color': { dark: '#36363a', light: '#ffffff' },
  '--card-bg-color': { dark: '#36363a', light: '#ffffff' },
  '--card-fg-color': { dark: '#ffffff', light: '#000006' },
  '--success-color': { dark: '#78e9ab', light: '#007c3d' },
  '--warning-color': { dark: '#ffc252', light: '#905400' },
  '--error-color': { dark: '#ff938c', light: '#c30000' },
  '--shade-color': { dark: '#00000640', light: '#00000612' },
};

/**
 * The app-color registry (APP_COLORS) as CSS custom-property declarations for the
 * given scheme — one line per entry (`--info-color: #…;`). The CSS-side half of the
 * bridge: emit this on a root widget so CSS consumers can read `var(--info-color)`
 * natively, in lockstep with what `lookupCSSColor` returns for the non-CSS side.
 * Not currently wired into any stylesheet (see STYLING-PLAN.md). Newline-joined.
 */
export function appColorVariables(scheme: Scheme): string {
  return Object.entries(APP_COLORS)
    .map(([name, byScheme]) => `${name}: ${byScheme[scheme]};`)
    .join('\n');
}

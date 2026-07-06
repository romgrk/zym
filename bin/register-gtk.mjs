/*
 * register-gtk.mjs — install node-gtk's `gi:` import hooks, then undo the
 * GSK_RENDERER default node-gtk applies on Linux so zym uses GTK's own renderer
 * choice.
 *
 * node-gtk/register sets `GSK_RENDERER=gl` at registration time when the variable
 * is unset (to dodge a dual-GPU Vulkan wake-up cost — see its own note). zym opts
 * back into GTK's default renderer selection: capture the inherited value, run the
 * register hook, then restore the pre-register state (delete it if it was unset).
 * A GSK_RENDERER the user set themselves is left untouched. Safe because GTK reads
 * the variable lazily at window realization, long after this runs.
 *
 * Used by both zym entry paths (bin/zym.mjs and `pnpm start`). See docs/install.md.
 */
const inherited = process.env.GSK_RENDERER;

await import('node-gtk/register');

if (inherited === undefined) delete process.env.GSK_RENDERER;
else process.env.GSK_RENDERER = inherited;

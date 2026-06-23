/*
 * createSourceScheme — materialize a GtkSource.StyleScheme from a Theme's UI and
 * syntax colors. GtkSourceView paints the editor background and the line-number
 * gutter only from the active style scheme (not CSS), so applying those theme
 * colors requires a real scheme rather than a stylesheet override. We write a
 * small scheme XML into a temp dir on the StyleSchemeManager's search path and
 * load it back by id. The search dir lives under the XDG cache (reused across launches and
 * shared by concurrent instances, which write identical content) so it never accumulates.
 * The result is memoized by Theme identity — every editor open requests the scheme, but only
 * the first does disk I/O + a manager rescan; a future live theme-swap (a new Theme object)
 * naturally misses the cache and regenerates.
 *
 * The scheme also maps GtkSourceView's standard `def:` styles onto the theme's
 * syntax palette, so the `.lang` fallback engine (used for languages without a
 * tree-sitter grammar) matches the tree-sitter colors. Tree-sitter tags are
 * applied separately by SyntaxController and layer on top.
 */
import * as Fs from 'node:fs';
import * as Os from 'node:os';
import * as Path from 'node:path';
import { GtkSource } from '../gi.ts';
import type { Theme } from './theme.ts';

type StyleScheme = InstanceType<typeof GtkSource.StyleScheme>;

// GtkSourceView `def:` style → theme syntax capture name.
const DEF_STYLES: Array<[def: string, capture: string]> = [
  ['def:comment', 'comment'],
  ['def:constant', 'constant'],
  ['def:string', 'string'],
  ['def:special-char', 'string.escape'],
  ['def:number', 'number'],
  ['def:floating-point', 'number'],
  ['def:decimal', 'number'],
  ['def:base-n-integer', 'number'],
  ['def:boolean', 'boolean'],
  ['def:keyword', 'keyword'],
  ['def:statement', 'keyword'],
  ['def:preprocessor', 'keyword'],
  ['def:operator', 'operator'],
  ['def:type', 'type'],
  ['def:builtin', 'constant.builtin'],
  ['def:function', 'function'],
];

let searchDir: string | null = null;
let cached: { theme: Theme; scheme: StyleScheme } | null = null;

/** Build and load a GtkSource.StyleScheme for `theme` (its concrete editor background +
 *  syntax colors). Only meaningful when `!theme.followSystemScheme`. Memoized by Theme
 *  identity, so repeated editor opens are a pointer compare rather than a disk write + rescan. */
export function createSourceScheme(theme: Theme): StyleScheme {
  if (cached && cached.theme === theme) return cached.scheme;

  const manager = GtkSource.StyleSchemeManager.getDefault();
  if (searchDir === null) {
    const base = process.env.XDG_CACHE_HOME ?? Path.join(Os.homedir(), '.cache');
    searchDir = Path.join(base, 'zym', 'schemes');
    manager.appendSearchPath(searchDir);
  }

  const id = `zym-${theme.name}`;
  Fs.mkdirSync(searchDir, { recursive: true }); // self-heal if the cache dir was removed mid-session
  Fs.writeFileSync(Path.join(searchDir, `${id}.xml`), schemeXml(id, theme));
  manager.forceRescan();

  const scheme = manager.getScheme(id);
  if (!scheme) throw new Error(`failed to load generated scheme "${id}"`);
  cached = { theme, scheme };
  return scheme;
}

function schemeXml(id: string, theme: Theme): string {
  const { ui, syntax } = theme;
  const styles = [
    // GtkSourceAnnotation colors come from these scheme styles: AnnotationStyle.ERROR
    // uses diff:removed-line fg, WARNING uses diff:changed-line fg, ACCENT uses
    // diff:added-line fg (see GtkSource docs). Define them so error-lens annotations
    // are colored by severity. (We don't otherwise render diffs through the scheme.)
    `<style name="diff:removed-line" foreground="${ui.status.error}"/>`,
    `<style name="diff:changed-line" foreground="${ui.status.warning}"/>`,
    `<style name="diff:added-line" foreground="${ui.status.info}"/>`,
  ];
  for (const [def, capture] of DEF_STYLES) {
    const color = syntax[capture];
    if (color) styles.push(`<style name="${def}" foreground="${color}"/>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<style-scheme id="${id}" name="${theme.name}" version="1.0">
  ${styles.join('\n  ')}
</style-scheme>
`;
}

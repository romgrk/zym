/*
 * highlightTags — the syntax-highlight TextTag vocabulary for one buffer, built
 * from the active theme: one foreground-color tag per capture name that resolves
 * to a color, plus shared *decoration* tags (bold/italic/underline/strikethrough,
 * one per distinct scale, one per distinct text-background, one per distinct
 * full-line background). The decorations are applied additively on top of color
 * so styles stack (nested bold+italic, a code background under recolored tokens,
 * a heading scale over inline code) — something one GtkTextTag priority couldn't
 * express.
 *
 * `paint` maps a gathered capture list to these tags through the pure
 * `computeStyleRuns` sweep (foreground = innermost wins with suppression;
 * background/scale = innermost-that-has-one; bold/italic/… additive — see
 * highlightRuns.ts) and applies them over the buffer.
 *
 * Tag priority follows creation order, so the owner must build this BEFORE any
 * other tags it layers on top (bracket-match, fold placeholders).
 */
import { Gtk, Pango } from '../gi.ts';
import { theme, type SyntaxStyle, resolveSyntaxColor, resolveSyntaxStyle, resolveByCaptureName } from '../theme/theme.ts';
import { computeStyleRuns, type StyleSpan } from './highlightRuns.ts';
import type { RawCapture } from './injection.ts';

export class HighlightTags {
  // Foreground-color tags, one per capture name that resolves to a color.
  private readonly color = new Map<string, any>();
  // Decoration tags applied additively on top of color. Boolean attrs share one
  // tag each; valued attrs (scale/background) get one tag per distinct value.
  private readonly bold: any;
  private readonly italic: any;
  private readonly underline: any;
  private readonly strike: any;
  private readonly scale = new Map<number, any>();
  private readonly background = new Map<string, any>();
  private readonly lineBackground = new Map<string, any>();
  // Every tag above, for clearing a range in one pass.
  private readonly all: any[];
  // Memoized capture-name → color-tag / style (longest-prefix fallback); capture
  // names are a small fixed set, so this amortizes the per-capture string work.
  private readonly tagCache = new Map<string, any>();
  private readonly styleCache = new Map<string, SyntaxStyle | null>();

  /** Build the highlight tags into `table` (the buffer's GtkTextTagTable), in
   *  theme order so tag priority is deterministic. */
  constructor(table: any) {
    const mk = (props: Record<string, unknown>) => { const t = new Gtk.TextTag(props); table.add(t); return t; };

    // Foreground-color tags, one per capture name (over the union of colored and
    // styled captures, in theme.syntax order) that resolves to a color.
    const names = new Set([...Object.keys(theme.syntax), ...Object.keys(theme.syntaxStyle)]);
    for (const name of names) {
      const color = resolveSyntaxColor(name);
      if (color) this.color.set(name, mk({ name: `ts:${name}`, foreground: color }));
    }
    // Decoration tags (applied on top of color, additively): shared boolean attrs
    // and one tag per distinct scale/background value in the theme.
    this.bold = mk({ name: 'ts*bold', weight: Pango.Weight.BOLD });
    this.italic = mk({ name: 'ts*italic', style: Pango.Style.ITALIC });
    this.underline = mk({ name: 'ts*underline', underline: Pango.Underline.SINGLE });
    this.strike = mk({ name: 'ts*strikethrough', strikethrough: true });
    for (const style of Object.values(theme.syntaxStyle)) {
      if (style.scale != null && !this.scale.has(style.scale)) {
        this.scale.set(style.scale, mk({ name: `ts*scale:${style.scale}`, scale: style.scale }));
      }
      if (style.background != null && !this.background.has(style.background)) {
        this.background.set(style.background, mk({ name: `ts*bg:${style.background}`, background: style.background }));
      }
      if (style.lineBackground != null && !this.lineBackground.has(style.lineBackground)) {
        this.lineBackground.set(style.lineBackground,
          mk({ name: `ts*linebg:${style.lineBackground}`, paragraphBackground: style.lineBackground }));
      }
    }
    this.all = [
      ...this.color.values(), this.bold, this.italic, this.underline,
      this.strike, ...this.scale.values(), ...this.background.values(), ...this.lineBackground.values(),
    ];
  }

  /**
   * Re-apply token colors from the theme palette. Colors are fixed (not
   * scheme-derived), so this is independent of the Adwaita light/dark chrome; the
   * window calls it (via SyntaxController.restyle) when the system scheme changes.
   */
  restyle(): void {
    for (const [name, tag] of this.color) {
      const color = resolveSyntaxColor(name);
      if (color) tag.foreground = color;
    }
  }

  /** Remove every highlight tag over `[from, to)`. */
  clear(buffer: any, from: any, to: any): void {
    for (const tag of this.all) buffer.removeTag(tag, from, to);
  }

  /**
   * Paint highlight tags from a gathered capture list. Each capture becomes a
   * `StyleSpan` carrying its resolved color tag plus decoration values; the pure
   * `computeStyleRuns` flattens overlaps into runs, and we stack the run's tags
   * over its range (`iterAt` maps a tree-sitter row/col to a buffer iter). So a
   * fenced code background shows under recolored tokens and nested bold+italic
   * both apply.
   */
  paint(buffer: any, raws: RawCapture[], iterAt: (row: number, col: number) => any): void {
    const posAt = new Map<number, { row: number; col: number }>();
    const spans: StyleSpan<any>[] = [];
    let idx = 0;
    for (const raw of raws) {
      if (raw.start === raw.end) continue; // zero-width capture paints nothing
      if (!posAt.has(raw.start)) posAt.set(raw.start, { row: raw.sRow, col: raw.sCol });
      if (!posAt.has(raw.end)) posAt.set(raw.end, { row: raw.eRow, col: raw.eCol });
      const style = this.styleFor(raw.name);
      spans.push({
        start: raw.start, end: raw.end, idx: idx++,
        color: this.tagFor(raw.name),
        background: style?.background != null ? this.background.get(style.background) ?? null : null,
        lineBackground: style?.lineBackground != null ? this.lineBackground.get(style.lineBackground) ?? null : null,
        scale: style?.scale ?? null,
        bold: !!style?.bold, italic: !!style?.italic,
        underline: !!style?.underline, strikethrough: !!style?.strikethrough,
      });
    }
    if (spans.length === 0) return;

    for (const run of computeStyleRuns(spans)) {
      const a = posAt.get(run.start)!;
      const b = posAt.get(run.end)!;
      const from = iterAt(a.row, a.col);
      const to = iterAt(b.row, b.col);
      if (run.lineBackground) buffer.applyTag(run.lineBackground, from, to);
      if (run.color) buffer.applyTag(run.color, from, to);
      if (run.background) buffer.applyTag(run.background, from, to);
      if (run.scale !== null) {
        const t = this.scale.get(run.scale);
        if (t) buffer.applyTag(t, from, to);
      }
      if (run.bold) buffer.applyTag(this.bold, from, to);
      if (run.italic) buffer.applyTag(this.italic, from, to);
      if (run.underline) buffer.applyTag(this.underline, from, to);
      if (run.strikethrough) buffer.applyTag(this.strike, from, to);
    }
  }

  /**
   * Map a tree-sitter capture name to its color TextTag by longest-prefix fallback
   * (`function.method` → `function`); null — and cached — when no prefix has a
   * configured color, so `@variable`/`@operator` stay the default foreground.
   */
  private tagFor(name: string): any {
    const cached = this.tagCache.get(name);
    if (cached !== undefined) return cached;
    const tag = resolveByCaptureName(name, (key) => this.color.get(key)) ?? null;
    this.tagCache.set(name, tag);
    return tag;
  }

  /** A capture's font style, by longest-prefix fallback; memoized. */
  private styleFor(name: string): SyntaxStyle | null {
    const cached = this.styleCache.get(name);
    if (cached !== undefined) return cached;
    const style = resolveSyntaxStyle(name) ?? null;
    this.styleCache.set(name, style);
    return style;
  }
}

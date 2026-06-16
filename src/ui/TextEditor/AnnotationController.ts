/*
 * AnnotationController — a per-view wrapper over GtkSourceView's native annotation API
 * (`GtkSourceAnnotations`, 5.18+): end-of-line trailing virtual text, styled
 * none/warning/error/accent, with optional hover.
 *
 * This is one of the capabilities the A2 document-model unblocked: annotations live on
 * a *buffer*, so a shared buffer would render them in every view — with per-view buffers
 * each view annotates independently and natively (no custom overlay). Producers (error
 * lens, git blame, end-of-line inlay hints) push a flat list; the controller re-syncs
 * the underlying `GtkSourceAnnotationProvider`.
 *
 * Line-anchored, end-of-line only (the native API's shape). Mid-line / above-line
 * virtual content wants the gap-tag + overlay recipe instead — see
 * tasks/code-editing/virtual-lines.md.
 */
import { GtkSource, type SourceView } from '../../gi.ts';

export type AnnotationStyleName = 'none' | 'warning' | 'error' | 'accent';

export interface ViewAnnotation {
  /** Buffer row (0-based) to trail the text after. */
  line: number;
  /** The trailing text. */
  text: string;
  /** Severity-ish styling (default `none`). */
  style?: AnnotationStyleName;
}

const STYLE_ENUM: Record<AnnotationStyleName, number> = {
  none: (GtkSource as any).AnnotationStyle.NONE,
  warning: (GtkSource as any).AnnotationStyle.WARNING,
  error: (GtkSource as any).AnnotationStyle.ERROR,
  accent: (GtkSource as any).AnnotationStyle.ACCENT,
};

export class AnnotationController {
  private readonly provider: any;
  private readonly annotations: any;
  private added = false;

  constructor(view: SourceView) {
    this.provider = new (GtkSource as any).AnnotationProvider();
    this.annotations = (view as any).getAnnotations();
  }

  /** Replace the whole annotation set (producers recompute their full list per update).
   *  The provider is re-added to the view each time: registering a *populated* provider
   *  is the render path proven in the POC; mutating an already-registered one didn't
   *  repaint in-app. Cheap for the modest counts here (one per diagnostic line). */
  setAnnotations(items: ViewAnnotation[]): void {
    if (this.added) {
      this.annotations.removeProvider(this.provider);
      this.added = false;
    }
    this.provider.removeAll();
    for (const item of items) {
      const style = STYLE_ENUM[item.style ?? 'none'];
      // GtkSource.Annotation.new(description, icon, line, style)
      this.provider.addAnnotation((GtkSource as any).Annotation.new(item.text, null, item.line, style));
    }
    if (items.length) {
      this.annotations.addProvider(this.provider);
      this.added = true;
    }
  }

  clear(): void {
    this.setAnnotations([]);
  }

  dispose(): void {
    this.provider.removeAll();
    if (this.added) this.annotations.removeProvider(this.provider);
  }
}

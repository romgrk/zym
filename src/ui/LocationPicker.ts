/*
 * LocationPicker — a generic "pick a place in the codebase and jump to it"
 * picker. It's a thin layer over `openPicker` that adds two things every
 * location-style picker wants: a horizontal-split source preview of the selected
 * row (the file, syntax-highlighted, scrolled to the target line) and a uniform
 * "choose → jump" path. Callers supply the candidate source (`items`/`fetch`),
 * the row rendering (`formatMain`), and two small adapters:
 *
 *   - `locate(item)` → the file `PickerLocation` a row points at (used both for
 *     the preview and the jump), or null if the row has none.
 *   - `onJump(location)` → open/reveal that location.
 *
 * The workspace-symbol picker and the ripgrep search picker are both built on it.
 */
import * as Fs from 'node:fs';
import { Gtk } from '../gi.ts';
import { addStyles } from '../styles.ts';
import { openPicker, type PickerItem, type PickerOptions } from './Picker.ts';
import { TextEditor } from './TextEditor/TextEditor.ts';

type Overlay = InstanceType<typeof Gtk.Overlay>;

/** A file position to preview and jump to. Both `line` and `column` are 0-based. */
export interface PickerLocation {
  path: string;
  line: number;
  column: number;
  /**
   * Optional end column on `line`; when set, the `[column, endColumn)` span (e.g.
   * the matched text or the symbol name) is highlighted in the preview.
   */
  endColumn?: number;
}

export interface LocationPickerOptions {
  host: Overlay;
  placeholder?: string;
  promptIcon?: string;
  /** Server-side-filtered source (e.g. rg / LSP): show results in order, no local refine. */
  localFilter?: boolean;
  proseEntry?: boolean;
  searchDelay?: number;
  frecency?: string;
  /**
   * Show the source-preview pane (default true). Set false when the target is the
   * file already on screen behind the picker (e.g. the document-symbol picker),
   * so the preview would just duplicate it.
   */
  preview?: boolean;
  items?: Array<string | PickerItem>;
  fetch?: PickerOptions['fetch'];
  formatMain?: PickerOptions['formatMain'];
  /** The file location a row points at — drives both the preview and the jump. */
  locate: (item: PickerItem) => PickerLocation | null;
  /** Open/reveal the chosen location (e.g. open the file and move the cursor). */
  onJump: (location: PickerLocation) => void;
}

addStyles(`
  #PickerPreview {
    border-left: 1px solid var(--border-color);
  }
`);

export function openLocationPicker(options: LocationPickerOptions): void {
  const preview = options.preview === false ? null : createSourcePreview();
  openPicker({
    host: options.host,
    placeholder: options.placeholder,
    promptIcon: options.promptIcon,
    localFilter: options.localFilter,
    proseEntry: options.proseEntry,
    searchDelay: options.searchDelay,
    frecency: options.frecency,
    items: options.items,
    fetch: options.fetch,
    formatMain: options.formatMain,
    preview: preview
      ? {
          widget: preview.root,
          update: (item) => preview.show(item ? options.locate(item) : null),
        }
      : undefined,
    onSelect: (_value, item) => {
      const location = options.locate(item);
      if (location) options.onJump(location);
    },
  });
}

/**
 * A reusable source-preview pane: a read-only, syntax-highlighted `TextEditor`.
 * `show` loads the file once per distinct path (re-reading only when the path
 * changes, since consecutive matches often share a file) and reveals the target
 * line; `null` clears it.
 */
function createSourcePreview(): {
  root: InstanceType<typeof Gtk.Box>;
  show: (location: PickerLocation | null) => void;
} {
  const root = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 0 });
  root.setName('PickerPreview');

  const editor = new TextEditor({ buffer: { readOnly: true, initialText: '', folding: false } });
  editor.root.setVexpand(true);
  // Never let a click in the preview steal focus from the entry (which would
  // dismiss the picker); the pane is for viewing only.
  editor.sourceView.setCanFocus(false);
  // Mark the target line, and (when we know the span) the match within it.
  editor.sourceView.setHighlightCurrentLine(true);
  const matchLayer = editor.decorations.layer('picker-match');
  root.append(editor.root);

  let currentPath: string | null = null;

  const show = (location: PickerLocation | null) => {
    matchLayer.clear();
    if (!location) {
      if (currentPath !== null) {
        editor.setText('');
        currentPath = null;
      }
      return;
    }
    if (location.path !== currentPath) {
      let content = '';
      try {
        content = Fs.readFileSync(location.path, 'utf8');
      } catch {
        content = '';
      }
      editor.setText(content);
      editor.setLanguageForPath(location.path);
      currentPath = location.path;
    }
    editor.restoreCursor([location.line, location.column]);
    if (location.endColumn != null && location.endColumn > location.column) {
      matchLayer.decorate(
        { start: { row: location.line, column: location.column }, end: { row: location.line, column: location.endColumn } },
        'highlight-strong',
      );
    }
  };

  return { root, show };
}

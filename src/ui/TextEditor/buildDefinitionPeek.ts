/*
 * buildDefinitionPeek — the card shown by the see-definition inline peek: a header
 * (file:line + close button) over a read-only, syntax-highlighted slice of the
 * definition's file. Lives in the editor's sibling overlay via `editor.showPeek`
 * (Peek); the nested editor is focusable there without leaking input to the
 * file behind it.
 */
import * as Path from 'node:path';
import { Gdk, Gtk } from '../../gi.ts';
import { theme } from '../../theme/theme.ts';
import { addStyles } from '../../styles.ts';
import { CompositeDisposable } from '../../util/eventKit.ts';
import { TextEditor, INPUT_PADDING } from './TextEditor.ts';

const PEEK_BG = theme.ui.surface.popover;
const PEEK_MUTED = theme.ui.text.muted;

addStyles(`
  .peek-card {
    background-color: ${PEEK_BG};
    border: 1px solid var(--border-color);
    border-radius: 6px;
    box-shadow: 0 1px 4px alpha(black, 0.3);
  }
  .peek-header {
    padding: 2px 4px 2px 8px;
    border-bottom: 1px solid var(--border-color);
  }
  .peek-header label { color: ${PEEK_MUTED}; }
  .peek-header button { min-height: 0; min-width: 0; padding: 2px 6px; }
`);

/** How many lines of the definition's file to show (a couple of lead-in lines plus
 *  the body). The nested editor scrolls if the user wants more. */
const LEAD = 2;
const SPAN = 18;

export interface DefinitionTarget {
  path: string;
  point: { row: number; column: number };
}

/** Px height for the live peek (a fixed window of `SPAN` lines around the def). */
export const LIVE_PEEK_HEIGHT = 30 + SPAN * 20;

/** Wrap a body widget in the peek card chrome (header `file:line` + × close, Escape to
 *  dismiss). Shared by the snapshot peek and the live (shared-document) peek. */
export function wrapPeekBody(
  target: DefinitionTarget,
  body: InstanceType<typeof Gtk.Widget>,
  height: number,
  onClose: () => void,
): { widget: InstanceType<typeof Gtk.Box>; height: number } {
  const card = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
  card.addCssClass('peek-card');

  // The peek card is built fresh per go-to-definition and dropped when the Peek
  // host removes it from the overlay (Peek.close → removeOverlay). node-gtk roots
  // the key controller's `key-pressed` closure (it captures `onClose`) behind a
  // Global handle, so the controller must be removed before the card is dropped or
  // the whole nested-editor subtree leaks. Funnel its teardown here and fire it on
  // every close route: the user-driven close (button/Escape, which dispose first,
  // then trigger the actual close while the card is still mounted) and the
  // programmatic close (toggle / replace by a new peek), caught via the card's
  // `unmap` when removeOverlay detaches it. Disposal is idempotent, so whichever
  // route runs first wins and the rest are no-ops.
  const disposables = new CompositeDisposable();
  const closePeek = () => { disposables.dispose(); onClose(); };

  // Header: "file:line" on the left, a close button on the right.
  const header = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL });
  header.addCssClass('peek-header');
  const title = new Gtk.Label({ label: `${Path.basename(target.path)}:${target.point.row + 1}`, xalign: 0 });
  title.setHexpand(true);
  header.append(title);
  const close = new Gtk.Button({ label: '✕' });
  close.addCssClass('flat');
  close.on('clicked', closePeek);
  header.append(close);
  card.append(header);

  body.setVexpand(true);
  card.append(body);

  // Escape closes the peek (capture phase, so it fires before the nested editor's
  // vim layer consumes it). Other keys fall through to the nested editor.
  const keys = new Gtk.EventControllerKey();
  keys.setPropagationPhase(Gtk.PropagationPhase.CAPTURE);
  keys.on('key-pressed', (keyval: number) => {
    if (keyval === Gdk.KEY_Escape) { closePeek(); return true; }
    return false;
  });
  disposables.addController(card, keys);

  // Catch the programmatic close paths (toggle / replaced by a new peek) that
  // bypass the button/Escape handlers: removeOverlay unmaps the card, which
  // releases the controller while the card object is still alive.
  disposables.connect(card, 'unmap', () => disposables.dispose());

  return { widget: card, height };
}

/** Build the snapshot peek card: a read-only, highlighted slice of the file's text
 *  (used when the file is NOT open — no live document to share). */
export function buildDefinitionPeek(
  target: DefinitionTarget,
  fileContent: string,
  onClose: () => void,
): { widget: InstanceType<typeof Gtk.Box>; height: number } {
  const lines = fileContent.split('\n');
  const start = Math.max(0, target.point.row - LEAD);
  const end = Math.min(lines.length, start + SPAN);
  const slice = lines.slice(start, end).join('\n');

  const editor = new TextEditor({
    // A gutterless code peek: keep the symmetric inset (the editor's `padding` now defaults to 0)
    // so the slice doesn't hug the popover edges.
    buffer: { readOnly: true, initialText: slice, languagePath: target.path, folding: false },
    padding: INPUT_PADDING,
  });
  return wrapPeekBody(target, editor.root, 30 + (end - start) * 20, onClose);
}

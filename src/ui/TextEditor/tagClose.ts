/*
 * tagClose — auto-close JSX/HTML tags: typing `>` to complete an opening tag
 * inserts the matching `</name>` and leaves the cursor between them.
 *
 * `tagToAutoClose` is pure (text-only) so it's unit-testable; `handleTagAutoClose`
 * wires it to an EditorModel. It's text-based on purpose (the tree is debounced,
 * but auto-close must fire on the keystroke). The tricky case is JSX vs. generics:
 * `<div>` should close, `Array<string>` should not. We use the char before `<` —
 * a tag's `<` is in expression position (preceded by space/`(`/`>`/…), a generic's
 * `<` follows an identifier — plus a tag-language gate so plain `.ts` never closes.
 */
import { Range } from '../../text/Range.ts';
import { Point } from '../../text/Point.ts';
import type { EditorModel } from './EditorModel.ts';

/**
 * The tag name to auto-close given the line text *before* the cursor (where `>`
 * is about to be typed), or null. `''` means a fragment (`<>` → `</>`).
 */
export function tagToAutoClose(before: string): string | null {
  const lt = before.lastIndexOf('<');
  if (lt === -1) return null;
  if (before.indexOf('>', lt) !== -1) return null; // this `<` is already closed
  // A generic's `<` follows an identifier (`Array<…`); a JSX tag's doesn't.
  if (lt > 0 && /\w/.test(before[lt - 1])) return null;
  const content = before.slice(lt + 1);
  if (content === '') return ''; // fragment `<>`
  if (content.startsWith('/')) return null; // a closing tag `</…`
  if (content.endsWith('/')) return null; // self-closing `<br/`
  const m = content.match(/^([A-Za-z][\w.\-:]*)/); // tag name (incl. members/namespaces/custom)
  return m ? m[1] : null; // no valid name (`<3`, `< x`, …) → don't close
}

/** On `>`, complete an opening tag with its close. Returns true when it did. */
export function handleTagAutoClose(editor: EditorModel, ch: string, enabled: boolean): boolean {
  if (!enabled || ch !== '>') return false;
  const pos = editor.getCursorBufferPosition();
  const before = editor.lineTextForBufferRow(pos.row).slice(0, pos.column);
  const name = tagToAutoClose(before);
  if (name === null) return false;
  editor.insertText('>');
  const at = editor.getCursorBufferPosition();
  editor.setTextInBufferRange(new Range(at, at), `</${name}>`);
  editor.setCursorBufferPosition(new Point(at.row, at.column));
  return true;
}

/*
 * confirmUnsavedWork — the shared "Unsaved work" confirmation (Save All / Discard /
 * Cancel) shown before an action that tears down editors which may hold unwritten
 * edits. Used by the quit path (AppWindow) and by session open/close (sessionCommands),
 * so it lives here rather than on either. Presents on the app window (`zym.window`).
 */
import Adw from 'gi:Adw-1';
import { zym } from '../zym.ts';
import type { SessionParticipant } from '../SessionManager.ts';

/**
 * Present the "Unsaved work" confirm over `modified`, then run `onProceed` — after
 * flushing each saveable participant on Save All, straight through on Discard. Cancel
 * does nothing. `body` heads the bulleted list of the modified widgets.
 */
export function confirmUnsavedWork(modified: SessionParticipant[], body: string, onProceed: () => void): void {
  const items = modified.map((p) => `• ${p.getModifiedLabel?.() ?? 'Unsaved work'}`).join('\n');
  const dialog = new Adw.AlertDialog({ heading: 'Unsaved work', body: `${body}\n${items}` });
  dialog.addResponse('cancel', 'Cancel');
  dialog.addResponse('discard', 'Discard');
  dialog.addResponse('save', 'Save All');
  dialog.setResponseAppearance('discard', Adw.ResponseAppearance.DESTRUCTIVE);
  dialog.setResponseAppearance('save', Adw.ResponseAppearance.SUGGESTED);
  dialog.setDefaultResponse('save');
  dialog.setCloseResponse('cancel');
  dialog.on('response', (response: string) => {
    if (response === 'cancel') return;
    if (response === 'save') for (const participant of modified) participant.saveModified?.();
    onProceed();
  });
  dialog.present(zym.window!);
}

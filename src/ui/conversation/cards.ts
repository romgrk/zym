/*
 * cards.ts — the allow/deny permission prompt the agent injects into the
 * conversation flow. (AskUserQuestion lives in QuestionCard.ts.) A factory
 * returning the card widget; the conversation wires the decision to the session.
 */
import { Gtk } from '../../gi.ts';
import { summarizeInput } from './format.ts';
import type { PermissionRequest } from '../../agents/claude-sdk/SdkSession.ts';

type Box = InstanceType<typeof Gtk.Box>;

/** An allow/deny permission card. `decide` receives the user's choice; the caller
 *  removes the card from the transcript afterwards. */
export function permissionCard(req: PermissionRequest, decide: (allow: boolean) => void): Box {
  const card = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6 });
  card.addCssClass('quilx-conversation-perm');
  const title = new Gtk.Label({ xalign: 0, label: `Allow ${req.toolName}?` });
  const detail = new Gtk.Label({ xalign: 0, wrap: true, selectable: true, label: summarizeInput(req.input) });
  detail.addCssClass('quilx-conversation-tool');
  const buttons = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6 });
  const allow = new Gtk.Button({ label: 'Allow' });
  const deny = new Gtk.Button({ label: 'Deny' });
  allow.on('clicked', () => decide(true));
  deny.on('clicked', () => decide(false));
  buttons.append(allow);
  buttons.append(deny);
  card.append(title);
  card.append(detail);
  card.append(buttons);
  return card;
}

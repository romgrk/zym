/*
 * transcript.ts — read a past conversation back out of Claude Code's on-disk
 * transcript so a resumed `claude-sdk` agent can rebuild its visible rows.
 *
 * Why this exists: `claude -p --resume <id>` restores the model's *context* but
 * emits only an `init` event plus the new turn — it does NOT replay history as
 * stream events (verified against claude-code 2.1.x). So the conversation widget
 * would come up empty. We instead read claude's own JSONL transcript (the same
 * file `agentSessions.ts` reads for labels) and map each message into a flat list
 * of `ReplayEntry`s. `SdkSession.replay` re-emits these as the same domain events
 * a live turn produces, so the widget's row handlers redraw the conversation.
 *
 * The transcript is Claude Code's internal format (subject to change), so we read
 * defensively: unknown line types and malformed lines are skipped, never thrown.
 *
 * Scope (v1): the main thread — user turns, assistant text/thinking, tool calls
 * and their results. Subagent (`isSidechain`) inner transcripts are not yet
 * reconstructed; the spawning `Agent` tool call still shows as a row.
 */
import * as Fs from 'node:fs';
import * as Path from 'node:path';
import { transcriptDir } from '../../agentSessions.ts';

/** A single replayable step, mirroring one of `SdkSession`'s domain emissions. */
export type ReplayEntry =
  | { kind: 'user'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool_use'; id: string; name: string; input: unknown }
  | { kind: 'tool_result'; id: string; isError: boolean; text: string };

interface TranscriptLine {
  type?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  promptSource?: string;
  message?: { role?: string; content?: unknown };
}

/** Read and parse the transcript for `sessionId` (resolved under `cwd`'s project
 *  dir) into an ordered list of replay entries. Returns `[]` if the transcript is
 *  missing or unreadable — a resume then simply comes up with an empty transcript. */
export function readTranscript(cwd: string, sessionId: string): ReplayEntry[] {
  const file = Path.join(transcriptDir(cwd), `${sessionId}.jsonl`);
  let raw: string;
  try {
    raw = Fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const entries: ReplayEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: TranscriptLine;
    try {
      parsed = JSON.parse(trimmed) as TranscriptLine;
    } catch {
      continue; // not JSON — skip
    }
    if (parsed.isSidechain) continue; // subagent inner transcript — not restored (v1)
    if (parsed.type === 'assistant') appendAssistant(entries, parsed);
    else if (parsed.type === 'user') appendUser(entries, parsed);
  }
  return entries;
}

// Assistant message → thinking / text / tool_use entries, preserving block order
// (claude orders them thinking → text → tool_use within a message).
function appendAssistant(out: ReplayEntry[], line: TranscriptLine): void {
  const content = line.message?.content;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    const b = block as { type?: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown };
    if (b.type === 'thinking' && b.thinking) out.push({ kind: 'thinking', text: b.thinking });
    else if (b.type === 'text' && b.text) out.push({ kind: 'text', text: b.text });
    else if (b.type === 'tool_use') out.push({ kind: 'tool_use', id: b.id ?? '', name: b.name ?? 'tool', input: b.input });
  }
}

// User message → either a human turn (string / text content) or tool results
// (tool_result blocks). System-injected strings (`promptSource: "system"`, e.g.
// task notifications) and meta lines are not human turns — skip them as bubbles.
function appendUser(out: ReplayEntry[], line: TranscriptLine): void {
  const content = line.message?.content;
  const isHumanTurn = !line.isMeta && line.promptSource !== 'system';
  if (typeof content === 'string') {
    if (isHumanTurn && content.trim()) out.push({ kind: 'user', text: content });
    return;
  }
  if (!Array.isArray(content)) return;
  const textParts: string[] = [];
  for (const block of content) {
    const b = block as { type?: string; text?: string; tool_use_id?: string; is_error?: boolean; content?: unknown };
    if (b.type === 'tool_result' && b.tool_use_id) {
      out.push({ kind: 'tool_result', id: b.tool_use_id, isError: !!b.is_error, text: toolResultText(b.content) });
    } else if (b.type === 'text' && b.text && isHumanTurn) {
      textParts.push(b.text);
    }
  }
  if (textParts.length) out.push({ kind: 'user', text: textParts.join('\n') });
}

// Flatten a tool_result's content (a string, or an array of {type:'text',text}
// blocks) to plain text — matching SdkSession's own toolResultText.
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => (b && typeof b === 'object' && (b as { type?: string }).type === 'text' ? (b as { text?: string }).text ?? '' : ''))
    .join('');
}

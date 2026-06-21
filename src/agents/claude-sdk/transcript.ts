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
import type { SubagentInfo, SubagentMessage, ContextUsage } from './SdkSession.ts';

/** A single replayable step, mirroring one of `SdkSession`'s domain emissions. A
 *  tool_use that spawned a subagent (the `Agent` tool) carries its reconstructed
 *  inner transcript so the resumed subagent page fills in. */
export type ReplayEntry =
  | { kind: 'user'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool_use'; id: string; name: string; input: unknown; subagent?: SubagentInfo }
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
    if (parsed.isSidechain) continue; // subagent turns live in their own files (see readSubagents)
    if (parsed.type === 'assistant') appendAssistant(entries, parsed);
    else if (parsed.type === 'user') appendUser(entries, parsed);
  }
  // Attach each spawned subagent's reconstructed transcript to its `Agent` tool call,
  // so the resumed subagent button + page show the inner conversation.
  const subagents = readSubagents(cwd, sessionId);
  if (subagents.size > 0) {
    for (const e of entries) {
      if (e.kind === 'tool_use' && subagents.has(e.id)) e.subagent = subagents.get(e.id);
    }
  }
  return entries;
}

/** The footer's model + context occupancy, read from the transcript's latest
 *  assistant `usage`, so a resumed agent shows its real context gauge before the
 *  first live turn. Cost and the exact context-window size aren't in the transcript
 *  (they come from the live `result` event), so they're left to settle on resume. */
export function readContextSeed(cwd: string, sessionId: string): { model: string | null; usage: ContextUsage | null } {
  const file = Path.join(transcriptDir(cwd), `${sessionId}.jsonl`);
  let raw: string;
  try {
    raw = Fs.readFileSync(file, 'utf8');
  } catch {
    return { model: null, usage: null };
  }
  let model: string | null = null;
  let usage: ContextUsage | null = null;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: TranscriptLine;
    try {
      parsed = JSON.parse(trimmed) as TranscriptLine;
    } catch {
      continue;
    }
    if (parsed.isSidechain || parsed.type !== 'assistant') continue;
    const message = parsed.message as { model?: unknown; usage?: Record<string, unknown> } | undefined;
    if (!message) continue;
    if (typeof message.model === 'string') model = message.model; // keep the most recent
    const u = message.usage;
    if (u && typeof u === 'object') {
      const num = (v: unknown) => (typeof v === 'number' ? v : 0);
      const input = num(u.input_tokens);
      const cacheRead = num(u.cache_read_input_tokens);
      const cacheCreation = num(u.cache_creation_input_tokens);
      const output = num(u.output_tokens);
      // tokens = the window-occupying total (matches SdkSession.onUsage).
      usage = { tokens: input + cacheRead + cacheCreation, input, cacheRead, cacheCreation, output };
    }
  }
  return { model, usage };
}

// Claude stores each subagent's conversation as `<sid>/subagents/agent-<n>.jsonl`
// plus a `.meta.json` ({agentType, description, toolUseId}). Read each into a
// SubagentInfo keyed by the spawning `Agent` tool's id (meta.toolUseId).
function readSubagents(cwd: string, sessionId: string): Map<string, SubagentInfo> {
  const out = new Map<string, SubagentInfo>();
  const dir = Path.join(transcriptDir(cwd), sessionId, 'subagents');
  let files: string[];
  try {
    files = Fs.readdirSync(dir);
  } catch {
    return out; // no subagents dir — nothing to restore
  }
  for (const file of files) {
    if (!file.endsWith('.meta.json')) continue;
    let meta: { agentType?: string; description?: string; toolUseId?: string };
    try {
      meta = JSON.parse(Fs.readFileSync(Path.join(dir, file), 'utf8'));
    } catch {
      continue;
    }
    if (!meta.toolUseId) continue;
    let raw = '';
    try {
      raw = Fs.readFileSync(Path.join(dir, file.replace(/\.meta\.json$/, '.jsonl')), 'utf8');
    } catch {
      /* transcript missing — keep the (empty) subagent so the button still resolves */
    }
    const { prompt, messages } = parseSubagentFile(raw);
    out.set(meta.toolUseId, {
      id: meta.toolUseId,
      agentType: meta.agentType ?? 'agent',
      description: meta.description ?? '',
      prompt,
      status: 'completed', // historical
      messages,
    });
  }
  return out;
}

// Parse one subagent's JSONL into its prompt (the first human turn) + messages,
// mirroring SdkSession.onSubagentAssistant/onSubagentUser.
function parseSubagentFile(raw: string): { prompt: string; messages: SubagentMessage[] } {
  const messages: SubagentMessage[] = [];
  let prompt = '';
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: TranscriptLine;
    try {
      parsed = JSON.parse(trimmed) as TranscriptLine;
    } catch {
      continue;
    }
    const content = parsed.message?.content;
    if (parsed.type === 'assistant' && Array.isArray(content)) {
      for (const block of content) {
        const b = block as { type?: string; text?: string; id?: string; name?: string; input?: unknown };
        if (b.type === 'text' && b.text) messages.push({ kind: 'text', text: b.text });
        else if (b.type === 'tool_use') messages.push({ kind: 'tool', toolId: b.id ?? '', name: b.name ?? 'tool', input: b.input });
      }
    } else if (parsed.type === 'user') {
      if (typeof content === 'string') {
        if (!prompt && content.trim()) prompt = content; // the instruction given to the subagent
      } else if (Array.isArray(content)) {
        for (const block of content) {
          const b = block as { type?: string; tool_use_id?: string; is_error?: boolean; content?: unknown };
          if (b.type !== 'tool_result' || !b.tool_use_id) continue;
          const msg = messages.find((m): m is Extract<SubagentMessage, { kind: 'tool' }> => m.kind === 'tool' && m.toolId === b.tool_use_id);
          if (msg) msg.result = { isError: !!b.is_error, text: toolResultText(b.content) };
        }
      }
    }
  }
  return { prompt, messages };
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

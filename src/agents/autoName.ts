/*
 * Auto-name — generate a short session name + description from a task prompt, via a
 * one-shot agent (oneshot.ts). Drives on-demand naming: an empty `/rename` generates
 * a name from the session's task (fresh sessions are otherwise named by the agent's
 * own ACP topic — see AgentConversation's onTopic).
 *
 * `buildNamePrompt` and `parseAgentName` are pure (unit-tested); `generateAgentName`
 * ties them to a `OneShotAgent`. The parser is deliberately lenient — models tend
 * to wrap JSON in ```code fences``` or prose — so it extracts the first JSON object
 * and normalizes the name to a safe slug.
 */
import type { OneShotAgent, OneShotOptions } from './oneshot.ts';

export interface AgentName {
  /** A short, scannable title in `[Action/Category]: [Specific Focus]` form,
   *  e.g. "Fix: Login Bug" (≤ 40 chars). */
  name: string;
  /** A short imperative phrase summarizing the task, e.g. "Fix the login bug". */
  description: string;
}

/** Title length cap (mirrored in the prompt and enforced in the parser). */
const MAX_TITLE = 40;

/** The naming prompt for a task. Pure. */
export function buildNamePrompt(context: string): string {
  return [
    'You name a coding-agent session with a short, scannable title.',
    '',
    'Format: [Action/Category]: [Specific Focus]',
    '',
    'Good titles:',
    '- "API Integration: Auth Flow"',
    '- "Fix: Login Bug"',
    '- "DB Migration: Users Table"',
    '- "Build: Dashboard UI"',
    '- "Refactor: Payment Module"',
    '',
    'Avoid:',
    `- Too long — keep the title to ${MAX_TITLE} characters or fewer.`,
    '- Too generic ("Working", "Coding").',
    '- Too verbose ("The user wants me to…").',
    '',
    'Respond with ONLY a JSON object: {"name": "...", "description": "..."}',
    `- "name": the title, in the format above (${MAX_TITLE} chars or fewer).`,
    '- "description": a short imperative phrase summarizing the task.',
    '',
    'Task:',
    context.trim(),
  ].join('\n');
}

/** Tidy a model-suggested title: unwrap quotes, collapse whitespace, cap length.
 *  Unlike a slug it keeps the human-readable casing/punctuation (e.g. the colon). */
function cleanTitle(name: string): string {
  const tidied = name
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '') // strip wrapping quotes/backticks the model may add
    .replace(/\s+/g, ' ') // collapse internal whitespace
    .trim();
  return tidied.length > MAX_TITLE ? tidied.slice(0, MAX_TITLE).trimEnd() : tidied;
}

/** Extract `{ name, description }` from a one-shot's raw text, tolerating code
 *  fences / surrounding prose. Returns null when no valid name is found. Pure. */
export function parseAgentName(raw: string): AgentName | null {
  const match = /\{[\s\S]*\}/.exec(raw ?? '');
  if (!match) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as { name?: unknown; description?: unknown };
  const name = typeof o.name === 'string' ? cleanTitle(o.name) : '';
  if (!name) return null;
  const description =
    typeof o.description === 'string' && o.description.trim() ? o.description.trim() : name;
  return { name, description };
}

/** Generate a session name for `context` via `agent`. Resolves null when the model
 *  returns nothing parseable (or `context` is empty); rejects if the one-shot
 *  itself fails (caller handles both). */
export async function generateAgentName(
  agent: OneShotAgent,
  context: string,
  options?: OneShotOptions,
): Promise<AgentName | null> {
  if (!context.trim()) return null;
  const text = await agent.run(buildNamePrompt(context), options);
  return parseAgentName(text);
}

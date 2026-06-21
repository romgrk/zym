/*
 * format.ts — pure text helpers for the agent conversation UI (no GTK), so they
 * are unit-testable and shared across the conversation components + toolDisplay.
 */
import type { TaskProgress } from '../../agents/claude-sdk/SdkSession.ts';

/** `text` truncated to `max` chars with a trailing ellipsis. */
export function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + '…' : text;
}

/** First `maxLines` lines of `text`, capped at `maxChars`, ellipsised when truncated. */
export function truncateLines(text: string, maxLines: number, maxChars: number): string {
  if (!text) return '';
  const lines = text.split('\n');
  let out = lines.slice(0, maxLines).join('\n');
  const truncated = lines.length > maxLines || out.length > maxChars;
  if (out.length > maxChars) out = out.slice(0, maxChars);
  return truncated ? out.replace(/\s+$/, '') + ' …' : out;
}

/** A compact one-line view of a tool/permission input for a row. */
export function summarizeInput(input: unknown): string {
  if (input == null) return '';
  let text: string;
  try {
    text = typeof input === 'string' ? input : JSON.stringify(input);
  } catch {
    text = String(input);
  }
  return truncate(text, 200);
}

/** Compact count: 1234 → "1.2k". */
export function formatCount(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** One muted progress line for a subagent / background task. */
export function progressLine(p: TaskProgress): string {
  const meta: string[] = [];
  if (p.lastTool) meta.push(p.lastTool);
  if (p.tokens) meta.push(`${formatCount(p.tokens)} tokens`);
  if (p.durationMs) meta.push(`${(p.durationMs / 1000).toFixed(1)}s`);
  const desc = truncate(p.description, 70);
  const head = `${p.done ? '✓' : '⋯'} ${desc}`.trim();
  return meta.length ? `${head}  ·  ${meta.join('  ·  ')}` : head;
}

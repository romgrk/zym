/*
 * One-shot agent — run a single `claude -p` prompt to completion and return the
 * assistant's final text. Distinct from a persistent streaming agent session
 * (transport.ts): no turn loop, no rendering, no session continuity — just
 * prompt-in / text-out. Used for short auxiliary generations, e.g. auto-naming a
 * session (autoName.ts).
 *
 * The default implementation is hardcoded to `claude -p --model sonnet`, behind a
 * minimal `OneShotAgent` interface + a factory, so the backend (model, argv, even a
 * different provider) can become config-driven later without touching call sites.
 * A genuinely one-shot command, so it spawns via the shared process runner — not
 * the long-lived streaming transport (see docs/process-runner.md).
 */
import * as Fs from 'node:fs';
import * as Path from 'node:path';
import { runProcess } from '../process/runner.ts';
import { transcriptDir } from '../agentSessions.ts';

export interface OneShotOptions {
  /** Working directory — runs claude in the project so it uses the user's config/auth. */
  cwd?: string;
}

export interface OneShotAgent {
  /** Run `prompt` once; resolves the assistant's final text, rejects on failure. */
  run(prompt: string, options?: OneShotOptions): Promise<string>;
}

export interface ClaudeOneShotConfig {
  /** Base argv; default `['claude']`. */
  command?: string[];
  /** `--model` value; default `'sonnet'`. */
  model?: string;
}

/** Parse a `claude -p --output-format json` envelope into `{ ok, text, sessionId }`.
 *  The wire shape is a single `{ type:'result', subtype, is_error, result,
 *  session_id }` object, where `result` is the assistant's final text and
 *  `session_id` identifies the (throwaway) session Claude persisted. `sessionId`
 *  is surfaced even on an error envelope so the caller can still clean up the
 *  transcript. Pure (no IO) → unit-testable. */
export function parseOneShotEnvelope(raw: string): { ok: boolean; text: string; sessionId: string | null } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, text: '', sessionId: null };
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return { ok: false, text: '', sessionId: null };
  }
  if (obj && typeof obj === 'object') {
    const o = obj as { result?: unknown; is_error?: unknown; session_id?: unknown };
    const sessionId = typeof o.session_id === 'string' ? o.session_id : null;
    if (typeof o.result === 'string') return { ok: o.is_error !== true, text: o.result, sessionId };
    return { ok: false, text: '', sessionId };
  }
  return { ok: false, text: '', sessionId: null };
}

/** A one-shot agent backed by `claude -p --model <model> --output-format json`.
 *  Hardcoded defaults today; `config` is the seam for making model/argv
 *  user-configurable later. */
export function createOneShotAgent(config: ClaudeOneShotConfig = {}): OneShotAgent {
  const [file, ...base] = config.command ?? ['claude'];
  const model = config.model ?? 'sonnet';
  return {
    run(prompt, options = {}) {
      const args = [...base, '-p', '--model', model, '--output-format', 'json'];
      // Resolve cwd up front: claude runs here, and `discardSessionTranscript`
      // must hash the *same* dir to find the transcript Claude wrote (an empty
      // runner cwd would default to the host's, leaving the two out of sync).
      const cwd = options.cwd ?? process.cwd();
      return new Promise<string>((resolve, reject) => {
        // The prompt rides stdin (closed after), so claude can't block on a tty read
        // (the runner gives every command a pipe on stdin — see docs/process-runner.md).
        runProcess({ file, args, cwd, input: prompt }, (res) => {
          const { ok, text, sessionId } = parseOneShotEnvelope(res.stdout.toString());
          // Drop the throwaway transcript so it never reaches the resume picker.
          if (sessionId) discardSessionTranscript(cwd, sessionId);
          if (!res.ok) {
            reject(new Error(`one-shot ${file} exited ${res.code}: ${res.stderr.toString().trim()}`));
            return;
          }
          if (!ok) {
            reject(new Error('one-shot returned no result'));
            return;
          }
          resolve(text);
        });
      });
    },
  };
}

/** Delete a session's transcript (best effort, no-op if absent). For throwaway
 *  `claude -p` runs that must not survive in the resume picker — e.g. the
 *  one-shot agent's auxiliary generations (oneshot.ts), which Claude Code still
 *  persists as ordinary sessions. `cwd` is the dir the run was launched in (so
 *  `transcriptDir` resolves to the same encoded path Claude wrote under). */
function discardSessionTranscript(cwd: string, sessionId: string): void {
  try {
    Fs.rmSync(Path.join(transcriptDir(cwd), `${sessionId}.jsonl`), { force: true });
  } catch {
    /* best effort — a leftover transcript only means a stray picker entry */
  }
}
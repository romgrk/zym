/*
 * resume.ts — the argv flags that turn a fresh `claude` launch into a resumed
 * one, used by claude-tui's terminal spawn (and formerly claude-sdk's
 * headless `claude -p`). `--resume <id>` reloads a session's transcript into
 * context; `--continue` picks the most recent session in the cwd; `--fork-session`
 * branches a copy instead of appending to the original. Verified against the CLI.
 */
import type { AgentResume } from './types.ts';

/** The resume-related flags for `claude`'s argv (empty when not resuming). */
export function resumeFlags(resume?: AgentResume): string[] {
  if (!resume) return [];
  const base = resume.continue
    ? ['--continue']
    : resume.sessionId
      ? ['--resume', resume.sessionId]
      : [];
  if (base.length && resume.fork) base.push('--fork-session');
  return base;
}

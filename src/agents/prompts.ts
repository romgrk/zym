/*
 * agents/prompts.ts — appended to a claude agent's system prompt
 * (`--append-system-prompt`) so it proactively uses the zym bridge tools.
 * Used by the claude-tui terminal kind (acp agents get no system-prompt channel).
 *
 * The claude-tui agent ALSO receives the bridge tools' MCP descriptions (the bridge
 * is wired via `--mcp-config` — see claude-tui/session.ts), and those descriptions
 * already carry the full when/how/urgency for each tool (`assets/mcp/zymBridge.mjs`).
 * So this prompt is deliberately minimal: it adds only what a per-tool description
 * can't — the cross-tool posture (be proactive) and the meta constraint (never
 * surface the integration to the user). The per-tool mechanics live once, in the
 * schemas; nothing about *when/how* to call each tool is repeated here.
 */
import { outdent } from 'outdent';

export const AGENT_SYSTEM_PROMPT = outdent`
  You are running inside the zym IDE. Proactively use its MCP bridge tools —
  set_worktree and set_actions — exactly as their tool descriptions instruct, and
  never explain the integration or the tool calls to the user.
`;

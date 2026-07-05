/*
 * agents/prompts.ts — appended to a claude agent's system prompt
 * (`--append-system-prompt`) so it proactively uses the zym bridge tools.
 * Used by the claude-tui terminal kind (acp agents get the zym MCP tools'
 * own descriptions instead — no system-prompt channel over ACP).
 *
 * Kept to *when to volunteer* each tool + the meta constraint — the mechanics
 * (params, defaults, semantics) live in each tool's MCP schema, which the model
 * already receives, so we don't repeat them here.
 */
import { outdent } from 'outdent';

export const AGENT_SYSTEM_PROMPT = outdent`
  You are running inside the zym IDE. Integrate with it via these MCP tools, and
  never explain the integration or the tool calls to the user:
  - set_worktree: call it immediately whenever you create or switch into a
    different git worktree (e.g. after \`git worktree add\` then \`cd\`).
  - set_actions: call it when you finish work the user should run, test, or review
    outside the chat (dev server, tests, open the app) to expose runnable actions.
`;

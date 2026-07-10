#!/usr/bin/env node
/*
 * zym agent↔editor bridge — a minimal stdio MCP server exposing tools the
 * coding agent calls to talk to the zym editor it runs inside.
 *
 *   - `set_worktree` writes the agent's current git worktree path to
 *     `$ZYM_STATUS_FILE.cwd` (atomic tmp+rename) — the same IPC-file channel the
 *     status hooks use (see assets/hooks/agent-status.sh). The editor watches it
 *     and re-roots the agent's workbench (file tree, Source Control, branch).
 *   - `set_actions` writes a list of runnable actions (label + shell command) to
 *     `$ZYM_ACTIONS_FILE` (atomic). The editor makes them the agent's workbench
 *     actions (overwriting the set), surfaced as buttons in the conversation and run
 *     by the user from `space x` to verify the agent's work.
 *
 * Each tool is advertised only when its IPC file is configured (via the matching
 * env var), so a host that wants only one (e.g. the headless sdk wants actions but
 * not worktree) passes only that env var. The mandate to *when* to call each tool
 * ships in the server-level `instructions` field of the initialize result (one
 * clause per advertised tool), which a client surfaces at startup even while the
 * tool schemas stay deferred — so the tool descriptions carry only the *what*.
 * Transport: newline-delimited JSON-RPC 2.0 over stdio, per the MCP stdio spec.
 * Pure Node, no deps — runs from assets.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';

const STATUS_FILE = process.env.ZYM_STATUS_FILE;
const ACTIONS_FILE = process.env.ZYM_ACTIONS_FILE;
const PROTOCOL_VERSION = '2024-11-05';

const SET_WORKTREE = {
  name: 'set_worktree',
  description:
    'Tell the zym editor which git worktree you are now working in, so it re-roots ' +
    'its file tree and Source Control to match. Pass the absolute path of the worktree ' +
    'root.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute path of the worktree root you are now working in.' },
    },
    required: ['path'],
  },
};

const SET_ACTIONS = {
  name: 'set_actions',
  description:
    'Register runnable actions the user can trigger to run, test, or review your work ' +
    'outside this chat (e.g. open the app). zym shows them as buttons. Make each as ' +
    'convenient and direct as possible: open the app on the screen you changed, run the one ' +
    'affected test, hit the endpoint you touched — not just a generic "run everything". ' +
    'Replaces the whole set on each call; pass an empty `actions` list to clear it. List ' +
    'the most useful action first — it is the default.',
  inputSchema: {
    type: 'object',
    properties: {
      actions: {
        type: 'array',
        description: 'The actions to expose (replaces any previously registered set).',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'Short label, e.g. "Run dev server".' },
            command: { type: 'string', description: 'Shell command run in your working directory.' },
            terminal: { type: 'boolean', description: 'Run in a terminal tab (default true); set false to run in the background when terminal output is not needed.' },
          },
          required: ['label', 'command'],
        },
      },
    },
    required: ['actions'],
  },
};

// Advertise a tool only when its IPC channel is configured.
const TOOLS = [
  ...(STATUS_FILE ? [SET_WORKTREE] : []),
  ...(ACTIONS_FILE ? [SET_ACTIONS] : []),
];

// The tool descriptions cover the *what*; the *when* — the mandate to call each tool —
// ships in the server-level `instructions` field of the initialize result. A client
// surfaces that at startup even while the tool schemas stay deferred, so the mandates
// are seen up front. One clause per advertised tool, mirroring TOOLS.
const WORKTREE_MANDATE =
  'The instant you create or switch into a git worktree (e.g. after `git worktree add ' +
  '<path>` then `cd <path>`), call `set_worktree` with its absolute path before running ' +
  'any other command. This is required, not optional — until you do, the editor stays ' +
  'rooted in the wrong directory and cannot track your work.';

const ACTIONS_MANDATE =
  'Whenever you finish work the user could run, test, or review, call `set_actions` to ' +
  'register the runnable commands and keep the set current as the work changes — do not ' +
  'just describe them in chat.';

const INSTRUCTIONS = [
  ...(STATUS_FILE ? [WORKTREE_MANDATE] : []),
  ...(ACTIONS_FILE ? [ACTIONS_MANDATE] : []),
].join('\n\n');

/** Atomically write `text` to `file` (tmp + rename). */
function writeAtomic(file, text) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/** Write the agent's current worktree path to the IPC file (atomic). */
function writeCwd(p) {
  if (!STATUS_FILE) return false;
  try {
    writeAtomic(`${STATUS_FILE}.cwd`, p);
    return true;
  } catch {
    return false;
  }
}

/** Normalize + write the registered actions to the actions IPC file (atomic).
 *  Returns the count written, or -1 if the editor channel is unreachable. */
function writeActions(actions) {
  if (!ACTIONS_FILE) return -1;
  const clean = [];
  for (const a of Array.isArray(actions) ? actions : []) {
    if (!a || typeof a !== 'object') continue;
    const label = typeof a.label === 'string' ? a.label.trim() : '';
    const command = typeof a.command === 'string' ? a.command.trim() : '';
    if (!label || !command) continue;
    clean.push({ label, command, terminal: a.terminal !== false });
  }
  try {
    writeAtomic(ACTIONS_FILE, JSON.stringify(clean));
    return clean.length;
  } catch {
    return -1;
  }
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}
function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}
function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function callSetWorktree(id, args) {
  const p = typeof args.path === 'string' ? args.path : '';
  if (!p || !path.isAbsolute(p)) {
    reply(id, { content: [{ type: 'text', text: 'Error: `path` must be an absolute worktree path.' }], isError: true });
    return;
  }
  const ok = writeCwd(p);
  reply(id, {
    content: [{ type: 'text', text: ok ? `Editor re-rooted to ${p}` : 'Could not reach the editor (no IPC channel).' }],
    isError: !ok,
  });
}

function callSetActions(id, args) {
  const count = writeActions(args.actions);
  if (count < 0) {
    reply(id, { content: [{ type: 'text', text: 'Could not reach the editor (no IPC channel).' }], isError: true });
    return;
  }
  reply(id, {
    content: [{ type: 'text', text: count === 0 ? 'Cleared all actions.' : `Registered ${count} action${count === 1 ? '' : 's'}.` }],
  });
}

function callTool(id, params) {
  const name = params?.name;
  const args = params?.arguments ?? {};
  if (name === 'set_worktree' && STATUS_FILE) return callSetWorktree(id, args);
  if (name === 'set_actions' && ACTIONS_FILE) return callSetActions(id, args);
  replyError(id, -32602, `Unknown tool: ${name}`);
}

function handle(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'zym', version: '1.0.0' },
        ...(INSTRUCTIONS ? { instructions: INSTRUCTIONS } : {}),
      });
      return;
    case 'tools/list':
      reply(id, { tools: TOOLS });
      return;
    case 'tools/call':
      callTool(id, params);
      return;
    case 'ping':
      reply(id, {});
      return;
    default:
      // Notifications carry no id and need no response; unknown *requests* error.
      if (id !== undefined && id !== null) replyError(id, -32601, `Method not found: ${method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const text = line.trim();
  if (!text) return;
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return; // ignore malformed lines
  }
  if (Array.isArray(msg)) {
    for (const m of msg) handle(m);
  } else {
    handle(msg);
  }
});

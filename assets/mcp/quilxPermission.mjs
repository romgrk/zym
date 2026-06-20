#!/usr/bin/env node
/*
 * quilx permission-prompt MCP server — the tool claude calls (via
 * `--permission-prompt-tool mcp__quilxPerm__approve`) when it needs the user to
 * approve a tool use in a headless `claude-sdk` session (see SdkSession.ts).
 *
 * It bridges that call to the editor over a file pair (the same atomic
 * tmp+rename channel the status hooks use): on a `tools/call` it writes the
 * request to $QUILX_PERM_REQUEST, polls $QUILX_PERM_RESPONSE for the editor's
 * decision (matched by id), and returns that decision in the shape claude's
 * permission-prompt-tool expects — a content text block holding JSON of either
 * `{"behavior":"allow","updatedInput":{…}}` or `{"behavior":"deny","message":"…"}`.
 *
 * Pure Node, no dependencies. Transport: newline-delimited JSON-RPC 2.0 / stdio.
 */
import * as fs from 'node:fs';
import * as readline from 'node:readline';
import { randomUUID } from 'node:crypto';

const REQUEST_FILE = process.env.QUILX_PERM_REQUEST;
const RESPONSE_FILE = process.env.QUILX_PERM_RESPONSE;
const PROTOCOL_VERSION = '2024-11-05';
const POLL_MS = 100;

const TOOLS = [
  {
    name: 'approve',
    description:
      'Ask the quilx editor to approve or deny a tool use. The editor surfaces a ' +
      'permission card to the user and returns their decision.',
    inputSchema: {
      type: 'object',
      properties: {
        tool_name: { type: 'string', description: 'The tool being requested.' },
        input: { type: 'object', description: 'The proposed tool input.' },
      },
    },
  },
];

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function replyError(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

function writeAtomic(file, text) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/** Permission-prompt-tool result shape: a single text block holding the decision JSON. */
function permissionResult(rpcId, decision) {
  reply(rpcId, { content: [{ type: 'text', text: JSON.stringify(decision) }] });
}

// Ask the editor and reply to the JSON-RPC call once it answers. The proposed
// input is echoed back as `updatedInput` on allow (we don't rewrite it).
function requestApproval(rpcId, args) {
  if (!REQUEST_FILE || !RESPONSE_FILE) {
    // No editor channel — fail closed (deny) rather than silently allow.
    return permissionResult(rpcId, { behavior: 'deny', message: 'No editor permission channel.' });
  }
  const id = randomUUID();
  const proposedInput = args && typeof args.input === 'object' && args.input ? args.input : {};
  try {
    writeAtomic(REQUEST_FILE, JSON.stringify({ id, tool_name: args?.tool_name ?? 'tool', input: proposedInput }));
  } catch {
    return permissionResult(rpcId, { behavior: 'deny', message: 'Could not reach the editor.' });
  }

  const timer = setInterval(() => {
    let raw;
    try { raw = fs.readFileSync(RESPONSE_FILE, 'utf8'); } catch { return; } // not written yet
    let res;
    try { res = JSON.parse(raw); } catch { return; }
    if (res.id !== id) return; // an older/other response — keep polling
    clearInterval(timer);
    try { fs.rmSync(RESPONSE_FILE, { force: true }); } catch { /* best effort */ }
    if (res.behavior === 'allow') permissionResult(rpcId, { behavior: 'allow', updatedInput: proposedInput });
    else permissionResult(rpcId, { behavior: 'deny', message: res.message || 'Denied by the user.' });
  }, POLL_MS);
}

function callTool(id, params) {
  if (params?.name !== 'approve') {
    replyError(id, -32602, `Unknown tool: ${params?.name}`);
    return;
  }
  requestApproval(id, params?.arguments ?? {});
}

function handle(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      reply(id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: 'quilxPerm', version: '1.0.0' } });
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
      if (id !== undefined && id !== null) replyError(id, -32601, `Method not found: ${method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const text = line.trim();
  if (!text) return;
  let msg;
  try { msg = JSON.parse(text); } catch { return; }
  if (Array.isArray(msg)) for (const m of msg) handle(m);
  else handle(msg);
});

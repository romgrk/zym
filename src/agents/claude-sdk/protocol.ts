/*
 * protocol.ts — types and constructors for Claude Code's `claude -p` stream-json
 * wire protocol, as driven by the `claude-sdk` agent kind (see
 * tasks/agents/claude-sdk.md).
 *
 * The shapes here are grounded in the *observed* output of
 *   claude -p --input-format stream-json --output-format stream-json --verbose
 * (claude-code 2.1.x), captured live. They are intentionally a small, typed
 * subset of the full protocol — enough to drive the session domain model — with
 * an open-ended fallback (`UnknownEvent`) so an unrecognised line never breaks
 * the stream.
 *
 * NOTE: `@anthropic-ai/claude-agent-sdk` exports equivalent message types
 * (`SDKMessage` and friends). Once that dependency is vendored (type-only — see
 * the design doc) and its export names verified, these locals can be replaced by
 * (or aligned to) the SDK's. Until then we own them, matching the bytes on the
 * wire rather than guessing SDK bindings.
 */

// --- Input (editor → claude): one user turn per line -------------------------

/** A single user turn written to claude's stdin (newline-terminated by the
 *  transport). `content` may be a plain string or structured content blocks. */
export interface UserTurnMessage {
  type: 'user';
  message: {
    role: 'user';
    content: string | ContentBlock[];
  };
}

/** Build a plain-text user turn. */
export function userTurn(text: string): UserTurnMessage {
  return { type: 'user', message: { role: 'user', content: text } };
}

// --- Output (claude → editor): one event per stdout line ---------------------

/** Content blocks inside an assistant message. */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: string; [key: string]: unknown };

/** Token usage carried on assistant/result events. */
export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  [key: string]: unknown;
}

/** `{"type":"system","subtype":"init",...}` — the first event of a session. */
export interface SystemInitEvent {
  type: 'system';
  subtype: 'init';
  session_id: string;
  cwd?: string;
  model?: string;
  permissionMode?: string;
  tools?: string[];
  slash_commands?: string[];
  [key: string]: unknown;
}

/** `{"type":"system","subtype":"thinking_tokens",...}` — running thinking-token
 *  estimate (the "thinking…" animation, as data). */
export interface ThinkingTokensEvent {
  type: 'system';
  subtype: 'thinking_tokens';
  estimated_tokens: number;
  estimated_tokens_delta: number;
  session_id: string;
}

/** Any other `{"type":"system",...}` subtype we don't model explicitly. */
export interface SystemOtherEvent {
  type: 'system';
  subtype: string;
  session_id?: string;
  [key: string]: unknown;
}

/** `{"type":"assistant","message":{...}}` — a streamed assistant message; with
 *  `--include-partial-messages` these arrive incrementally. */
export interface AssistantEvent {
  type: 'assistant';
  message: {
    role: 'assistant';
    content: ContentBlock[];
    usage?: Usage;
    [key: string]: unknown;
  };
  session_id?: string;
  parent_tool_use_id?: string | null;
}

/** `{"type":"result",...}` — emitted once per turn (not per session). */
export interface ResultEvent {
  type: 'result';
  subtype: string; // 'success' | 'error_max_turns' | ...
  is_error?: boolean;
  result?: string;
  num_turns?: number;
  total_cost_usd?: number;
  usage?: Usage;
  session_id?: string;
  permission_denials?: unknown[];
  [key: string]: unknown;
}

/** `{"type":"rate_limit_event",...}`. */
export interface RateLimitEvent {
  type: 'rate_limit_event';
  rate_limit_info?: { status?: string; [key: string]: unknown };
  [key: string]: unknown;
}

/** Any line whose `type` we don't recognise — kept so the stream never breaks. */
export interface UnknownEvent {
  type: string;
  [key: string]: unknown;
}

/** Discriminated union of every output event the session may receive. */
export type StreamEvent =
  | SystemInitEvent
  | ThinkingTokensEvent
  | SystemOtherEvent
  | AssistantEvent
  | ResultEvent
  | RateLimitEvent
  | UnknownEvent;

// --- Narrowing helpers -------------------------------------------------------

export function isSystemInit(e: StreamEvent): e is SystemInitEvent {
  return e.type === 'system' && (e as { subtype?: string }).subtype === 'init';
}

export function isThinkingTokens(e: StreamEvent): e is ThinkingTokensEvent {
  return e.type === 'system' && (e as { subtype?: string }).subtype === 'thinking_tokens';
}

export function isAssistant(e: StreamEvent): e is AssistantEvent {
  return e.type === 'assistant';
}

export function isResult(e: StreamEvent): e is ResultEvent {
  return e.type === 'result';
}

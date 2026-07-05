/*
 * acp/bridge.ts — the zym editor bridge for ACP agents: exposes the bundled
 * `zymBridge.mjs` MCP server (the `set_worktree` / `set_actions` tools) through
 * ACP's standard `session/new.mcpServers` field, and watches the files the
 * bridge writes (the same atomic tmp+rename + Gio.FileMonitor IPC the claude
 * kinds use — the bridge is a *grandchild* process with no pipe back to zym).
 *
 * This module imports Gio, so it is injected into `AcpSession` (which stays
 * runtime-pure and drivable from plain node) by the kind registry.
 */
import * as Fs from 'node:fs';
import * as Os from 'node:os';
import * as Path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import Gio from 'gi:Gio-2.0';
import { CompositeDisposable, Disposable } from '../../util/eventKit.ts';
import { parseActions, type Action } from '../../actions.ts';
import type { AcpBridge, AcpMcpServer } from './AcpSession.ts';

// node-gtk quirk (see claude-tui/session.ts): Gio.File instance methods live on
// the interface prototype, not the concrete wrapper.
const FileProto = (Gio.File as any).prototype;

// This file is at src/agents/acp/, so three `..` reach the repo root.
const BRIDGE_SCRIPT = Path.join(
  Path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'assets', 'mcp', 'zymBridge.mjs',
);

/** The zym editor bridge as an `AcpBridge`: MCP server spec + IPC-file watcher. */
export function createAcpBridge(): AcpBridge {
  const dir = Path.join(process.env.XDG_RUNTIME_DIR || Os.tmpdir(), 'zym', 'acp', randomUUID());
  Fs.mkdirSync(dir, { recursive: true });
  const statusFile = Path.join(dir, 'status');
  const actionsFile = Path.join(dir, 'actions.json');

  const mcpServers: AcpMcpServer[] = [
    {
      name: 'zym',
      command: process.execPath,
      args: [BRIDGE_SCRIPT],
      env: [
        { name: 'ZYM_STATUS_FILE', value: statusFile },
        { name: 'ZYM_ACTIONS_FILE', value: actionsFile },
      ],
    },
  ];

  const subs = new CompositeDisposable();
  let lastActions: string | null = null;
  let lastCwd: string | null = null;

  const watchPath = (path: string, onChange: () => void): void => {
    const monitor = FileProto.monitorFile.call(
      Gio.File.newForPath(path), Gio.FileMonitorFlags.WATCH_MOVES, null,
    ) as InstanceType<typeof Gio.FileMonitor>;
    subs.connect(monitor, 'changed', onChange);
    subs.defer(() => monitor.cancel());
  };

  const readFresh = (path: string, last: string | null): string | null => {
    let raw: string;
    try {
      raw = Fs.readFileSync(path, 'utf8').trim();
    } catch {
      return null; // mid-rename / removed
    }
    return raw && raw !== last ? raw : null;
  };

  return {
    mcpServers,
    watch(host: { onActions(actions: Action[]): void; onCwd(cwd: string): void }): Disposable {
      watchPath(actionsFile, () => {
        const raw = readFresh(actionsFile, lastActions);
        if (raw == null) return;
        lastActions = raw;
        let parsed: unknown;
        try { parsed = JSON.parse(raw); } catch { return; } // mid-write / malformed
        host.onActions(parseActions(parsed));
      });
      watchPath(`${statusFile}.cwd`, () => {
        const raw = readFresh(`${statusFile}.cwd`, lastCwd);
        if (raw == null) return;
        lastCwd = raw;
        host.onCwd(raw);
      });
      return new Disposable(() => subs.dispose());
    },
    dispose(): void {
      subs.dispose(); // `.off()` + `.cancel()` every monitor
      try { Fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    },
  };
}

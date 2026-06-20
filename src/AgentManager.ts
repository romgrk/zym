/*
 * AgentManager — the application-wide registry of running terminal agents.
 *
 * Exposed as `quilx.agents`. Each Agent registers itself on launch and
 * deregisters when its process exits, so other parts of the app (a future agent
 * sidebar, status indicators, "focus next agent" commands) can enumerate the
 * live agents and react as they come and go.
 */
import { Emitter, type Disposable } from './util/eventKit.ts';
// Type-only: avoids a runtime import cycle (quilx → AgentManager → Agent
// → quilx); the import is erased by type-stripping.
import type { Agent } from './agents/types.ts';

export class AgentManager {
  // Live agents, in launch order — the source of truth for any agent UI.
  private readonly agents: Agent[] = [];
  private readonly emitter = new Emitter();

  /** Register a newly-launched agent. */
  add(agent: Agent): void {
    if (this.agents.includes(agent)) return;
    this.agents.push(agent);
    this.emitter.emit('did-add-agent', agent);
  }

  /** Deregister an agent (e.g. when its process exits). */
  remove(agent: Agent): void {
    const index = this.agents.indexOf(agent);
    if (index === -1) return;
    this.agents.splice(index, 1);
    this.emitter.emit('did-remove-agent', agent);
  }

  /** A snapshot of the currently-running agents (launch order). */
  getAgents(): Agent[] {
    return this.agents.slice();
  }

  onDidAddAgent(callback: (agent: Agent) => void): Disposable {
    return this.emitter.on('did-add-agent', callback as (value?: unknown) => void);
  }

  onDidRemoveAgent(callback: (agent: Agent) => void): Disposable {
    return this.emitter.on('did-remove-agent', callback as (value?: unknown) => void);
  }
}

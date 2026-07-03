/*
 * Owner — what a `Workbench` belongs to. The window shows one owner's workbench at
 * a time and the WorkbenchList rail switches between them (docs/session-management.md
 * "Multi-root"). There are two kinds:
 *
 * - `Project` — a user project root. A window can hold several; unlike agents they
 *   don't re-root once opened.
 * - `Agent`   — a running coding agent (its own worktree).
 *
 * `Project` replaced the former `'user'` singleton, so "is this the user's own
 * workbench?" is now `isProject(owner)` and "which agent?" is `isAgent(owner)`.
 */
import * as Path from 'node:path';
import type { Agent } from '../../agents/types.ts';

/** A user project root open in the window. */
export interface Project {
  /** Discriminator vs `Agent` (which never carries `kind`). */
  readonly kind: 'project';
  /** Stable key for the workbenches map + session identity — the root at creation. */
  readonly id: string;
  /** Display label for the rail — the root's basename. */
  readonly title: string;
}

/** The owner of a workbench: a user project, or an agent. */
export type Owner = Project | Agent;

/** Build a project owner for `root` (its basename is the rail label). */
export function createProject(root: string): Project {
  return { kind: 'project', id: root, title: Path.basename(root) || root };
}

export function isProject(owner: Owner): owner is Project {
  return (owner as Project).kind === 'project';
}

export function isAgent(owner: Owner): owner is Agent {
  return !isProject(owner);
}

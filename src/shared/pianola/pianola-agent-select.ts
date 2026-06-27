/**
 * Pianola agent selection - PURE.
 *
 * Picks the best agent for a ready task: among ready (status 'ok'), capable,
 * not-busy candidates, the least-loaded wins (lowest inFlight), ties broken by
 * agent id for determinism. Returns an escalate signal when nothing is ready and
 * capable, so the caller never silently drops a task or dispatches to an unready
 * agent. No I/O - the caller supplies the live candidate snapshot.
 *
 * Runtime-agnostic: no fs, no Electron, no app state. Sibling of the orchestrator
 * (pianola-orchestrator.ts), which binds tasks to the agent this returns.
 */

import type { AgentCapabilities } from '../types';
import type { AgentStatus } from '../agentCapabilities';
import type { PianolaTask } from './pianola-tasks';

/** A dispatch target the orchestrator may bind a task to. */
export interface AgentCandidate {
	/** Stable identity to dispatch to (a session id, or a tool type to spawn). */
	agentId: string;
	/** What the agent can do; checked against the task's required flags. */
	capabilities: AgentCapabilities;
	/** Live readiness; only 'ok' agents are eligible. */
	status: AgentStatus;
	/** Currently mid-turn: a dispatch would be rejected, so it is not eligible. */
	busy: boolean;
	/** Tasks already bound to this agent and not yet terminal (load signal). */
	inFlight: number;
}

/** A bound agent, or an escalate reason when no candidate qualifies. */
export type AgentSelection = { agentId: string } | { escalate: string };

export interface SelectAgentOptions {
	/** Capability flags the agent MUST support to run this task. */
	required?: readonly (keyof AgentCapabilities)[];
}

/** True when a candidate is ready (status 'ok'), free, and supports every required flag. */
function isReadyAndCapable(
	candidate: AgentCandidate,
	required: readonly (keyof AgentCapabilities)[]
): boolean {
	if (candidate.status !== 'ok') return false;
	if (candidate.busy) return false;
	return required.every((flag) => candidate.capabilities[flag] === true);
}

/**
 * Choose an agent for `task` from `candidates`. Eligible = status 'ok', not busy,
 * and supporting every required capability. Among the eligible the least-loaded
 * wins (lowest inFlight), ties broken by agentId ascending for determinism. A
 * task already pinned to an eligible agent keeps that binding. Returns
 * { escalate } when no candidate is ready and capable; the caller decides whether
 * that means wait-and-retry or surface it to the user, but it must never pick an
 * unready agent or drop the task.
 */
export function selectAgentForTask(
	task: PianolaTask,
	candidates: readonly AgentCandidate[],
	options: SelectAgentOptions = {}
): AgentSelection {
	const required = options.required ?? [];
	const eligible = candidates.filter((c) => isReadyAndCapable(c, required));

	if (eligible.length === 0) {
		const why =
			candidates.length === 0
				? 'no candidate agents'
				: 'every candidate is busy, unready, or lacks a required capability';
		return { escalate: `no ready, capable agent for task "${task.id}": ${why}` };
	}

	// Keep a stable binding when the task is already pinned to an eligible agent.
	if (task.agentId && eligible.some((c) => c.agentId === task.agentId)) {
		return { agentId: task.agentId };
	}

	const best = [...eligible].sort((a, b) => {
		if (a.inFlight !== b.inFlight) return a.inFlight - b.inFlight;
		return a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0;
	})[0];
	return { agentId: best.agentId };
}

/**
 * Agent-run lifecycle transition guard (F5) - PURE.
 *
 * Defines which AgentRunStatus transitions are legal and enforces the two
 * lifecycle invariants:
 *   1. Only listed transitions are legal (an unknown edge is rejected).
 *   2. Terminal states are immutable except via an explicit audited action.
 *
 * Runtime-agnostic: no fs, electron, child_process, or network. The store and
 * capture service consult this before persisting any status change; producers
 * never mutate status directly.
 */

import { AGENT_RUN_STATUSES, type AgentRunStatus } from './types';

/** Statuses a run can never leave on its own. */
export const TERMINAL_AGENT_RUN_STATUSES: readonly AgentRunStatus[] = [
	'completed',
	'failed',
	'cancelled',
	'merged',
	'discarded',
];

/**
 * Legal forward transitions keyed by source status. Terminal sources map to the
 * audited-only edges they may still take (for example completed -> merged when
 * the user triggers a merge, or failed -> running on an explicit retry).
 */
const TRANSITIONS: Record<AgentRunStatus, readonly AgentRunStatus[]> = {
	queued: ['running', 'waiting', 'cancelled', 'failed'],
	running: ['waiting', 'needs_review', 'fixing', 'completed', 'failed', 'cancelled'],
	waiting: ['running', 'needs_review', 'completed', 'failed', 'cancelled'],
	needs_review: ['fixing', 'completed', 'merged', 'failed', 'cancelled', 'discarded'],
	fixing: ['running', 'needs_review', 'completed', 'failed', 'cancelled'],
	// Terminal sources: every edge below requires an audited action.
	completed: ['merged', 'needs_review', 'discarded'],
	failed: ['running', 'discarded'],
	cancelled: ['running', 'discarded'],
	merged: [],
	discarded: [],
};

export interface TransitionOptions {
	/** An explicit, user-initiated + audited action (retry, merge, discard, reopen). */
	audited?: boolean;
}

export function isTerminalAgentRunStatus(status: AgentRunStatus): boolean {
	return TERMINAL_AGENT_RUN_STATUSES.includes(status);
}

/**
 * True when moving `from` -> `to` is allowed. A no-op (from === to) is always
 * legal. A transition out of a terminal state is legal ONLY when `audited` is
 * set and the edge is listed; a non-terminal transition is legal when listed.
 */
export function canTransition(
	from: AgentRunStatus,
	to: AgentRunStatus,
	options: TransitionOptions = {}
): boolean {
	if (from === to) return true;
	if (!AGENT_RUN_STATUSES.includes(to)) return false;
	const allowed = TRANSITIONS[from] ?? [];
	if (!allowed.includes(to)) return false;
	// Leaving a terminal state is only permitted through an audited action.
	if (isTerminalAgentRunStatus(from) && !options.audited) return false;
	return true;
}

/**
 * Return `to` when the transition is legal, otherwise throw with both states
 * named. Callers that persist status changes use this so an illegal edge fails
 * loudly at the write boundary instead of silently corrupting the lifecycle.
 */
export function assertTransition(
	from: AgentRunStatus,
	to: AgentRunStatus,
	options: TransitionOptions = {}
): AgentRunStatus {
	if (!canTransition(from, to, options)) {
		const suffix =
			isTerminalAgentRunStatus(from) && !options.audited ? ' (terminal, needs audited action)' : '';
		throw new Error(`illegal agent-run transition: ${from} -> ${to}${suffix}`);
	}
	return to;
}

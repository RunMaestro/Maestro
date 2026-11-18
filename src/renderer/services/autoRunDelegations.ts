/**
 * autoRunDelegations - what both Auto Run runners (documents and Goal-Driven)
 * do with work a task hands to another agent.
 *
 * One rule, the same in both modes: a turn never starts while work the run
 * delegated is still running, and the turn that starts next receives every
 * result that came back. Fan-out inside a turn stays parallel (a manager turn
 * can dispatch five agents and exit); the run waits for all five before it
 * spawns the turn that integrates them. The protocol and the prompt block are
 * in `src/shared/autoRunDelegation.ts`.
 */

import {
	parseAutoRunDelegationEvent,
	summarizePendingDelegations,
	type AutoRunDelegation,
	type AutoRunPendingDelegation,
} from '../../shared/autoRunDelegation';
import {
	selectPendingDelegations,
	useAutoRunDelegationStore,
} from '../stores/autoRunDelegationStore';
import { generateId } from '../utils/ids';
import type { BatchRunState } from '../types';

let unsubscribe: (() => void) | null = null;

/** How often a wait re-checks the run's stop flag, which is a ref, not observable. */
const STOP_POLL_MS = 1000;

/**
 * Subscribe this client to the delegation push, once. Lazy rather than wired at
 * startup: nothing needs the events until a run exists, and every run calls
 * {@link beginAutoRunDelegations} before its first spawn, which is before the
 * first event for it can be sent.
 */
function ensureListener(): void {
	if (unsubscribe) return;
	const subscribe = window.maestro?.autorun?.onDelegation;
	if (typeof subscribe !== 'function') return;
	unsubscribe = subscribe((raw) => {
		const event = parseAutoRunDelegationEvent(raw);
		if (event) useAutoRunDelegationStore.getState().apply(event);
	});
}

/** Start tracking delegations for a new run. Returns the id its spawns carry. */
export function beginAutoRunDelegations(): string {
	ensureListener();
	return `autorun-${generateId()}`;
}

/** Forget a run's delegations once it has ended. */
export function endAutoRunDelegations(runId: string): void {
	useAutoRunDelegationStore.getState().clearRun(runId);
}

/** Settled results not yet handed to a turn. Each result is returned once. */
export function takeAutoRunDelegationResults(runId: string): AutoRunDelegation[] {
	return useAutoRunDelegationStore.getState().takeSettled(runId);
}

/** How many things the run delegated are still running. */
export function countPendingAutoRunDelegations(runId: string): number {
	return selectPendingDelegations(useAutoRunDelegationStore.getState(), runId).length;
}

export interface WaitForDelegationsOptions {
	/** The run's stop flag. A stop ends the wait; the delegated work keeps running. */
	isStopRequested: () => boolean;
	/** Called with the still-running list whenever it changes, and with `[]` when the wait ends. */
	onPendingChange?: (pending: AutoRunPendingDelegation[]) => void;
}

function sameIds(a: AutoRunPendingDelegation[], b: AutoRunPendingDelegation[]): boolean {
	return a.length === b.length && a.every((d, i) => d.callbackId === b[i].callbackId);
}

/**
 * Resolve once nothing the run delegated is still running, or the run is asked
 * to stop. Resolves immediately when there is nothing to wait for. No timeout of
 * its own: every delegation carries the dispatch callback's timeout, which
 * settles it as `timeout` in main.
 */
export function waitForAutoRunDelegations(
	runId: string,
	options: WaitForDelegationsOptions
): Promise<'settled' | 'stopped'> {
	const read = () =>
		summarizePendingDelegations(
			selectPendingDelegations(useAutoRunDelegationStore.getState(), runId)
		);
	let pending = read();
	if (pending.length === 0) return Promise.resolve('settled');
	if (options.isStopRequested()) return Promise.resolve('stopped');
	options.onPendingChange?.(pending);

	return new Promise((resolve) => {
		let done = false;
		// Both are assigned below, before anything can call `finish`: it only runs
		// from a store change or a timer tick, never synchronously.
		const cleanup: { unsubscribe?: () => void; timer?: ReturnType<typeof setInterval> } = {};
		const finish = (outcome: 'settled' | 'stopped') => {
			if (done) return;
			done = true;
			cleanup.unsubscribe?.();
			if (cleanup.timer !== undefined) clearInterval(cleanup.timer);
			options.onPendingChange?.([]);
			resolve(outcome);
		};
		const check = () => {
			if (options.isStopRequested()) return finish('stopped');
			const next = read();
			if (next.length === 0) return finish('settled');
			if (!sameIds(next, pending)) {
				pending = next;
				options.onPendingChange?.(next);
			}
		};
		cleanup.unsubscribe = useAutoRunDelegationStore.subscribe(check);
		cleanup.timer = setInterval(check, STOP_POLL_MS);
	});
}

/**
 * The step both runners take before spawning a turn: wait out delegated work,
 * then collect what came back for that turn's prompt. `stopped` means the run
 * was asked to stop while waiting, so the caller should not spawn.
 */
export async function awaitDelegationsBeforeTurn(
	runId: string,
	options: WaitForDelegationsOptions
): Promise<{ stopped: boolean; results: AutoRunDelegation[] }> {
	const outcome = await waitForAutoRunDelegations(runId, options);
	if (outcome === 'stopped') return { stopped: true, results: [] };
	return { stopped: false, results: takeAutoRunDelegationResults(runId) };
}

/**
 * The step both runners take after their last turn: unless the run was stopped,
 * wait for delegated work still running, and return every result no turn
 * received so the run can record it. Without this a run "finished" while its
 * delegates were mid-work, and what they reported went nowhere.
 */
export async function settleDelegationsAtRunEnd(
	runId: string,
	options: WaitForDelegationsOptions
): Promise<AutoRunDelegation[]> {
	if (!options.isStopRequested()) await waitForAutoRunDelegations(runId, options);
	return takeAutoRunDelegationResults(runId);
}

/**
 * The batch-state updater that publishes the still-running list, so the Auto Run
 * card, the web broadcast, and `auto-run-status` show what the run waits on.
 */
export function pendingDelegationsUpdater(
	sessionId: string,
	pending: AutoRunPendingDelegation[]
): (prev: Record<string, BatchRunState>) => Record<string, BatchRunState> {
	return (prev) =>
		prev[sessionId]
			? { ...prev, [sessionId]: { ...prev[sessionId], pendingDelegations: pending } }
			: prev;
}

/** Test seam: drop the push subscription. */
export function __resetAutoRunDelegationListenerForTests(): void {
	unsubscribe?.();
	unsubscribe = null;
}

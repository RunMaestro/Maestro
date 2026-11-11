/**
 * autoRunDelegationStore - the work each Auto Run has handed to other agents.
 *
 * Fed by the main process's `autorun:delegation` push (see
 * `src/shared/autoRunDelegation.ts`), keyed by run id and then by the dispatch
 * callback id. Every client hears every push; only the one running the run
 * reads that run's entries, and a run that never started here simply has a
 * bucket nobody reads until it is dropped.
 *
 * The folding rules live in `applyAutoRunDelegationEvent` so they are tested
 * without zustand. Plain objects (not Maps) so shallow selectors work.
 */

import { create } from 'zustand';
import {
	applyAutoRunDelegationEvent,
	type AutoRunDelegation,
	type AutoRunDelegationEvent,
} from '../../shared/autoRunDelegation';

interface AutoRunDelegationState {
	/** runId -> callbackId -> delegation. */
	runs: Record<string, Record<string, AutoRunDelegation>>;
	/** Fold one lifecycle event into its run. */
	apply: (event: AutoRunDelegationEvent) => void;
	/**
	 * Settled results not yet handed to a turn, oldest first, marked reported in
	 * the same step so each result reaches exactly one turn.
	 */
	takeSettled: (runId: string) => AutoRunDelegation[];
	/** Forget a run once it has ended. */
	clearRun: (runId: string) => void;
}

export const useAutoRunDelegationStore = create<AutoRunDelegationState>()((set, get) => ({
	runs: {},
	apply: (event) =>
		set((state) => ({
			runs: {
				...state.runs,
				[event.autoRunId]: applyAutoRunDelegationEvent(state.runs[event.autoRunId] ?? {}, event),
			},
		})),
	takeSettled: (runId) => {
		const run = get().runs[runId];
		if (!run) return [];
		const taken = Object.values(run)
			.filter((d) => d.status !== 'pending' && !d.reported)
			.sort((a, b) => a.startedAt - b.startedAt);
		if (taken.length === 0) return [];
		const next = { ...run };
		for (const d of taken) next[d.callbackId] = { ...d, reported: true };
		set((state) => ({ runs: { ...state.runs, [runId]: next } }));
		return taken;
	},
	clearRun: (runId) =>
		set((state) => {
			if (!state.runs[runId]) return state;
			const runs = { ...state.runs };
			delete runs[runId];
			return { runs };
		}),
}));

/** The run's delegations that are still running. */
export function selectPendingDelegations(
	state: Pick<AutoRunDelegationState, 'runs'>,
	runId: string
): AutoRunDelegation[] {
	const run = state.runs[runId];
	return run ? Object.values(run).filter((d) => d.status === 'pending') : [];
}

/**
 * prCreationStore - in-flight `gh pr create` calls.
 *
 * The creation outlives its form. `CreatePRModal` is a VIEW over this store,
 * not the owner of the request: closing the modal leaves `gh` talking to
 * GitHub, and reopening the modal for the same repo re-attaches to the attempt
 * already going, with the title and branches that were actually submitted. That
 * is only possible because the status, PR url and error live here rather than
 * in component state, which the close would throw away.
 *
 * Same split the git console draws (see gitCommandRunStore):
 *   - close (X / Escape / backdrop / Run in Background) hides the form, the
 *     request continues and its outcome arrives as a toast
 *   - there is no cancel: `gh pr create` either opens the PR or it does not,
 *     and abandoning it midway would leave the branch pushed with no PR
 *
 * A run is keyed by repo path, so two agents on different worktrees can open
 * PRs at the same time while a second attempt on the SAME repo attaches instead
 * of racing a duplicate PR.
 */

import { create } from 'zustand';

export type PRCreationStatus = 'running' | 'success' | 'failed';

/** What the caller needs to start (or re-attach to) a creation. */
export interface PRCreationTarget {
	/** Agent the PR belongs to, so the toast and history entry land on it. */
	sessionId: string;
	/** Repo the PR is opened from. Also the run's identity. */
	worktreePath: string;
	sourceBranch: string;
	targetBranch: string;
	title: string;
	description: string;
}

export interface PRCreationRun extends PRCreationTarget {
	key: string;
	status: PRCreationStatus;
	/** Set once GitHub returns the PR. */
	prUrl?: string;
	error?: string;
	/** True once a host has toasted for this settlement. */
	announced: boolean;
}

interface PRCreationState {
	runs: Record<string, PRCreationRun>;
}

interface PRCreationActions {
	/**
	 * Start the request, or do nothing if one is already running for this repo
	 * (that case is a re-attach: the caller renders the existing run). A settled
	 * run is replaced, which is how a retry after a failure works.
	 */
	startPRCreation: (target: PRCreationTarget) => void;
	/** Mark a settled run as handled so it is reported exactly once. */
	markAnnounced: (key: string) => void;
	/** Forget a run entirely (settled and read). */
	clearRun: (key: string) => void;
}

export type PRCreationStore = PRCreationState & PRCreationActions;

/** Stable identity for "the PR being opened from this repo". */
export function prRunKey(worktreePath: string): string {
	return `pr:${worktreePath}`;
}

export const usePRCreationStore = create<PRCreationStore>()((set, get) => ({
	runs: {},

	startPRCreation: (target) => {
		const key = prRunKey(target.worktreePath);
		if (get().runs[key]?.status === 'running') return;

		set((state) => ({
			runs: { ...state.runs, [key]: { ...target, key, status: 'running', announced: false } },
		}));

		const settle = (patch: Partial<PRCreationRun>) =>
			set((state) => {
				const current = state.runs[key];
				// Cleared, or superseded by a later attempt, while we were awaiting.
				if (!current || current.status !== 'running') return state;
				return { runs: { ...state.runs, [key]: { ...current, ...patch, announced: false } } };
			});

		void window.maestro.git
			.createPR(target.worktreePath, target.targetBranch, target.title, target.description)
			.then((result) => {
				if (result.success && result.prUrl) {
					settle({ status: 'success', prUrl: result.prUrl });
				} else {
					settle({ status: 'failed', error: result.error || 'Failed to create PR' });
				}
			})
			.catch((err: unknown) => {
				settle({
					status: 'failed',
					error: err instanceof Error ? err.message : 'Failed to create PR',
				});
			});
	},

	markAnnounced: (key) =>
		set((state) => {
			const run = state.runs[key];
			if (!run || run.announced) return state;
			return { runs: { ...state.runs, [key]: { ...run, announced: true } } };
		}),

	clearRun: (key) =>
		set((state) => {
			if (!state.runs[key]) return state;
			const { [key]: _removed, ...rest } = state.runs;
			return { runs: rest };
		}),
}));

/** Subscribe to one run. Returns undefined once it has been cleared. */
export const selectPRRun = (key: string) => (state: PRCreationStore) => state.runs[key];

/**
 * Is a PR still being opened from this repo?
 *
 * For the menus that offer Create Pull Request and want to badge the row rather
 * than pretend nothing is happening. Returns a boolean, not the run, so a menu
 * only re-renders when the request starts or settles.
 */
export function usePRCreationActive(worktreePath: string | null | undefined): boolean {
	return usePRCreationStore((state) =>
		worktreePath ? state.runs[prRunKey(worktreePath)]?.status === 'running' : false
	);
}

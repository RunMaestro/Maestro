/**
 * gitCommandRunStore - in-flight `git pull` / `push` / `fetch` runs.
 *
 * The run outlives its console. `GitCommandRunnerModal` is a VIEW over this
 * store, not the owner of the command: closing the modal leaves the push
 * talking to the remote, and reopening the same operation on the same repo
 * re-attaches to the run already going, transcript and all. That is only
 * possible because the output buffer, status and error live here rather than
 * in component state, which a close would throw away.
 *
 * Two verbs, deliberately different:
 *   - close (the modal's X / Escape / backdrop) hides the console, run continues
 *   - cancel (the footer button) kills the command
 *
 * A run is keyed by operation + repo, so two agents on different worktrees can
 * push at the same time while a second Push on the SAME repo attaches instead
 * of racing a duplicate.
 */

import { create } from 'zustand';
import { gitService } from '../services/git';
import { generateId } from '../utils/ids';
import type { GitStreamingOperation, GitRunCommandResult } from '../../shared/gitUtils';

export type GitRunStatus = 'running' | 'success' | 'failed' | 'cancelled';

/** What the caller needs to start (or re-attach to) a run. */
export interface GitCommandRunTarget {
	sessionId: string;
	operation: GitStreamingOperation;
	cwd: string;
	sshRemoteId?: string;
	branch?: string;
}

export interface GitCommandRun extends GitCommandRunTarget {
	key: string;
	/** Current attempt's id - the "set upstream and retry" path mints a new one. */
	runId: string;
	setUpstream: boolean;
	output: string;
	status: GitRunStatus;
	error?: string;
	/** Timestamp the run settled; undefined while running. */
	settledAt?: number;
	/** True once a host has toasted / refreshed for this settlement. */
	announced: boolean;
}

/**
 * Transcript cap. A push whose pre-push hook runs a full test suite emits a
 * lot of output, and the tail is the part that says what happened.
 */
const MAX_OUTPUT_CHARS = 200_000;

interface GitCommandRunState {
	runs: Record<string, GitCommandRun>;
}

interface GitCommandRunActions {
	/**
	 * Start the operation, or do nothing if it is already running for this repo
	 * (that case is a re-attach: the caller renders the existing transcript).
	 */
	startRun: (target: GitCommandRunTarget) => void;
	/** Re-run as `push --set-upstream origin <branch>` after the no-upstream failure. */
	retryWithUpstream: (key: string) => void;
	/** Kill the command. Only meaningful while it is running. */
	cancelRun: (key: string) => void;
	/** Mark a settled run as handled so it is toasted exactly once. */
	markAnnounced: (key: string) => void;
	/** Forget a run entirely (settled and read, or superseded). */
	clearRun: (key: string) => void;
}

export type GitCommandRunStore = GitCommandRunState & GitCommandRunActions;

/** Stable identity for "this operation on this repo". */
export function gitRunKey(target: Pick<GitCommandRunTarget, 'operation' | 'cwd' | 'sshRemoteId'>) {
	return `${target.operation}:${target.sshRemoteId ?? 'local'}:${target.cwd}`;
}

/** runId -> key, so a chunk finds its run without scanning. */
const runKeyById = new Map<string, string>();

let unsubscribeOutput: (() => void) | null = null;

/**
 * One process-wide chunk listener, attached on the first run and never torn
 * down. Per-modal listeners were the reason a closed console lost the tail of
 * its own transfer.
 */
function ensureOutputSubscription(): void {
	if (unsubscribeOutput) return;
	unsubscribeOutput = gitService.onCommandOutput((chunk) => {
		const key = runKeyById.get(chunk.runId);
		if (!key) return;
		useGitCommandRunStore.setState((state) => {
			const run = state.runs[key];
			// A chunk that lands after its attempt was superseded belongs to the
			// old transcript; dropping it keeps retries from interleaving.
			if (!run || run.runId !== chunk.runId) return state;
			const combined = run.output + chunk.chunk;
			const output =
				combined.length > MAX_OUTPUT_CHARS ? combined.slice(-MAX_OUTPUT_CHARS) : combined;
			return { runs: { ...state.runs, [key]: { ...run, output } } };
		});
	});
}

export const useGitCommandRunStore = create<GitCommandRunStore>()((set, get) => {
	/** Fire the IPC call and fold its result back into the run. */
	const beginRun = (run: GitCommandRun) => {
		ensureOutputSubscription();
		runKeyById.set(run.runId, run.key);
		set((state) => ({ runs: { ...state.runs, [run.key]: run } }));

		void gitService
			.runCommand({
				runId: run.runId,
				operation: run.operation,
				cwd: run.cwd,
				sshRemoteId: run.sshRemoteId,
				setUpstream: run.setUpstream,
			})
			.then((result: GitRunCommandResult) => {
				runKeyById.delete(run.runId);
				set((state) => {
					const current = state.runs[run.key];
					// Superseded by a retry (or cleared) while we were awaiting.
					if (!current || current.runId !== run.runId) return state;
					return {
						runs: {
							...state.runs,
							[run.key]: {
								...current,
								status: result.cancelled ? 'cancelled' : result.success ? 'success' : 'failed',
								error: result.error,
								settledAt: Date.now(),
								announced: false,
							},
						},
					};
				});
			});
	};

	return {
		runs: {},

		startRun: (target) => {
			const key = gitRunKey(target);
			const existing = get().runs[key];
			if (existing?.status === 'running') return;
			beginRun({
				...target,
				key,
				runId: generateId(),
				setUpstream: false,
				output: '',
				status: 'running',
				error: undefined,
				settledAt: undefined,
				announced: false,
			});
		},

		retryWithUpstream: (key) => {
			const run = get().runs[key];
			if (!run || run.status === 'running') return;
			runKeyById.delete(run.runId);
			beginRun({
				...run,
				runId: generateId(),
				setUpstream: true,
				output: '',
				status: 'running',
				error: undefined,
				settledAt: undefined,
				announced: false,
			});
		},

		cancelRun: (key) => {
			const run = get().runs[key];
			if (!run || run.status !== 'running') return;
			void gitService.cancelCommand(run.runId);
		},

		markAnnounced: (key) =>
			set((state) => {
				const run = state.runs[key];
				if (!run || run.announced) return state;
				return { runs: { ...state.runs, [key]: { ...run, announced: true } } };
			}),

		clearRun: (key) =>
			set((state) => {
				const run = state.runs[key];
				if (!run) return state;
				runKeyById.delete(run.runId);
				const { [key]: _removed, ...rest } = state.runs;
				return { runs: rest };
			}),
	};
});

/** Subscribe to one run. Returns undefined once it has been cleared. */
export const selectGitRun = (key: string) => (state: GitCommandRunStore) => state.runs[key];

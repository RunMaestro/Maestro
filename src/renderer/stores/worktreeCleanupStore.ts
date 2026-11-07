import { create } from 'zustand';
import type {
	PendingRetirementRecovery,
	RetirementRemovalResult,
} from '../../shared/worktreeRetirement';
import { logger } from '../utils/logger';

export interface WorktreeCleanupTarget {
	sessionId: string;
	path?: string;
	name?: string;
}

export interface WorktreeCleanupRun extends WorktreeCleanupTarget {
	phase: 'preparing' | 'prepared' | 'keeping' | 'removing' | 'settled';
	busy: boolean;
	token?: string;
	result?: RetirementRemovalResult;
}

interface WorktreeCleanupState {
	runs: Record<string, WorktreeCleanupRun>;
	recoveries: PendingRetirementRecovery[];
	recoveryRuns: Record<
		string,
		{ target: PendingRetirementRecovery; busy: boolean; message?: string }
	>;
	recoveryError?: string;
	refreshRecoveries(): Promise<void>;
	recover(target: PendingRetirementRecovery, action: 'complete' | 'cancel'): Promise<void>;
	prepare(target: WorktreeCleanupTarget): Promise<void>;
	keep(sessionId: string): Promise<void>;
	remove(sessionId: string): Promise<void>;
	releasePreparation(sessionId: string): void;
	clearResult(sessionId: string): void;
}

/** Same-document transaction ownership, like gitCommandRunStore: closing a view
 * parks an active/uncertain removal. Never persist wire tokens across reloads;
 * Main's durable journal, primary revision and recovery protocol own that case.
 */
export const useWorktreeCleanupStore = create<WorktreeCleanupState>()((set, get) => {
	let recoveryRefresh = 0;
	const write = (run: WorktreeCleanupRun) =>
		set((state) => ({ runs: { ...state.runs, [run.sessionId]: run } }));
	const forget = (sessionId: string) =>
		set((state) => {
			const runs = { ...state.runs };
			delete runs[sessionId];
			return { runs };
		});
	const message = (error: unknown) =>
		error instanceof Error ? error.message : 'Cleanup reply unavailable';
	return {
		runs: {},
		recoveries: [],
		recoveryRuns: {},
		refreshRecoveries: async () => {
			const revision = ++recoveryRefresh;
			try {
				if (!window.maestro.git.getWorktreeRetirementRecoveries)
					throw new Error('Desktop cleanup recovery is unavailable');
				const recoveries = await window.maestro.git.getWorktreeRetirementRecoveries();
				if (revision === recoveryRefresh) set({ recoveries, recoveryError: undefined });
			} catch (error) {
				if (revision === recoveryRefresh) set({ recoveryError: message(error) });
			}
		},
		recover: async (target, action) => {
			if (get().recoveryRuns[target.id]?.busy) return;
			const writeRecovery = (busy: boolean, message?: string) =>
				set((state) => ({
					recoveryRuns: { ...state.recoveryRuns, [target.id]: { target, busy, message } },
				}));
			writeRecovery(true);
			try {
				if (action === 'complete') {
					const result = await window.maestro.git.completeWorktreeRetirementRecovery(target.id);
					writeRecovery(
						false,
						result.status === 'removed'
							? 'Recovery complete. Saved chat and history are archived; the branch is preserved.'
							: `Recovery ${result.status}: ${result.reason}`
					);
				} else {
					const result = await window.maestro.git.cancelWorktreeRetirementRecovery(target.id);
					writeRecovery(
						false,
						result.ok
							? 'Recovery cancelled. The checkout and registrations are kept.'
							: `Recovery blocked: ${result.reason}`
					);
				}
			} catch (error) {
				writeRecovery(
					false,
					`Recovery reply unavailable: ${message(error)}. Refresh and retry the same recovery.`
				);
			} finally {
				await get().refreshRecoveries();
			}
		},
		prepare: async (target) => {
			const current = get().runs[target.sessionId];
			if (current?.busy || current?.token) return;
			const run: WorktreeCleanupRun = { ...target, phase: 'preparing', busy: true };
			write(run);
			try {
				const prepared = await window.maestro.git.prepareWorktreeRetirement(target.sessionId);
				if (get().runs[target.sessionId] !== run) {
					if (prepared.ok) await window.maestro.git.abortWorktreeRetirement(prepared.token);
					return;
				}
				write(
					prepared.ok
						? { ...run, phase: 'prepared', busy: false, token: prepared.token }
						: {
								...run,
								phase: 'settled',
								busy: false,
								result: { status: 'blocked', reason: prepared.reason },
							}
				);
			} catch (error) {
				if (get().runs[target.sessionId] === run)
					write({
						...run,
						phase: 'settled',
						busy: false,
						result: { status: 'blocked', reason: message(error) },
					});
				else logger.warn('Late preparation release unavailable', 'WorktreeCleanup', String(error));
			}
		},
		keep: async (sessionId) => {
			const current = get().runs[sessionId];
			if (!current?.token || current.busy || current.phase === 'removing') return;
			// Only a previously uncommitted preparation may take this path. A lost
			// commit reply must stay a removal settlement retry, never an abort.
			if (current.result?.status === 'pending' && current.phase !== 'keeping') return;
			const run: WorktreeCleanupRun = { ...current, phase: 'keeping', busy: true };
			write(run);
			try {
				const aborted = await window.maestro.git.abortWorktreeRetirement(run.token!);
				if (get().runs[sessionId] !== run) return;
				if (aborted) forget(sessionId);
				else
					write({
						...run,
						busy: false,
						result: {
							status: 'pending',
							reason: 'Preparation release is pending. Retry keeping checkout.',
						},
					});
			} catch (error) {
				if (get().runs[sessionId] === run)
					write({ ...run, busy: false, result: { status: 'pending', reason: message(error) } });
			}
		},
		remove: async (sessionId) => {
			const current = get().runs[sessionId];
			if (!current?.token || current.busy || current.phase === 'keeping') return;
			const run: WorktreeCleanupRun = { ...current, phase: 'removing', busy: true };
			write(run);
			try {
				const result = await window.maestro.git.removeWorktreeRetirement(run.token!);
				write({
					...run,
					phase: 'settled',
					busy: false,
					token: result.status === 'pending' ? run.token : undefined,
					result,
				});
			} catch (error) {
				// Keep the original capability after an uncertain commit. Main either
				// resumes settlement or replays its receipt, without repeating Git.
				write({
					...run,
					phase: 'settled',
					busy: false,
					result: { status: 'pending', reason: message(error) },
				});
			}
		},
		releasePreparation: (sessionId) => {
			const run = get().runs[sessionId];
			if (run?.phase === 'preparing') forget(sessionId); // Late reply aborts only its own token.
			if (run?.phase === 'prepared') void get().keep(sessionId);
		},
		clearResult: (sessionId) => {
			const run = get().runs[sessionId];
			if (run && !run.busy && !run.token) forget(sessionId);
		},
	};
});

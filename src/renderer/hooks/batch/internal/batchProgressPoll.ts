import type { BatchRunState, Session } from '../../../types';
import { DEFAULT_BATCH_STATE } from '../batchReducer';

interface DocRef {
	filename: string;
}

interface ReadResult {
	taskCount: number;
	checkedCount: number;
	content: string;
}

export interface ProgressPollDeps {
	documents: ReadonlyArray<DocRef>;
	docEntry: DocRef;
	folderPath: string;
	sshRemoteId: string | undefined;
	sessionId: string;
	intervalMs: number;
	readDocAndCountTasks: (
		folderPath: string,
		filename: string,
		sshRemoteId?: string
	) => Promise<ReadResult>;
	updateBatchState: (
		sessionId: string,
		updater: (prev: Record<string, BatchRunState>) => Record<string, BatchRunState>,
		immediate?: boolean
	) => void;
	getSessions: () => Session[];
	onUpdateSession: (sessionId: string, updates: Partial<Session>) => void;
}

export interface ProgressPollController {
	start: () => Promise<void>;
	stop: () => void;
	restart: () => Promise<void>;
}

/**
 * Build a per-task progress poller for the currently-processing document.
 *
 * The poller snapshots task counts of every other document once (they cannot
 * change while the agent works on `docEntry`), then re-reads `docEntry` on
 * an interval and dispatches batch-state updates whenever the totals shift.
 *
 * It also refreshes `autoRunContent` on the session if the user is viewing
 * a document, so the renderer stays in sync even when filesystem watcher
 * events are coalesced or dropped.
 *
 * Generation tracking guards against stale results from in-flight polls
 * after `stop()` or `restart()`.
 */
export function createProgressPoll(deps: ProgressPollDeps): ProgressPollController {
	const {
		documents,
		docEntry,
		folderPath,
		sshRemoteId,
		sessionId,
		intervalMs,
		readDocAndCountTasks,
		updateBatchState,
		getSessions,
		onUpdateSession,
	} = deps;

	let active = false;
	let inFlight = false;
	let generation = 0;
	let scheduled: ReturnType<typeof setTimeout> | null = null;
	let otherDocsTotal = 0;
	let otherDocsChecked = 0;
	let baselineComputed = false;

	const computeBaseline = async () => {
		if (baselineComputed) return;
		baselineComputed = true;
		for (const doc of documents) {
			if (doc.filename === docEntry.filename) continue;
			try {
				const r = await readDocAndCountTasks(folderPath, doc.filename, sshRemoteId);
				otherDocsTotal += r.taskCount + r.checkedCount;
				otherDocsChecked += r.checkedCount;
			} catch {
				// Ignore - baseline is best-effort.
			}
		}
	};

	const tick = async () => {
		if (!active || inFlight) return;
		const gen = generation;
		inFlight = true;
		try {
			const r = await readDocAndCountTasks(folderPath, docEntry.filename, sshRemoteId);
			const polledTotal = otherDocsTotal + r.taskCount + r.checkedCount;
			const polledChecked = otherDocsChecked + r.checkedCount;
			if (!active || gen !== generation) return;
			updateBatchState(sessionId, (prev) => {
				const prevState = prev[sessionId] || DEFAULT_BATCH_STATE;
				if (
					polledChecked === prevState.completedTasksAcrossAllDocs &&
					polledTotal === prevState.totalTasksAcrossAllDocs
				) {
					return prev;
				}
				return {
					...prev,
					[sessionId]: {
						...prevState,
						completedTasksAcrossAllDocs: polledChecked,
						totalTasksAcrossAllDocs: Math.max(0, polledTotal),
					},
				};
			});

			// Keep the displayed document content fresh during batch runs, even if
			// file watcher events are coalesced or dropped.
			const currentSession = getSessions().find((s) => s.id === sessionId);
			const selectedDoc = currentSession?.autoRunSelectedFile;
			if (selectedDoc) {
				const selectedDocResult = await window.maestro.autorun.readDoc(
					folderPath,
					selectedDoc + '.md',
					sshRemoteId
				);
				if (selectedDocResult.success) {
					if (!active || gen !== generation) return;
					const nextContent = selectedDocResult.content || '';
					if (nextContent !== currentSession.autoRunContent) {
						onUpdateSession(sessionId, {
							autoRunContent: nextContent,
							autoRunContentVersion: (currentSession.autoRunContentVersion || 0) + 1,
						});
					}
				}
			}
		} catch {
			// Ignore polling errors - agent may be modifying file.
		} finally {
			inFlight = false;
			if (active && gen === generation) {
				scheduled = setTimeout(() => {
					void tick();
				}, intervalMs);
			}
		}
	};

	const stop = () => {
		active = false;
		generation++;
		if (scheduled) {
			clearTimeout(scheduled);
			scheduled = null;
		}
	};

	const start = async () => {
		active = true;
		generation++;
		// Compute the baseline counts of every other document before scheduling
		// the first tick. They cannot change while the agent works on
		// `docEntry`, so the read happens once and is reused across every poll.
		await computeBaseline();
		if (!active) return;
		scheduled = setTimeout(() => {
			void tick();
		}, intervalMs);
	};

	const restart = async () => {
		stop();
		await start();
	};

	return { start, stop, restart };
}

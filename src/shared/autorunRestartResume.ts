/**
 * Auto Run restart resume: the place a running Auto Run is saved at when the
 * app quits (to install an update, or because the user quit with a run going),
 * so the next launch can continue it.
 *
 * A document run keeps its real progress on disk already: every finished task
 * is a checked box. What the disk does NOT hold is where the loop was - which
 * document of the playbook it was on, which loop pass, and which working copy
 * a reset-on-completion document was being worked in. Starting the same
 * playbook from the top would re-run every reset document before the one it
 * stopped on, and would hand a capped loop a fresh loop budget. The resume
 * point carries exactly those three facts.
 *
 * A goal run has no on-disk cursor at all, so it resumes as a new goal loop
 * with the iterations it already spent taken off its budget.
 *
 * The entry is written by the renderer that owns the run and read once by the
 * next launch. The run's config is opaque here (it is the renderer's
 * `BatchRunConfig`); main stores it as JSON and never looks inside.
 */

/** Where a document run continues from. */
export interface AutoRunResumePoint {
	/** Index into the run's `documents` the first resumed pass starts at. */
	documentIndex: number;
	/** 0-based loop pass the run was on, so `maxLoops` keeps counting. */
	loopIteration: number;
	/**
	 * Working copy (folder-relative, no `.md`) the document at `documentIndex`
	 * was being processed in, when it is a reset-on-completion document. The
	 * resumed run keeps working in it instead of copying the original again,
	 * which would throw away the tasks it had already checked off.
	 */
	workingCopyPath?: string;
}

/** Why the app quit with the run going. Decides how long the entry is kept. */
export type AutoRunRestartReason = 'update' | 'quit';

/** One saved run. `TConfig` is the renderer's `BatchRunConfig`. */
export interface AutoRunRestartEntry<TConfig = unknown> {
	/** Agent the run executes on (the batch-store key). */
	sessionId: string;
	/** Agent name at save time, for the toast if the agent is gone on launch. */
	sessionName?: string;
	/** Auto Run folder the documents live in (may belong to the parent agent). */
	folderPath: string;
	/** The config the run was launched with, minus any earlier resume point. */
	config: TConfig;
	/** Document cursor. Ignored by goal runs. */
	resumeFrom: AutoRunResumePoint;
	/** Goal iterations already finished, for goal runs only. */
	goalIterationsCompleted?: number;
	/** Why the app quit. Absent in entries written before quits were saved. */
	reason?: AutoRunRestartReason;
	/** Epoch ms the entry was written. */
	savedAt: number;
}

/**
 * How long a run saved for an UPDATE restart stays resumable.
 *
 * The entry is written the moment the user clicks restart, and an update
 * relaunches within a minute. An entry older than this means the restart never
 * happened (the install failed and the app kept running), and the run it
 * describes has since finished or been stopped by hand. Resuming it then would
 * re-run a playbook nobody asked to run again.
 */
export const AUTO_RUN_RESTART_RESUME_TTL_MS = 60 * 60 * 1000;

/**
 * How long a run saved by a normal QUIT stays resumable.
 *
 * The entry is written only once the user confirmed the quit, so the app did
 * go down, and the user may reopen it the next morning or after a weekend.
 * Past a week the documents have likely moved on without it, so the run is
 * dropped rather than started against them.
 */
export const AUTO_RUN_QUIT_RESUME_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function restartEntryTtlMs(reason: AutoRunRestartReason | undefined): number {
	return reason === 'quit' ? AUTO_RUN_QUIT_RESUME_TTL_MS : AUTO_RUN_RESTART_RESUME_TTL_MS;
}

export function isRestartEntryFresh(
	entry: Pick<AutoRunRestartEntry, 'savedAt' | 'reason'>,
	now: number = Date.now()
): boolean {
	const age = now - entry.savedAt;
	return age >= 0 && age <= restartEntryTtlMs(entry.reason);
}

/**
 * Iteration budget for a resumed goal run.
 *
 * `null` (infinite) stays infinite. A finite budget loses the iterations
 * already finished, but never drops below one: the iteration in flight when
 * the app quit did not finish, so it still has to run.
 */
export function remainingGoalIterations(
	maxIterations: number | null,
	completed: number
): number | null {
	if (maxIterations === null) return null;
	return Math.max(1, maxIterations - Math.max(0, completed));
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * Validate entries read back from disk. Anything malformed is dropped rather
 * than thrown on: a bad file must not stop the app from launching, and an
 * entry we cannot trust is one we must not run.
 */
export function parseRestartEntries(raw: unknown): AutoRunRestartEntry[] {
	if (!Array.isArray(raw)) return [];
	const entries: AutoRunRestartEntry[] = [];
	for (const item of raw) {
		if (!item || typeof item !== 'object') continue;
		const candidate = item as Record<string, unknown>;
		const resumeFrom = candidate.resumeFrom as Record<string, unknown> | undefined;
		if (
			typeof candidate.sessionId !== 'string' ||
			candidate.sessionId === '' ||
			typeof candidate.folderPath !== 'string' ||
			typeof candidate.savedAt !== 'number' ||
			!candidate.config ||
			typeof candidate.config !== 'object' ||
			!resumeFrom ||
			!isNonNegativeInteger(resumeFrom.documentIndex) ||
			!isNonNegativeInteger(resumeFrom.loopIteration)
		) {
			continue;
		}
		entries.push({
			sessionId: candidate.sessionId,
			...(typeof candidate.sessionName === 'string' && { sessionName: candidate.sessionName }),
			folderPath: candidate.folderPath,
			config: candidate.config,
			resumeFrom: {
				documentIndex: resumeFrom.documentIndex,
				loopIteration: resumeFrom.loopIteration,
				...(typeof resumeFrom.workingCopyPath === 'string' &&
					resumeFrom.workingCopyPath !== '' && { workingCopyPath: resumeFrom.workingCopyPath }),
			},
			...(isNonNegativeInteger(candidate.goalIterationsCompleted) && {
				goalIterationsCompleted: candidate.goalIterationsCompleted,
			}),
			...((candidate.reason === 'update' || candidate.reason === 'quit') && {
				reason: candidate.reason,
			}),
			savedAt: candidate.savedAt,
		});
	}
	return entries;
}

/** Replace entries for the same agent, keep the rest. */
export function mergeRestartEntries<T extends Pick<AutoRunRestartEntry, 'sessionId'>>(
	existing: T[],
	incoming: T[]
): T[] {
	const incomingIds = new Set(incoming.map((e) => e.sessionId));
	return [...existing.filter((e) => !incomingIds.has(e.sessionId)), ...incoming];
}

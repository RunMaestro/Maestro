/**
 * Stats indexing: the long transcript scans behind the usage caches, reported
 * so a surface can show how far along they are.
 *
 * A scan has two causes and the user is told which one is running:
 *  - `upgrade`: a cache version bump. The DERIVATION changed (a counting fix),
 *    which no mtime/size fingerprint can see, so every live transcript is read
 *    again once. On a machine with gigabytes of history this is the slow one.
 *  - `index`: nothing was cached yet (a fresh install, a new account dir).
 *
 * The main process owns the state (`src/main/stats/stats-indexing.ts`); the
 * renderer and the CLI only read it. Pure and import-free so the desktop
 * modal, the web-desktop mirror and `maestro-cli stats-indexing` share the
 * same arithmetic and cannot disagree about what "done" means.
 */

export type StatsIndexingReason = 'upgrade' | 'index';

/** One scan, aggregated across every caller that joined its `id`. */
export interface StatsIndexingJob {
	/** Stable group key, e.g. `global-stats` or `session-index`. */
	id: string;
	/** Short noun phrase for what is being built, e.g. "Usage totals". */
	label: string;
	/** `upgrade` wins when any participant is upgrading. */
	reason: StatsIndexingReason;
	doneFiles: number;
	totalFiles: number;
	doneBytes: number;
	totalBytes: number;
	startedAt: number;
	updatedAt: number;
}

export interface StatsIndexingState {
	jobs: StatsIndexingJob[];
}

export const EMPTY_STATS_INDEXING_STATE: StatsIndexingState = { jobs: [] };

/**
 * Files a job must cover before it is worth showing. Opening a dashboard
 * routinely parses a handful of new transcripts in well under a second, and a
 * modal that flashes for that is noise, not information.
 */
export const STATS_INDEXING_VISIBLE_MIN_FILES = 25;

/** Bytes that must be done before an ETA is offered (the first files skew it). */
export const STATS_INDEXING_ETA_MIN_FRACTION = 0.05;

/** Milliseconds a scan must have run before an ETA is offered. */
export const STATS_INDEXING_ETA_MIN_ELAPSED_MS = 3000;

/** Jobs large enough to report. */
export function visibleIndexingJobs(state: StatsIndexingState): StatsIndexingJob[] {
	return state.jobs.filter((job) => job.totalFiles >= STATS_INDEXING_VISIBLE_MIN_FILES);
}

export interface StatsIndexingSummary {
	reason: StatsIndexingReason;
	labels: string[];
	doneFiles: number;
	totalFiles: number;
	doneBytes: number;
	totalBytes: number;
	/** 0-1, by bytes: transcript sizes span six orders of magnitude, file counts lie. */
	fraction: number;
	/** Projected time left, or undefined while the pace is not yet knowable. */
	etaMs?: number;
}

/**
 * Everything visible, folded into one bar. Returns null when nothing is worth
 * showing, so a caller can gate rendering on the summary alone.
 */
export function summarizeStatsIndexing(
	state: StatsIndexingState,
	now: number
): StatsIndexingSummary | null {
	const jobs = visibleIndexingJobs(state);
	if (jobs.length === 0) return null;

	let doneFiles = 0;
	let totalFiles = 0;
	let doneBytes = 0;
	let totalBytes = 0;
	let startedAt = Number.POSITIVE_INFINITY;
	for (const job of jobs) {
		doneFiles += job.doneFiles;
		totalFiles += job.totalFiles;
		doneBytes += job.doneBytes;
		totalBytes += job.totalBytes;
		startedAt = Math.min(startedAt, job.startedAt);
	}

	const fraction =
		totalBytes > 0
			? clampFraction(doneBytes / totalBytes)
			: totalFiles > 0
				? clampFraction(doneFiles / totalFiles)
				: 0;

	return {
		reason: jobs.some((job) => job.reason === 'upgrade') ? 'upgrade' : 'index',
		labels: jobs.map((job) => job.label),
		doneFiles,
		totalFiles,
		doneBytes,
		totalBytes,
		fraction,
		etaMs: estimateRemainingMs(fraction, now - startedAt),
	};
}

/** Remaining time at the pace so far, or undefined while it is still warming up. */
export function estimateRemainingMs(fraction: number, elapsedMs: number): number | undefined {
	if (fraction < STATS_INDEXING_ETA_MIN_FRACTION) return undefined;
	if (elapsedMs < STATS_INDEXING_ETA_MIN_ELAPSED_MS) return undefined;
	if (fraction >= 1) return 0;
	return (elapsedMs / fraction) * (1 - fraction);
}

function clampFraction(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(1, Math.max(0, value));
}

/** Heading for the progress surface. */
export function statsIndexingTitle(reason: StatsIndexingReason): string {
	return reason === 'upgrade' ? 'Upgrading usage data' : 'Indexing session history';
}

/** One-sentence explanation shown under the heading. */
export function statsIndexingExplanation(reason: StatsIndexingReason): string {
	return reason === 'upgrade'
		? 'This version counts tokens and cost more accurately, so Maestro is reading your session history once. Progress is kept if you quit.'
		: 'Maestro is reading your session history for the first time. Progress is kept if you quit.';
}

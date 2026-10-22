/**
 * Stats indexing registry: the main-process source of truth for how far the
 * long transcript scans have got (see `src/shared/statsIndexing.ts`).
 *
 * A scan joins a group by `id`, so the per-project `listSessions` calls the
 * token-usage accessor makes in parallel all feed ONE bar instead of a modal per
 * project folder. A group ends when its last participant ends.
 *
 * Deliberately electron-free: the broadcaster is injected by the stats IPC
 * registration, so this module can be driven by a unit test, and a scan that
 * runs with no window open (the CLI asking for token usage) still updates the
 * state `maestro-cli stats-indexing` reads.
 */

import {
	EMPTY_STATS_INDEXING_STATE,
	visibleIndexingJobs,
	type StatsIndexingJob,
	type StatsIndexingReason,
	type StatsIndexingState,
} from '../../shared/statsIndexing';

/** Push channel the renderer subscribes to. */
export const STATS_INDEXING_CHANNEL = 'stats:indexingUpdate';

/** Progress pushes are coalesced to this interval; begin and end push at once. */
export const STATS_INDEXING_BROADCAST_INTERVAL_MS = 250;

export interface BeginStatsIndexingOptions {
	id: string;
	label: string;
	reason: StatsIndexingReason;
}

/** One participant's view of a group. Every method is a no-op after `end()`. */
export interface StatsIndexingHandle {
	/** Declare work this participant will do. May be called more than once. */
	addWork(files: number, bytes: number): void;
	/** Record finished work. A failed file still counts: it will not be retried. */
	advance(files: number, bytes: number): void;
	end(): void;
}

interface GroupState {
	job: StatsIndexingJob;
	participants: number;
}

const groups = new Map<string, GroupState>();
let broadcaster: ((state: StatsIndexingState) => void) | null = null;
let pendingBroadcast: ReturnType<typeof setTimeout> | null = null;
/** Whether the last push carried a job large enough to show. */
let lastPushVisible = false;

/** Wire the push. Called once from the stats IPC registration. */
export function setStatsIndexingBroadcaster(
	next: ((state: StatsIndexingState) => void) | null
): void {
	broadcaster = next;
}

export function getStatsIndexingState(): StatsIndexingState {
	if (groups.size === 0) return EMPTY_STATS_INDEXING_STATE;
	return { jobs: [...groups.values()].map((group) => ({ ...group.job })) };
}

export function beginStatsIndexing(options: BeginStatsIndexingOptions): StatsIndexingHandle {
	const now = Date.now();
	let group = groups.get(options.id);
	if (!group) {
		group = {
			job: {
				id: options.id,
				label: options.label,
				reason: options.reason,
				doneFiles: 0,
				totalFiles: 0,
				doneBytes: 0,
				totalBytes: 0,
				startedAt: now,
				updatedAt: now,
			},
			participants: 0,
		};
		groups.set(options.id, group);
	} else if (options.reason === 'upgrade') {
		group.job.reason = 'upgrade';
	}
	group.participants += 1;
	const owned = group;
	let ended = false;

	return {
		addWork(files, bytes) {
			if (ended) return;
			owned.job.totalFiles += files;
			owned.job.totalBytes += bytes;
			owned.job.updatedAt = Date.now();
			scheduleBroadcast();
		},
		advance(files, bytes) {
			if (ended) return;
			owned.job.doneFiles = Math.min(owned.job.totalFiles, owned.job.doneFiles + files);
			owned.job.doneBytes = Math.min(owned.job.totalBytes, owned.job.doneBytes + bytes);
			owned.job.updatedAt = Date.now();
			scheduleBroadcast();
		},
		end() {
			if (ended) return;
			ended = true;
			owned.participants -= 1;
			if (owned.participants <= 0 && groups.get(owned.job.id) === owned) {
				groups.delete(owned.job.id);
			}
			broadcastNow();
		},
	};
}

/**
 * Run `work` as a participant of a group, ending it however `work` settles.
 * The `end()` in a `finally` is the whole point: a scan that throws must not
 * leave a bar on screen at 40% forever.
 */
export async function withStatsIndexing<T>(
	options: BeginStatsIndexingOptions,
	work: (handle: StatsIndexingHandle) => Promise<T>
): Promise<T> {
	const handle = beginStatsIndexing(options);
	try {
		return await work(handle);
	} finally {
		handle.end();
	}
}

function scheduleBroadcast(): void {
	if (pendingBroadcast) return;
	pendingBroadcast = setTimeout(() => {
		pendingBroadcast = null;
		push();
	}, STATS_INDEXING_BROADCAST_INTERVAL_MS);
}

function broadcastNow(): void {
	if (pendingBroadcast) {
		clearTimeout(pendingBroadcast);
		pendingBroadcast = null;
	}
	push();
}

/**
 * Push the state to every window, unless nothing visible changed. Listing one
 * project's sessions opens a group for a handful of files several times a
 * minute; none of that is ever shown, so it must not cost every window an IPC
 * message. The push that takes the last visible job away still goes out, so a
 * bar on screen is always cleared.
 */
function push(): void {
	const state = getStatsIndexingState();
	const visible = visibleIndexingJobs(state).length > 0;
	if (!visible && !lastPushVisible) return;
	lastPushVisible = visible;
	broadcaster?.(state);
}

/** Test seam: forget every group and any pending push. */
export function resetStatsIndexingForTest(): void {
	groups.clear();
	if (pendingBroadcast) clearTimeout(pendingBroadcast);
	pendingBroadcast = null;
	broadcaster = null;
	lastPushVisible = false;
}

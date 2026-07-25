/**
 * scheduledAutoRunStore.ts
 *
 * Holds one-shot Auto Run schedules: a run the user configured in the Auto Run
 * modal but asked to start at a future date/time rather than immediately. One
 * pending schedule per agent (scheduling again replaces the previous one).
 *
 * The dispatcher (useScheduledAutoRunDispatcher) polls this store and launches
 * each entry once its `scheduledFor` passes. Entries are mirrored into the
 * generic settings KV store so a schedule survives an app restart - the primary
 * use case is "kick this off when my token limit resets in 5 hours", which
 * routinely outlives a single app session.
 */

import { create } from 'zustand';
import type { BatchRunConfig } from '../types';
import { logger } from '../utils/logger';

/** Settings KV key holding the persisted schedule list. */
export const SCHEDULED_AUTO_RUNS_SETTINGS_KEY = 'scheduledAutoRuns';

/**
 * How long after `scheduledFor` a missed schedule is still worth firing.
 * Mirrors the Cue `time.once` default grace window (6h) so both scheduling
 * surfaces behave the same when the app was closed at the fire time.
 */
export const SCHEDULED_AUTO_RUN_GRACE_MS = 6 * 60 * 60 * 1000;

export interface ScheduledAutoRun {
	/** Agent the run belongs to (the run's launch target may still be a worktree). */
	sessionId: string;
	/** Auto Run folder the documents were resolved against at schedule time. */
	folderPath: string;
	/** Full run config, minus `scheduledFor` (the timestamp lives below). */
	config: BatchRunConfig;
	/** Epoch ms at which the run should start. */
	scheduledFor: number;
	/** Epoch ms the schedule was created - used only for display/debugging. */
	createdAt: number;
}

interface ScheduledAutoRunState {
	/** Pending schedules keyed by sessionId. */
	scheduled: Record<string, ScheduledAutoRun>;
	/** True once the persisted list has been read back from settings. */
	hydrated: boolean;
	/** Load persisted schedules. Safe to call more than once; only the first wins. */
	hydrate: () => Promise<void>;
	/** Park a run for later. Replaces any existing schedule for the same agent. */
	schedule: (entry: ScheduledAutoRun) => void;
	/** Drop the pending schedule for an agent (user cancel, fired, or expired). */
	cancel: (sessionId: string) => void;
}

/** Write the current map back to the settings KV store. Fire-and-forget. */
function persist(scheduled: Record<string, ScheduledAutoRun>): void {
	// Guard for non-Electron contexts (tests, web-desktop bootstrap ordering).
	if (typeof window === 'undefined' || !window.maestro?.settings) return;
	void window.maestro.settings
		.set(SCHEDULED_AUTO_RUNS_SETTINGS_KEY, Object.values(scheduled))
		.catch((err: unknown) => {
			logger.warn('[scheduledAutoRunStore] Failed to persist schedules', undefined, err);
		});
}

/** Shape-check a persisted entry - stored JSON is untrusted across versions. */
function isValidEntry(value: unknown): value is ScheduledAutoRun {
	if (!value || typeof value !== 'object') return false;
	const entry = value as Partial<ScheduledAutoRun>;
	return (
		typeof entry.sessionId === 'string' &&
		typeof entry.folderPath === 'string' &&
		typeof entry.scheduledFor === 'number' &&
		Number.isFinite(entry.scheduledFor) &&
		!!entry.config &&
		typeof entry.config === 'object'
	);
}

export const useScheduledAutoRunStore = create<ScheduledAutoRunState>((set, get) => ({
	scheduled: {},
	hydrated: false,

	hydrate: async () => {
		if (get().hydrated) return;
		let stored: unknown = null;
		if (typeof window !== 'undefined' && window.maestro?.settings) {
			try {
				stored = await window.maestro.settings.get(SCHEDULED_AUTO_RUNS_SETTINGS_KEY);
			} catch (err) {
				logger.warn('[scheduledAutoRunStore] Failed to read schedules', undefined, err);
			}
		}
		const next: Record<string, ScheduledAutoRun> = {};
		if (Array.isArray(stored)) {
			for (const entry of stored) {
				if (isValidEntry(entry)) {
					next[entry.sessionId] = { ...entry, createdAt: entry.createdAt ?? entry.scheduledFor };
				}
			}
		}
		set({ scheduled: next, hydrated: true });
	},

	schedule: (entry) => {
		const scheduled = { ...get().scheduled, [entry.sessionId]: entry };
		set({ scheduled });
		persist(scheduled);
	},

	cancel: (sessionId) => {
		const current = get().scheduled;
		if (!(sessionId in current)) return;
		const scheduled = { ...current };
		delete scheduled[sessionId];
		set({ scheduled });
		persist(scheduled);
	},
}));

/** Non-React accessor for callers outside components (handlers, dispatchers). */
export const getScheduledAutoRunActions = () => {
	const { hydrate, schedule, cancel } = useScheduledAutoRunStore.getState();
	return { hydrate, schedule, cancel };
};

/** Selector: the pending schedule for one agent, or undefined. */
export const selectScheduledAutoRun =
	(sessionId: string | null | undefined) =>
	(state: ScheduledAutoRunState): ScheduledAutoRun | undefined =>
		sessionId ? state.scheduled[sessionId] : undefined;

/**
 * Partition schedules against the clock.
 *
 * - `due`: fire now (the timestamp passed and we're inside the grace window).
 * - `expired`: the app was closed/asleep past the grace window - drop without
 *   firing rather than surprising the user with a run hours after they expected
 *   it. Mirrors the Cue `time.once` missed-fire policy.
 *
 * Pure so the timing policy is unit-testable without fake timers.
 */
export function partitionScheduledAutoRuns(
	scheduled: Record<string, ScheduledAutoRun>,
	now: number,
	graceMs: number = SCHEDULED_AUTO_RUN_GRACE_MS
): { due: ScheduledAutoRun[]; expired: ScheduledAutoRun[] } {
	const due: ScheduledAutoRun[] = [];
	const expired: ScheduledAutoRun[] = [];
	for (const entry of Object.values(scheduled)) {
		if (entry.scheduledFor > now) continue;
		if (now - entry.scheduledFor > graceMs) {
			expired.push(entry);
		} else {
			due.push(entry);
		}
	}
	return { due, expired };
}

/**
 * snoozeHistoryStore - the log of snoozes that have ended.
 *
 * Every snooze eventually resolves: it wakes on schedule, the user brings it
 * back early, or they dismiss it. Once that happens the entry leaves
 * `session.snoozedTabs` and would otherwise vanish, taking its note-to-self
 * with it. This store keeps the tail of those resolutions so the user can look
 * back at what they parked, why, and when it came back.
 *
 * Bounded by design: a fixed cap with the oldest entry dropped on overflow, so
 * a heavy snooze user can't grow the settings file without limit. Newest first,
 * which is both the display order and the order the cap trims from.
 *
 * Persisted through the settings store (a single small array), hydrated on
 * startup by settingsStore's loader alongside the other cross-store keys.
 */

import { create } from 'zustand';
import type { SnoozeHistoryEntry, SnoozeResolution } from '../types';
import { generateId } from '../utils/ids';
import { logger } from '../utils/logger';

/** Settings key the history array persists under. */
export const SNOOZE_HISTORY_SETTINGS_KEY = 'snoozeHistory';

/** How many resolved snoozes to keep. Oldest are dropped past this. */
export const MAX_SNOOZE_HISTORY = 100;

/** Fields a caller supplies; the store stamps `id`. */
export type SnoozeHistoryInput = Omit<SnoozeHistoryEntry, 'id'>;

interface SnoozeHistoryState {
	/** Resolved snoozes, newest first. */
	entries: SnoozeHistoryEntry[];
	/** Record a snooze that just ended. Returns the stored entry. */
	recordResolution: (input: SnoozeHistoryInput) => SnoozeHistoryEntry;
	/** Drop the whole log. */
	clearHistory: () => void;
}

function persist(entries: SnoozeHistoryEntry[]): void {
	try {
		window.maestro?.settings?.set(SNOOZE_HISTORY_SETTINGS_KEY, entries);
	} catch (err) {
		// History is a convenience, never worth breaking a wake or dismiss over.
		logger.warn(`Failed to persist snooze history: ${err}`);
	}
}

export const useSnoozeHistoryStore = create<SnoozeHistoryState>()((set, get) => ({
	entries: [],

	recordResolution: (input) => {
		const entry: SnoozeHistoryEntry = { ...input, id: generateId() };
		// Newest first, trimmed from the tail so the oldest falls off.
		const entries = [entry, ...get().entries].slice(0, MAX_SNOOZE_HISTORY);
		set({ entries });
		persist(entries);
		return entry;
	},

	clearHistory: () => {
		set({ entries: [] });
		persist([]);
	},
}));

const RESOLUTIONS: SnoozeResolution[] = ['woke', 'unsnoozed', 'dismissed'];

/**
 * Validate and normalise a persisted history array.
 *
 * Runs over data read back from disk, which may predate a field or have been
 * hand-edited, so every entry is checked before it reaches the UI. Invalid
 * entries are dropped rather than rendered as blanks, and the cap is re-applied
 * in case it was lowered since the file was written.
 */
export function sanitizeSnoozeHistory(value: unknown): SnoozeHistoryEntry[] {
	if (!Array.isArray(value)) return [];

	const entries: SnoozeHistoryEntry[] = [];
	for (const raw of value) {
		if (!raw || typeof raw !== 'object') continue;
		const candidate = raw as Record<string, unknown>;
		if (
			typeof candidate.label !== 'string' ||
			typeof candidate.resolvedAt !== 'number' ||
			!RESOLUTIONS.includes(candidate.resolution as SnoozeResolution)
		) {
			continue;
		}
		entries.push({
			id: typeof candidate.id === 'string' ? candidate.id : generateId(),
			label: candidate.label,
			sessionId: typeof candidate.sessionId === 'string' ? candidate.sessionId : '',
			sessionName: typeof candidate.sessionName === 'string' ? candidate.sessionName : '',
			tabId: typeof candidate.tabId === 'string' ? candidate.tabId : '',
			...(typeof candidate.note === 'string' && candidate.note ? { note: candidate.note } : {}),
			snoozedAt: typeof candidate.snoozedAt === 'number' ? candidate.snoozedAt : 0,
			wakeAt: typeof candidate.wakeAt === 'number' ? candidate.wakeAt : 0,
			resolvedAt: candidate.resolvedAt,
			resolution: candidate.resolution as SnoozeResolution,
		});
	}

	// Sort defensively: the array should already be newest-first, but a
	// hand-edited or merged file might not be, and the cap trims the tail.
	return entries.sort((a, b) => b.resolvedAt - a.resolvedAt).slice(0, MAX_SNOOZE_HISTORY);
}

/** Non-React accessor, for recording from callbacks and effects. */
export function recordSnoozeResolution(input: SnoozeHistoryInput): SnoozeHistoryEntry {
	return useSnoozeHistoryStore.getState().recordResolution(input);
}

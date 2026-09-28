import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
	useSnoozeHistoryStore,
	sanitizeSnoozeHistory,
	recordSnoozeResolution,
	MAX_SNOOZE_HISTORY,
	SNOOZE_HISTORY_SETTINGS_KEY,
	type SnoozeHistoryInput,
} from '../../../renderer/stores/snoozeHistoryStore';
import type { SnoozeHistoryEntry } from '../../../renderer/types';

/** A resolution input with sensible defaults. */
function input(overrides: Partial<SnoozeHistoryInput> = {}): SnoozeHistoryInput {
	return {
		label: 'Robinhood Access Check',
		sessionId: 's1',
		sessionName: 'Pedsidian',
		tabId: 'tab-1',
		note: 'check if access came through',
		snoozedAt: 1000,
		wakeAt: 2000,
		resolvedAt: 2000,
		resolution: 'woke',
		...overrides,
	};
}

const settingsSet = window.maestro.settings.set as ReturnType<typeof vi.fn>;

describe('snoozeHistoryStore', () => {
	beforeEach(() => {
		useSnoozeHistoryStore.setState({ entries: [] });
		settingsSet.mockClear();
	});

	it('records a resolution newest-first and stamps an id', () => {
		const first = recordSnoozeResolution(input({ label: 'First', resolvedAt: 1 }));
		const second = recordSnoozeResolution(input({ label: 'Second', resolvedAt: 2 }));

		const { entries } = useSnoozeHistoryStore.getState();
		expect(entries.map((e) => e.label)).toEqual(['Second', 'First']);
		expect(first.id).toBeTruthy();
		expect(second.id).not.toBe(first.id);
	});

	it('keeps the note, which is the point of the log', () => {
		recordSnoozeResolution(input({ note: 'ship the migration' }));
		expect(useSnoozeHistoryStore.getState().entries[0].note).toBe('ship the migration');
	});

	it('persists through the settings bridge on every write', () => {
		recordSnoozeResolution(input());
		expect(settingsSet).toHaveBeenCalledWith(SNOOZE_HISTORY_SETTINGS_KEY, expect.any(Array));
	});

	it('caps the log and drops the oldest entry on overflow', () => {
		for (let i = 0; i < MAX_SNOOZE_HISTORY + 10; i++) {
			recordSnoozeResolution(input({ label: `entry-${i}`, resolvedAt: i }));
		}

		const { entries } = useSnoozeHistoryStore.getState();
		expect(entries).toHaveLength(MAX_SNOOZE_HISTORY);
		// Newest survives, oldest is gone.
		expect(entries[0].label).toBe(`entry-${MAX_SNOOZE_HISTORY + 9}`);
		expect(entries.some((e) => e.label === 'entry-0')).toBe(false);
	});

	it('records all three resolution kinds', () => {
		recordSnoozeResolution(input({ resolution: 'woke' }));
		recordSnoozeResolution(input({ resolution: 'unsnoozed' }));
		recordSnoozeResolution(input({ resolution: 'dismissed' }));

		const kinds = useSnoozeHistoryStore.getState().entries.map((e) => e.resolution);
		expect(kinds).toEqual(['dismissed', 'unsnoozed', 'woke']);
	});

	it('clears the log and persists the empty state', () => {
		recordSnoozeResolution(input());
		useSnoozeHistoryStore.getState().clearHistory();

		expect(useSnoozeHistoryStore.getState().entries).toEqual([]);
		expect(settingsSet).toHaveBeenLastCalledWith(SNOOZE_HISTORY_SETTINGS_KEY, []);
	});
});

describe('sanitizeSnoozeHistory', () => {
	const valid: SnoozeHistoryEntry = {
		id: 'h1',
		label: 'Valid',
		sessionId: 's1',
		sessionName: 'Agent',
		tabId: 't1',
		note: 'a note',
		snoozedAt: 1,
		wakeAt: 2,
		resolvedAt: 3,
		resolution: 'woke',
	};

	it('returns an empty list for non-array input', () => {
		expect(sanitizeSnoozeHistory(undefined)).toEqual([]);
		expect(sanitizeSnoozeHistory(null)).toEqual([]);
		expect(sanitizeSnoozeHistory('nope')).toEqual([]);
		expect(sanitizeSnoozeHistory({})).toEqual([]);
	});

	it('keeps valid entries intact', () => {
		expect(sanitizeSnoozeHistory([valid])).toEqual([valid]);
	});

	it('drops entries missing required fields rather than rendering blanks', () => {
		const result = sanitizeSnoozeHistory([
			valid,
			null,
			'string',
			{ ...valid, label: undefined },
			{ ...valid, resolvedAt: 'soon' },
			{ ...valid, resolution: 'exploded' },
		]);
		expect(result).toHaveLength(1);
		expect(result[0].label).toBe('Valid');
	});

	it('backfills optional fields that a hand-edited file may omit', () => {
		const [entry] = sanitizeSnoozeHistory([
			{ label: 'Sparse', resolvedAt: 5, resolution: 'dismissed' },
		]);
		expect(entry.id).toBeTruthy();
		expect(entry.sessionId).toBe('');
		expect(entry.snoozedAt).toBe(0);
		expect(entry.note).toBeUndefined();
	});

	it('sorts newest-first and re-applies the cap', () => {
		const many = Array.from({ length: MAX_SNOOZE_HISTORY + 5 }, (_, i) => ({
			...valid,
			id: `h${i}`,
			resolvedAt: i,
		}));

		const result = sanitizeSnoozeHistory(many);
		expect(result).toHaveLength(MAX_SNOOZE_HISTORY);
		expect(result[0].resolvedAt).toBe(MAX_SNOOZE_HISTORY + 4);
		expect(result[0].resolvedAt).toBeGreaterThan(result[1].resolvedAt);
	});
});

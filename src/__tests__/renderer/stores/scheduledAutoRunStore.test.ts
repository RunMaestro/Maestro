/**
 * scheduledAutoRunStore tests
 *
 * Covers the one-shot Auto Run scheduling store (issue #716):
 * - schedule / cancel and the one-pending-run-per-agent invariant
 * - settings persistence + hydration, including rejecting malformed entries
 * - partitionScheduledAutoRuns timing policy (due vs. expired vs. pending)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
	useScheduledAutoRunStore,
	partitionScheduledAutoRuns,
	SCHEDULED_AUTO_RUNS_SETTINGS_KEY,
	SCHEDULED_AUTO_RUN_GRACE_MS,
	type ScheduledAutoRun,
} from '../../../renderer/stores/scheduledAutoRunStore';
import type { BatchRunConfig } from '../../../renderer/types';

const CONFIG: BatchRunConfig = {
	documents: [{ id: 'doc-1', filename: 'plan', resetOnCompletion: false, isDuplicate: false }],
	prompt: 'Work the next - [ ] task',
	loopEnabled: false,
	maxLoops: null,
};

function makeEntry(overrides: Partial<ScheduledAutoRun> = {}): ScheduledAutoRun {
	return {
		sessionId: 'session-1',
		folderPath: '/tmp/docs',
		config: CONFIG,
		scheduledFor: 5_000,
		createdAt: 1_000,
		...overrides,
	};
}

const settingsGet = vi.fn();
const settingsSet = vi.fn();

beforeEach(() => {
	settingsGet.mockReset().mockResolvedValue(null);
	settingsSet.mockReset().mockResolvedValue(true);
	(globalThis as unknown as { window: unknown }).window = globalThis;
	(globalThis as { maestro?: unknown }).maestro = {
		settings: { get: settingsGet, set: settingsSet },
		logger: { log: vi.fn() },
	};
	useScheduledAutoRunStore.setState({ scheduled: {}, hydrated: false });
});

describe('scheduledAutoRunStore', () => {
	it('stores one pending schedule per agent, replacing the previous one', () => {
		const { schedule } = useScheduledAutoRunStore.getState();
		schedule(makeEntry({ scheduledFor: 5_000 }));
		schedule(makeEntry({ scheduledFor: 9_000 }));
		schedule(makeEntry({ sessionId: 'session-2', scheduledFor: 7_000 }));

		const { scheduled } = useScheduledAutoRunStore.getState();
		expect(Object.keys(scheduled).sort()).toEqual(['session-1', 'session-2']);
		expect(scheduled['session-1'].scheduledFor).toBe(9_000);
	});

	it('persists the schedule list to settings on schedule and cancel', () => {
		const { schedule, cancel } = useScheduledAutoRunStore.getState();
		schedule(makeEntry());
		expect(settingsSet).toHaveBeenCalledWith(SCHEDULED_AUTO_RUNS_SETTINGS_KEY, [
			expect.objectContaining({ sessionId: 'session-1', scheduledFor: 5_000 }),
		]);

		cancel('session-1');
		expect(settingsSet).toHaveBeenLastCalledWith(SCHEDULED_AUTO_RUNS_SETTINGS_KEY, []);
	});

	it('ignores a cancel for an agent with no pending schedule', () => {
		useScheduledAutoRunStore.getState().cancel('nobody');
		expect(settingsSet).not.toHaveBeenCalled();
	});

	it('hydrates persisted entries and drops malformed ones', async () => {
		settingsGet.mockResolvedValue([
			makeEntry(),
			{ sessionId: 'bad-1' }, // missing config/scheduledFor
			{ ...makeEntry({ sessionId: 'bad-2' }), scheduledFor: 'soon' },
			null,
		]);

		await useScheduledAutoRunStore.getState().hydrate();

		const { scheduled, hydrated } = useScheduledAutoRunStore.getState();
		expect(hydrated).toBe(true);
		expect(Object.keys(scheduled)).toEqual(['session-1']);
	});

	it('hydrates only once', async () => {
		settingsGet.mockResolvedValue([makeEntry()]);
		await useScheduledAutoRunStore.getState().hydrate();
		await useScheduledAutoRunStore.getState().hydrate();
		expect(settingsGet).toHaveBeenCalledTimes(1);
	});

	it('hydrates to an empty map when settings reads fail', async () => {
		settingsGet.mockRejectedValue(new Error('disk on fire'));
		await useScheduledAutoRunStore.getState().hydrate();
		expect(useScheduledAutoRunStore.getState().scheduled).toEqual({});
		expect(useScheduledAutoRunStore.getState().hydrated).toBe(true);
	});
});

describe('partitionScheduledAutoRuns', () => {
	const now = 1_000_000;

	it('leaves future schedules alone', () => {
		const result = partitionScheduledAutoRuns(
			{ a: makeEntry({ sessionId: 'a', scheduledFor: now + 1 }) },
			now
		);
		expect(result.due).toEqual([]);
		expect(result.expired).toEqual([]);
	});

	it('marks a schedule due the moment its timestamp passes', () => {
		const result = partitionScheduledAutoRuns(
			{ a: makeEntry({ sessionId: 'a', scheduledFor: now }) },
			now
		);
		expect(result.due.map((e) => e.sessionId)).toEqual(['a']);
	});

	it('keeps a schedule due through the whole grace window', () => {
		const result = partitionScheduledAutoRuns(
			{ a: makeEntry({ sessionId: 'a', scheduledFor: now - SCHEDULED_AUTO_RUN_GRACE_MS }) },
			now
		);
		expect(result.due.map((e) => e.sessionId)).toEqual(['a']);
		expect(result.expired).toEqual([]);
	});

	it('expires a schedule missed by more than the grace window', () => {
		const result = partitionScheduledAutoRuns(
			{ a: makeEntry({ sessionId: 'a', scheduledFor: now - SCHEDULED_AUTO_RUN_GRACE_MS - 1 }) },
			now
		);
		expect(result.due).toEqual([]);
		expect(result.expired.map((e) => e.sessionId)).toEqual(['a']);
	});

	it('partitions a mixed set independently', () => {
		const result = partitionScheduledAutoRuns(
			{
				future: makeEntry({ sessionId: 'future', scheduledFor: now + 60_000 }),
				due: makeEntry({ sessionId: 'due', scheduledFor: now - 60_000 }),
				gone: makeEntry({ sessionId: 'gone', scheduledFor: now - SCHEDULED_AUTO_RUN_GRACE_MS * 2 }),
			},
			now
		);
		expect(result.due.map((e) => e.sessionId)).toEqual(['due']);
		expect(result.expired.map((e) => e.sessionId)).toEqual(['gone']);
	});
});

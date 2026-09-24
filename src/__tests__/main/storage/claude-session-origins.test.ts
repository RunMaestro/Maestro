import { describe, it, expect, vi } from 'vitest';
import type Store from 'electron-store';

import {
	backfillClaudeSessionNames,
	mergeClaudeSessionOrigin,
	setClaudeSessionOrigin,
} from '../../../main/storage/claude-session-origins';
import type { ClaudeSessionOriginsData } from '../../../main/stores/types';

/** Minimal in-memory electron-store double backed by a plain record. */
function makeOriginsStore(origins: ClaudeSessionOriginsData['origins'] = {}) {
	const data: Record<string, unknown> = { origins };
	const store = {
		data,
		get: vi.fn((key: string, fallback?: unknown) => (key in data ? data[key] : fallback)),
		set: vi.fn((key: string, value: unknown) => {
			data[key] = value;
		}),
	};
	return store as typeof store & Store<ClaudeSessionOriginsData>;
}

describe('mergeClaudeSessionOrigin', () => {
	it('keeps fields the patch does not name', () => {
		expect(
			mergeClaudeSessionOrigin(
				{ origin: 'user', sessionName: 'Named', starred: true, contextUsage: 12 },
				{ origin: 'user' }
			)
		).toEqual({ origin: 'user', sessionName: 'Named', starred: true, contextUsage: 12 });
	});

	it('upgrades a bare origin string to a record when a field is added', () => {
		expect(mergeClaudeSessionOrigin('auto', { sessionName: 'Named' })).toEqual({
			origin: 'auto',
			sessionName: 'Named',
		});
	});

	it('defaults a missing record to the user origin', () => {
		expect(mergeClaudeSessionOrigin(undefined, { starred: true })).toEqual({
			origin: 'user',
			starred: true,
		});
	});

	it('stays in the compact string form when only the origin is known', () => {
		expect(mergeClaudeSessionOrigin(undefined, { origin: 'auto' })).toBe('auto');
		expect(mergeClaudeSessionOrigin('user', { origin: 'auto' })).toBe('auto');
	});
});

describe('setClaudeSessionOrigin', () => {
	it('writes the merged record without touching sibling sessions', () => {
		const store = makeOriginsStore({
			'/p': { keep: 'user', target: { origin: 'user', sessionName: 'Named' } },
		});

		setClaudeSessionOrigin(store, '/p', 'target', { starred: true });

		expect(store.data.origins).toEqual({
			'/p': { keep: 'user', target: { origin: 'user', sessionName: 'Named', starred: true } },
		});
	});
});

describe('backfillClaudeSessionNames', () => {
	it('restores the newest recorded name onto records that lost it', () => {
		const store = makeOriginsStore({
			'/p': { 'aaaa-1': 'user', 'bbbb-2': { origin: 'auto', starred: true } },
		});

		const restored = backfillClaudeSessionNames(store, [
			{ agentSessionId: 'aaaa-1', sessionName: 'Old Name', timestamp: 1 },
			{ agentSessionId: 'aaaa-1', sessionName: 'New Name', timestamp: 2 },
			{ agentSessionId: 'bbbb-2', sessionName: 'Starred One', timestamp: 1 },
		]);

		expect(restored).toBe(2);
		expect(store.data.origins).toEqual({
			'/p': {
				'aaaa-1': { origin: 'user', sessionName: 'New Name' },
				'bbbb-2': { origin: 'auto', starred: true, sessionName: 'Starred One' },
			},
		});
	});

	it('never overwrites a name the store already holds', () => {
		const store = makeOriginsStore({
			'/p': { 'aaaa-1': { origin: 'user', sessionName: 'Current' } },
		});

		const restored = backfillClaudeSessionNames(store, [
			{ agentSessionId: 'aaaa-1', sessionName: 'Stale', timestamp: 1 },
		]);

		expect(restored).toBe(0);
		expect(store.set).not.toHaveBeenCalled();
	});

	it('skips placeholder labels and sessions the store never tracked', () => {
		const store = makeOriginsStore({ '/p': { 'abcd1234-ffff': 'user' } });

		const restored = backfillClaudeSessionNames(store, [
			{ agentSessionId: 'abcd1234-ffff', sessionName: 'ABCD1234', timestamp: 1 },
			{ agentSessionId: 'abcd1234-ffff', sessionName: 'New Session', timestamp: 2 },
			{ agentSessionId: 'untracked-1', sessionName: 'Orphan', timestamp: 1 },
			{ sessionName: 'No Id', timestamp: 1 },
		]);

		expect(restored).toBe(0);
		expect(store.data.origins).toEqual({ '/p': { 'abcd1234-ffff': 'user' } });
	});
});

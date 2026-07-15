/**
 * Tests for src/main/stores/claudeUsageStore.ts
 *
 * Covers the full public surface - `setSnapshot`, `getSnapshot`,
 * `getAllSnapshots`, `clear`, `resolveConfigDirKey` - plus TTL pruning on
 * both read and write paths, multi-account isolation, and the lazy
 * singleton initialization invariant that lets `vi.mock('electron-store')`
 * actually take effect.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockStoreConstructorCalls } = vi.hoisted(() => ({
	mockStoreConstructorCalls: [] as Array<Record<string, unknown>>,
}));

// In-memory mock for electron-store: each MockStore instance keeps its own
// `data` map but shares the constructor-call ledger. Tests can inspect
// `mockStoreConstructorCalls` to verify lazy init.
vi.mock('electron-store', () => {
	return {
		default: class MockStore {
			data: Record<string, unknown>;
			options: Record<string, unknown>;
			constructor(options: Record<string, unknown>) {
				this.options = options;
				this.data = { ...((options.defaults as Record<string, unknown>) ?? {}) };
				mockStoreConstructorCalls.push(options);
			}
			get(key: string, defaultValue?: unknown): unknown {
				if (Object.prototype.hasOwnProperty.call(this.data, key)) {
					return this.data[key];
				}
				return defaultValue;
			}
			set(key: string, value: unknown): void {
				this.data[key] = value;
			}
		},
	};
});

// Stable mocks for the home dir + canonical resolve so resolveConfigDirKey
// is deterministic across platforms. `os` is CommonJS, so both the named
// exports AND the default-export namespace need the override.
vi.mock('os', async () => {
	const actual = await vi.importActual<typeof import('os')>('os');
	const homedir = () => '/Users/test';
	return {
		...actual,
		homedir,
		default: {
			...actual,
			homedir,
		},
	};
});

import * as os from 'os';
import * as path from 'path';
import {
	setSnapshot,
	getSnapshot,
	getAllSnapshots,
	clear,
	resolveConfigDirKey,
	SNAPSHOT_TTL_MS,
	__resetForTests,
	type UsageSnapshot,
} from '../../../main/stores/claudeUsageStore';
import { canonKey } from '../../helpers/pathExpect';

const FROZEN_NOW = new Date('2026-05-15T12:00:00.000Z').getTime();

function makeSnapshot(overrides: Partial<UsageSnapshot> = {}): UsageSnapshot {
	return {
		sampledAt: new Date(FROZEN_NOW).toISOString(),
		configDirKey: '/Users/test/.claude',
		session: { percent: 10, resetsAt: '2026-05-15T17:00:00.000Z' },
		weekAllModels: { percent: 20, resetsAt: '2026-05-22T12:00:00.000Z' },
		weekSonnetOnly: { percent: 5, resetsAt: '2026-05-22T12:00:00.000Z' },
		...overrides,
	};
}

describe('claudeUsageStore', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(FROZEN_NOW));
		__resetForTests();
		mockStoreConstructorCalls.length = 0;
	});

	describe('lazy singleton', () => {
		it('does not construct the Store at module load', () => {
			// Module is already imported at the top; if the singleton were
			// eager, the constructor would have fired by now.
			expect(mockStoreConstructorCalls).toHaveLength(0);
		});

		it('constructs the Store on first method call', () => {
			getAllSnapshots();
			expect(mockStoreConstructorCalls).toHaveLength(1);
			expect(mockStoreConstructorCalls[0]).toMatchObject({
				name: 'claude-usage-snapshots',
				defaults: { snapshots: {} },
			});
		});

		it('reuses the same Store across calls', () => {
			setSnapshot(makeSnapshot());
			getSnapshot('/Users/test/.claude');
			getAllSnapshots();
			clear();
			expect(mockStoreConstructorCalls).toHaveLength(1);
		});
	});

	describe('setSnapshot / getSnapshot round-trip', () => {
		it('round-trips a snapshot', () => {
			const snap = makeSnapshot();
			setSnapshot(snap);
			expect(getSnapshot(snap.configDirKey)).toEqual(snap);
		});

		it('returns null for a missing key', () => {
			expect(getSnapshot('/nonexistent')).toBeNull();
		});

		it('overwrites an existing snapshot under the same key', () => {
			const first = makeSnapshot({
				session: { percent: 10, resetsAt: '2026-05-15T17:00:00.000Z' },
			});
			setSnapshot(first);
			const second = makeSnapshot({
				session: { percent: 80, resetsAt: '2026-05-15T17:00:00.000Z' },
			});
			setSnapshot(second);
			expect(getSnapshot(first.configDirKey)).toEqual(second);
		});
	});

	describe('TTL expiration', () => {
		it('returns the snapshot at exactly 23h old', () => {
			const sampledAt = new Date(FROZEN_NOW - 23 * 60 * 60 * 1000).toISOString();
			setSnapshot(makeSnapshot({ sampledAt }));
			expect(getSnapshot('/Users/test/.claude')).not.toBeNull();
		});

		it('treats a 25h-old snapshot as null on read', () => {
			const sampledAt = new Date(FROZEN_NOW - 25 * 60 * 60 * 1000).toISOString();
			setSnapshot(makeSnapshot({ sampledAt }));
			expect(getSnapshot('/Users/test/.claude')).toBeNull();
		});

		it('treats an unparseable sampledAt as null on read', () => {
			setSnapshot(makeSnapshot({ sampledAt: 'not-a-date' }));
			expect(getSnapshot('/Users/test/.claude')).toBeNull();
		});

		it('SNAPSHOT_TTL_MS equals 24 hours', () => {
			expect(SNAPSHOT_TTL_MS).toBe(24 * 60 * 60 * 1000);
		});
	});

	describe('prune on read', () => {
		it('removes an expired entry from disk when reading it directly', () => {
			const expired = makeSnapshot({
				configDirKey: '/Users/test/.claude-old',
				sampledAt: new Date(FROZEN_NOW - 25 * 60 * 60 * 1000).toISOString(),
			});
			setSnapshot(expired);
			// First read prunes; verify by inspecting the all-snapshots map.
			expect(getSnapshot(expired.configDirKey)).toBeNull();
			expect(getAllSnapshots()).toEqual({});
		});

		it('preserves live neighbors when pruning an expired entry on read', () => {
			const fresh = makeSnapshot({ configDirKey: '/Users/test/.claude-fresh' });
			const expired = makeSnapshot({
				configDirKey: '/Users/test/.claude-old',
				sampledAt: new Date(FROZEN_NOW - 48 * 60 * 60 * 1000).toISOString(),
			});
			setSnapshot(fresh);
			setSnapshot(expired);
			getSnapshot(expired.configDirKey); // triggers prune
			expect(getAllSnapshots()).toEqual({ [fresh.configDirKey]: fresh });
		});
	});

	describe('prune on write', () => {
		it('drops expired neighbors while writing a new snapshot', () => {
			const expired = makeSnapshot({
				configDirKey: '/Users/test/.claude-old',
				sampledAt: new Date(FROZEN_NOW - 36 * 60 * 60 * 1000).toISOString(),
			});
			setSnapshot(expired);
			const fresh = makeSnapshot({ configDirKey: '/Users/test/.claude-new' });
			setSnapshot(fresh);
			expect(getAllSnapshots()).toEqual({ [fresh.configDirKey]: fresh });
		});

		it('drops expired neighbors with unparseable sampledAt on write', () => {
			setSnapshot(
				makeSnapshot({
					configDirKey: '/Users/test/.claude-bad',
					sampledAt: 'garbage',
				})
			);
			const fresh = makeSnapshot({ configDirKey: '/Users/test/.claude-new' });
			setSnapshot(fresh);
			expect(getAllSnapshots()).toEqual({ [fresh.configDirKey]: fresh });
		});
	});

	describe('getAllSnapshots', () => {
		it('returns every live snapshot keyed by configDirKey', () => {
			const a = makeSnapshot({ configDirKey: '/Users/test/.claude-a' });
			const b = makeSnapshot({ configDirKey: '/Users/test/.claude-b' });
			setSnapshot(a);
			setSnapshot(b);
			expect(getAllSnapshots()).toEqual({
				[a.configDirKey]: a,
				[b.configDirKey]: b,
			});
		});

		it('filters out expired snapshots and prunes them from disk', () => {
			const live = makeSnapshot({ configDirKey: '/Users/test/.claude-live' });
			const dead = makeSnapshot({
				configDirKey: '/Users/test/.claude-dead',
				sampledAt: new Date(FROZEN_NOW - 30 * 60 * 60 * 1000).toISOString(),
			});
			// Order matters: write `live` first, then `dead`. setSnapshot()
			// never prunes the entry being written, so `dead` survives the
			// write even though its sampledAt is already past the TTL.
			setSnapshot(live);
			setSnapshot(dead);
			// getAllSnapshots() must drop `dead` based on its sampledAt.
			expect(getAllSnapshots()).toEqual({ [live.configDirKey]: live });
			// And prune-on-read must persist that drop - calling getSnapshot
			// for `dead` returns null cleanly the next time.
			expect(getSnapshot(dead.configDirKey)).toBeNull();
		});

		it('returns an empty object when no snapshots have ever been written', () => {
			expect(getAllSnapshots()).toEqual({});
		});
	});

	describe('multi-account isolation', () => {
		it('keys snapshots independently by configDirKey', () => {
			const gmail = makeSnapshot({
				configDirKey: '/Users/test/.claude-gmail',
				session: { percent: 50, resetsAt: '2026-05-15T17:00:00.000Z' },
			});
			const smash = makeSnapshot({
				configDirKey: '/Users/test/.claude-smash',
				session: { percent: 80, resetsAt: '2026-05-15T17:00:00.000Z' },
			});
			setSnapshot(gmail);
			setSnapshot(smash);
			expect(getSnapshot(gmail.configDirKey)).toEqual(gmail);
			expect(getSnapshot(smash.configDirKey)).toEqual(smash);
			expect(getSnapshot(gmail.configDirKey)?.session.percent).toBe(50);
			expect(getSnapshot(smash.configDirKey)?.session.percent).toBe(80);
		});
	});

	describe('clear', () => {
		it('drops every snapshot', () => {
			setSnapshot(makeSnapshot({ configDirKey: '/a' }));
			setSnapshot(makeSnapshot({ configDirKey: '/b' }));
			clear();
			expect(getAllSnapshots()).toEqual({});
			expect(getSnapshot('/a')).toBeNull();
			expect(getSnapshot('/b')).toBeNull();
		});

		it('is a no-op on an empty store', () => {
			clear();
			expect(getAllSnapshots()).toEqual({});
		});
	});

	describe('resolveConfigDirKey', () => {
		it('returns the canonical resolved path when CLAUDE_CONFIG_DIR is set', () => {
			expect(resolveConfigDirKey({ CLAUDE_CONFIG_DIR: '/Users/test/.claude-gmail' })).toBe(
				canonKey('/Users/test/.claude-gmail')
			);
		});

		it('falls back to ~/.claude when CLAUDE_CONFIG_DIR is unset', () => {
			expect(resolveConfigDirKey({})).toBe(canonKey(path.join(os.homedir(), '.claude')));
		});

		it('canonicalizes redundant separators and trailing slashes', () => {
			expect(resolveConfigDirKey({ CLAUDE_CONFIG_DIR: '/Users/test/./.claude-gmail/' })).toBe(
				canonKey('/Users/test/.claude-gmail')
			);
		});

		it('canonicalizes ".." segments', () => {
			expect(resolveConfigDirKey({ CLAUDE_CONFIG_DIR: '/Users/test/foo/../.claude-smash' })).toBe(
				canonKey('/Users/test/.claude-smash')
			);
		});

		it('treats CLAUDE_CONFIG_DIR=undefined identically to unset', () => {
			expect(resolveConfigDirKey({ CLAUDE_CONFIG_DIR: undefined })).toBe(
				canonKey(path.join(os.homedir(), '.claude'))
			);
		});
	});
});

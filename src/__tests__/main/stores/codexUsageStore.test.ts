/**
 * Tests for src/main/stores/codexUsageStore.ts
 *
 * Codex's snapshot store must follow the same two-clock rule as the Claude one:
 * `getAllCodexUsageSnapshots` is decision-grade (unexpired only) while
 * `getRetainedCodexUsageSnapshots` is display-grade, so a Codex account whose
 * agents all moved away keeps its Usage Dashboard row instead of vanishing 24h
 * later. Also covers the lazy-singleton invariant that lets
 * `vi.mock('electron-store')` take effect, and CODEX_HOME key resolution.
 */

import path from 'path';

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockStoreConstructorCalls } = vi.hoisted(() => ({
	mockStoreConstructorCalls: [] as Array<Record<string, unknown>>,
}));

// In-memory electron-store mock: per-instance data, shared constructor ledger.
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

// `os` is CommonJS, so both the named export and the default namespace need the
// override for resolveCodexHomeKey to be deterministic across platforms.
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

import {
	setCodexUsageSnapshot,
	getAllCodexUsageSnapshots,
	getRetainedCodexUsageSnapshots,
	clearCodexUsageSnapshots,
	resolveCodexHomeKey,
	CODEX_USAGE_SNAPSHOT_TTL_MS,
	SNAPSHOT_RETENTION_MS,
	__resetForTests,
	type CodexUsageSnapshot,
} from '../../../main/stores/codexUsageStore';

const FROZEN_NOW = new Date('2026-05-15T12:00:00.000Z').getTime();

function makeSnapshot(overrides: Partial<CodexUsageSnapshot> = {}): CodexUsageSnapshot {
	return {
		sampledAt: new Date(FROZEN_NOW).toISOString(),
		codexHomeKey: '/Users/test/.codex',
		authState: 'authenticated',
		session: { percent: 12, resetsAt: '2026-05-15T17:00:00.000Z' },
		weekly: { percent: 40, resetsAt: '2026-05-22T12:00:00.000Z' },
		...overrides,
	};
}

function agedSnapshot(codexHomeKey: string, ageMs: number): CodexUsageSnapshot {
	return makeSnapshot({
		codexHomeKey,
		sampledAt: new Date(FROZEN_NOW - ageMs).toISOString(),
	});
}

describe('codexUsageStore', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(FROZEN_NOW));
		__resetForTests();
		mockStoreConstructorCalls.length = 0;
	});

	describe('lazy singleton', () => {
		it('does not construct the Store at module load', () => {
			expect(mockStoreConstructorCalls).toHaveLength(0);
		});

		it('constructs the Store on first method call', () => {
			getAllCodexUsageSnapshots();
			expect(mockStoreConstructorCalls).toHaveLength(1);
			expect(mockStoreConstructorCalls[0]).toMatchObject({
				name: 'codex-usage-snapshots',
				defaults: { snapshots: {} },
			});
		});
	});

	describe('read and write', () => {
		it('round-trips a snapshot keyed by codexHomeKey', () => {
			const snapshot = makeSnapshot();
			setCodexUsageSnapshot(snapshot);

			expect(getAllCodexUsageSnapshots()).toEqual({ [snapshot.codexHomeKey]: snapshot });
		});

		it('keeps accounts isolated from one another', () => {
			const work = makeSnapshot({ codexHomeKey: '/Users/test/.codex-work' });
			const personal = makeSnapshot({ codexHomeKey: '/Users/test/.codex-personal' });
			setCodexUsageSnapshot(work);
			setCodexUsageSnapshot(personal);

			expect(getAllCodexUsageSnapshots()).toEqual({
				[work.codexHomeKey]: work,
				[personal.codexHomeKey]: personal,
			});
		});

		it('overwrites the snapshot for an account it already holds', () => {
			setCodexUsageSnapshot(makeSnapshot({ session: { percent: 12, resetsAt: 'x' } }));
			const refreshed = makeSnapshot({ session: { percent: 90, resetsAt: 'y' } });
			setCodexUsageSnapshot(refreshed);

			expect(getAllCodexUsageSnapshots()).toEqual({ [refreshed.codexHomeKey]: refreshed });
		});

		it('clears every account', () => {
			setCodexUsageSnapshot(makeSnapshot());
			clearCodexUsageSnapshots();

			expect(getAllCodexUsageSnapshots()).toEqual({});
			expect(getRetainedCodexUsageSnapshots()).toEqual({});
		});
	});

	describe('retention beyond the TTL', () => {
		it('keeps an expired snapshot for display while hiding it from the live map', () => {
			// The Codex account whose agents all moved away: the dashboard keeps
			// drawing its last known bars, nothing may decide on them.
			const expired = agedSnapshot('/Users/test/.codex-capped', 25 * 60 * 60 * 1000);
			setCodexUsageSnapshot(expired);

			expect(getAllCodexUsageSnapshots()).toEqual({});
			expect(getRetainedCodexUsageSnapshots()).toEqual({ [expired.codexHomeKey]: expired });
		});

		it('survives a neighboring write', () => {
			const expired = agedSnapshot('/Users/test/.codex-capped', 30 * 60 * 60 * 1000);
			setCodexUsageSnapshot(expired);
			const fresh = makeSnapshot({ codexHomeKey: '/Users/test/.codex-spare' });
			setCodexUsageSnapshot(fresh);

			expect(getAllCodexUsageSnapshots()).toEqual({ [fresh.codexHomeKey]: fresh });
			expect(getRetainedCodexUsageSnapshots()).toEqual({
				[expired.codexHomeKey]: expired,
				[fresh.codexHomeKey]: fresh,
			});
		});

		it('drops a snapshot past the retention window', () => {
			const ancient = agedSnapshot('/Users/test/.codex-ancient', SNAPSHOT_RETENTION_MS + 60_000);
			setCodexUsageSnapshot(ancient);

			expect(getRetainedCodexUsageSnapshots()).toEqual({});
		});

		it('drops an unparseable snapshot rather than retaining it', () => {
			setCodexUsageSnapshot(
				makeSnapshot({ codexHomeKey: '/Users/test/.codex-bad', sampledAt: 'garbage' })
			);
			const fresh = makeSnapshot({ codexHomeKey: '/Users/test/.codex-new' });
			setCodexUsageSnapshot(fresh);

			expect(getRetainedCodexUsageSnapshots()).toEqual({ [fresh.codexHomeKey]: fresh });
		});

		it('uses the same two clocks as the Claude store', () => {
			expect(CODEX_USAGE_SNAPSHOT_TTL_MS).toBe(24 * 60 * 60 * 1000);
			expect(SNAPSHOT_RETENTION_MS).toBe(30 * 24 * 60 * 60 * 1000);
		});
	});

	// The subject ends in `path.resolve`, so a POSIX literal picks up a drive
	// letter on Windows. Expect through the same resolver rather than pinning
	// the separator this machine happens to use.
	describe('resolveCodexHomeKey', () => {
		it('falls back to ~/.codex when CODEX_HOME is unset', () => {
			expect(resolveCodexHomeKey({})).toBe(path.resolve('/Users/test/.codex'));
		});

		it('honors an explicit CODEX_HOME', () => {
			expect(resolveCodexHomeKey({ CODEX_HOME: '/Users/test/.codex-work' })).toBe(
				path.resolve('/Users/test/.codex-work')
			);
		});
	});
});

/**
 * Tests for src/main/stores/providerAuthStore.ts
 *
 * Covers the public surface - `getSnapshot`, `getAllSnapshots`, `setSnapshot`,
 * `markLoggedOut`, `clearSnapshot`, `isSnapshotFresh` - plus the two invariants
 * that matter beyond CRUD: snapshots never expire on their own (a login state
 * stays useful when stale, unlike a quota reading), and `detail` never carries a
 * token to disk.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockStoreConstructorCalls } = vi.hoisted(() => ({
	mockStoreConstructorCalls: [] as Array<Record<string, unknown>>,
}));

// In-memory mock for electron-store: each MockStore instance keeps its own
// `data` map but shares the constructor-call ledger, so tests can verify the
// lazy-init invariant that makes this mock take effect at all.
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

import {
	getSnapshot,
	getAllSnapshots,
	setSnapshot,
	markLoggedOut,
	clearSnapshot,
	isSnapshotFresh,
	PROBE_STALE_MS,
	__resetForTests,
} from '../../../main/stores/providerAuthStore';
import type { CredentialIdentity, ProviderAuthSnapshot } from '../../../shared/providerAuth';

const FROZEN_NOW = new Date('2026-08-15T12:00:00.000Z').getTime();

function makeIdentity(overrides: Partial<CredentialIdentity> = {}): CredentialIdentity {
	return {
		key: 'claude-code::oauth::/Users/test/.claude::local',
		provider: 'claude-code',
		kind: 'oauth',
		scope: '/Users/test/.claude',
		host: 'local',
		configDir: '/Users/test/.claude',
		label: '.claude',
		...overrides,
	};
}

function makeSnapshot(overrides: Partial<ProviderAuthSnapshot> = {}): ProviderAuthSnapshot {
	return {
		identity: makeIdentity(),
		status: 'authenticated',
		detail: 'dev@example.com (Max)',
		accountLabel: '.claude',
		checkedAt: FROZEN_NOW,
		source: 'probe',
		...overrides,
	};
}

describe('providerAuthStore', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(FROZEN_NOW));
		__resetForTests();
		mockStoreConstructorCalls.length = 0;
	});

	describe('lazy initialization', () => {
		it('does not construct the Store until a method is called', () => {
			expect(mockStoreConstructorCalls).toHaveLength(0);
			getAllSnapshots();
			expect(mockStoreConstructorCalls).toHaveLength(1);
			expect(mockStoreConstructorCalls[0].name).toBe('provider-auth-snapshots');
		});

		it('reuses the same instance across calls', () => {
			setSnapshot('a', makeSnapshot());
			getSnapshot('a');
			getAllSnapshots();
			expect(mockStoreConstructorCalls).toHaveLength(1);
		});
	});

	describe('setSnapshot / getSnapshot', () => {
		it('round-trips a snapshot by key', () => {
			const snapshot = makeSnapshot();
			setSnapshot(snapshot.identity.key, snapshot);
			expect(getSnapshot(snapshot.identity.key)).toEqual(snapshot);
		});

		it('returns null for an unknown key', () => {
			expect(getSnapshot('nope')).toBeNull();
		});

		it('files the record under the explicit key, not the identity key', () => {
			const snapshot = makeSnapshot();
			setSnapshot('explicit-key', snapshot);
			expect(getSnapshot('explicit-key')).not.toBeNull();
			expect(getSnapshot(snapshot.identity.key)).toBeNull();
		});

		it('overwrites an existing snapshot for the same key', () => {
			setSnapshot('k', makeSnapshot({ status: 'authenticated' }));
			setSnapshot('k', makeSnapshot({ status: 'logged-out', detail: 'session expired' }));
			expect(getSnapshot('k')?.status).toBe('logged-out');
			expect(getSnapshot('k')?.detail).toBe('session expired');
		});

		it('keeps identities isolated from one another', () => {
			const a = makeSnapshot();
			const b = makeSnapshot({
				identity: makeIdentity({
					key: 'codex::oauth::/Users/test/.codex::local',
					provider: 'codex',
				}),
				status: 'logged-out',
			});
			setSnapshot(a.identity.key, a);
			setSnapshot(b.identity.key, b);
			expect(getAllSnapshots()).toEqual({
				[a.identity.key]: a,
				[b.identity.key]: b,
			});
		});

		it('does NOT expire an old snapshot, unlike the usage store', () => {
			const stale = makeSnapshot({ checkedAt: FROZEN_NOW - 30 * 24 * 60 * 60 * 1000 });
			setSnapshot(stale.identity.key, stale);
			vi.setSystemTime(new Date(FROZEN_NOW + 60 * 60 * 1000));
			expect(getSnapshot(stale.identity.key)).toEqual(stale);
			expect(Object.keys(getAllSnapshots())).toHaveLength(1);
		});
	});

	describe('detail scrubbing', () => {
		it.each([
			['sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF', 'sk-ant-'],
			['Bearer eyJhbGciOiJIUzI1NiJ9', 'Bearer '],
			['ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789', 'ghp_'],
			['github_pat_11ABCDEFG0abcdefghijklmnop', 'github_pat_'],
		])('replaces %s before it reaches the store', (secret, marker) => {
			setSnapshot('k', makeSnapshot({ detail: `auth failed: ${secret}` }));
			const stored = getSnapshot('k');
			expect(stored?.detail).not.toContain(marker);
			expect(stored?.detail).toContain('[redacted]');
		});

		it('replaces a long opaque token blob', () => {
			const blob = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0';
			setSnapshot('k', makeSnapshot({ detail: `rejected key ${blob}` }));
			expect(getSnapshot('k')?.detail).toBe('rejected key [redacted]');
		});

		it('leaves an ordinary account detail untouched', () => {
			setSnapshot('k', makeSnapshot({ detail: 'dev@example.com - Acme Corp (Max)' }));
			expect(getSnapshot('k')?.detail).toBe('dev@example.com - Acme Corp (Max)');
		});

		it('caps an overlong detail', () => {
			setSnapshot('k', makeSnapshot({ detail: 'x '.repeat(400) }));
			const detail = getSnapshot('k')?.detail ?? '';
			expect(detail.length).toBeLessThanOrEqual(303);
			expect(detail.endsWith('...')).toBe(true);
		});

		it('drops a detail that is empty after scrubbing', () => {
			setSnapshot('k', makeSnapshot({ detail: '   ' }));
			expect(getSnapshot('k')).not.toHaveProperty('detail');
		});

		it('does not mutate the caller’s snapshot object', () => {
			const snapshot = makeSnapshot({ detail: 'Bearer abc123xyz' });
			setSnapshot('k', snapshot);
			expect(snapshot.detail).toBe('Bearer abc123xyz');
		});
	});

	describe('markLoggedOut', () => {
		it('flips an existing snapshot and preserves its identity and account label', () => {
			const snapshot = makeSnapshot();
			setSnapshot(snapshot.identity.key, snapshot);
			vi.setSystemTime(new Date(FROZEN_NOW + 5000));

			const result = markLoggedOut(snapshot.identity.key, 'OAuth token expired', 'error-pattern');

			expect(result).toEqual({
				identity: snapshot.identity,
				status: 'logged-out',
				detail: 'OAuth token expired',
				accountLabel: '.claude',
				checkedAt: FROZEN_NOW + 5000,
				source: 'error-pattern',
			});
			expect(getSnapshot(snapshot.identity.key)).toEqual(result);
		});

		it('records a first-ever logged-out state when handed an identity', () => {
			const identity = makeIdentity();
			const result = markLoggedOut(identity.key, 'not signed in', 'error-pattern', identity);
			expect(result?.status).toBe('logged-out');
			expect(result?.identity).toEqual(identity);
			expect(getSnapshot(identity.key)?.source).toBe('error-pattern');
		});

		it('is a no-op when there is no stored snapshot and no identity', () => {
			expect(markLoggedOut('unknown-key', 'boom', 'error-pattern')).toBeNull();
			expect(getAllSnapshots()).toEqual({});
		});

		it('prefers the stored identity over the passed one', () => {
			const stored = makeSnapshot();
			setSnapshot(stored.identity.key, stored);
			const other = makeIdentity({ label: 'wrong', scope: '/elsewhere' });
			const result = markLoggedOut(stored.identity.key, undefined, 'login-flow', other);
			expect(result?.identity).toEqual(stored.identity);
		});

		it('omits detail when none is given', () => {
			const snapshot = makeSnapshot();
			setSnapshot(snapshot.identity.key, snapshot);
			const result = markLoggedOut(snapshot.identity.key, undefined, 'probe');
			expect(result).not.toHaveProperty('detail');
		});

		it('scrubs a secret out of the reason', () => {
			const identity = makeIdentity();
			const result = markLoggedOut(
				identity.key,
				'rejected sk-ant-api03-AAAABBBBCCCCDDDD',
				'error-pattern',
				identity
			);
			expect(result?.detail).toBe('rejected [redacted]');
		});
	});

	describe('clearSnapshot', () => {
		it('removes only the named key', () => {
			setSnapshot('a', makeSnapshot());
			setSnapshot('b', makeSnapshot());
			clearSnapshot('a');
			expect(getSnapshot('a')).toBeNull();
			expect(getSnapshot('b')).not.toBeNull();
		});

		it('is a no-op for a missing key', () => {
			setSnapshot('a', makeSnapshot());
			clearSnapshot('missing');
			expect(Object.keys(getAllSnapshots())).toEqual(['a']);
		});
	});

	describe('isSnapshotFresh', () => {
		it('is true just inside the stale window', () => {
			const snapshot = makeSnapshot({ checkedAt: FROZEN_NOW - (PROBE_STALE_MS - 1) });
			expect(isSnapshotFresh(snapshot, FROZEN_NOW)).toBe(true);
		});

		it('is false at and past the stale window', () => {
			expect(
				isSnapshotFresh(makeSnapshot({ checkedAt: FROZEN_NOW - PROBE_STALE_MS }), FROZEN_NOW)
			).toBe(false);
			expect(
				isSnapshotFresh(makeSnapshot({ checkedAt: FROZEN_NOW - PROBE_STALE_MS * 2 }), FROZEN_NOW)
			).toBe(false);
		});

		it('is false for a missing or corrupted record', () => {
			expect(isSnapshotFresh(null)).toBe(false);
			expect(isSnapshotFresh(undefined)).toBe(false);
			expect(isSnapshotFresh(makeSnapshot({ checkedAt: Number.NaN }), FROZEN_NOW)).toBe(false);
			expect(
				isSnapshotFresh(makeSnapshot({ checkedAt: undefined as unknown as number }), FROZEN_NOW)
			).toBe(false);
		});

		it('defaults `now` to the current clock', () => {
			expect(isSnapshotFresh(makeSnapshot({ checkedAt: FROZEN_NOW }))).toBe(true);
		});
	});

	describe('getAllSnapshots', () => {
		it('returns an empty object on a fresh store', () => {
			expect(getAllSnapshots()).toEqual({});
		});

		it('returns a copy that cannot mutate the store', () => {
			setSnapshot('a', makeSnapshot());
			const all = getAllSnapshots();
			delete all.a;
			expect(getSnapshot('a')).not.toBeNull();
		});
	});
});

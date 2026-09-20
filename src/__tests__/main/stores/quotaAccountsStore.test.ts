/**
 * Tests for src/main/stores/quotaAccountsStore.ts
 *
 * The store exists so a plan account survives losing every agent that pointed
 * at it - the state an account is in the moment it hits its limit and the user
 * swings their agents elsewhere. The cases below pin that: remembering is
 * additive and idempotent, providers stay isolated, and the only thing that
 * forgets an account is its directory disappearing from disk.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('electron-store', () => {
	return {
		default: class MockStore {
			data: Record<string, unknown>;
			constructor(options: Record<string, unknown>) {
				this.data = { ...((options.defaults as Record<string, unknown>) ?? {}) };
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

import * as fs from 'fs';
import {
	clearRememberedQuotaAccounts,
	forgetQuotaAccounts,
	getRememberedQuotaAccountKeys,
	getRememberedQuotaAccounts,
	pruneMissingQuotaAccounts,
	rememberQuotaAccounts,
	__resetForTests,
} from '../../../main/stores/quotaAccountsStore';

const FROZEN_NOW = new Date('2026-05-15T12:00:00.000Z').getTime();

describe('quotaAccountsStore', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(FROZEN_NOW));
		__resetForTests();
		clearRememberedQuotaAccounts();
	});

	describe('rememberQuotaAccounts', () => {
		it('remembers keys in first-seen order', () => {
			rememberQuotaAccounts('claude-code', ['/Users/test/.claude-a']);
			vi.setSystemTime(new Date(FROZEN_NOW + 1000));
			rememberQuotaAccounts('claude-code', ['/Users/test/.claude-b']);

			expect(getRememberedQuotaAccountKeys('claude-code')).toEqual([
				'/Users/test/.claude-a',
				'/Users/test/.claude-b',
			]);
		});

		it('keeps firstSeenAt and refreshes lastSeenAt on re-remember', () => {
			rememberQuotaAccounts('claude-code', ['/Users/test/.claude-a']);
			vi.setSystemTime(new Date(FROZEN_NOW + 60_000));
			rememberQuotaAccounts('claude-code', ['/Users/test/.claude-a']);

			expect(getRememberedQuotaAccounts('claude-code')).toEqual([
				{
					accountKey: '/Users/test/.claude-a',
					firstSeenAt: FROZEN_NOW,
					lastSeenAt: FROZEN_NOW + 60_000,
				},
			]);
		});

		it('keeps providers isolated', () => {
			rememberQuotaAccounts('claude-code', ['/Users/test/.claude-a']);
			rememberQuotaAccounts('codex', ['/Users/test/.codex-a']);

			expect(getRememberedQuotaAccountKeys('claude-code')).toEqual(['/Users/test/.claude-a']);
			expect(getRememberedQuotaAccountKeys('codex')).toEqual(['/Users/test/.codex-a']);
			expect(getRememberedQuotaAccountKeys('opencode')).toEqual([]);
		});

		it('ignores empty keys and empty batches', () => {
			rememberQuotaAccounts('claude-code', []);
			rememberQuotaAccounts('claude-code', ['']);

			expect(getRememberedQuotaAccountKeys('claude-code')).toEqual([]);
		});

		it('accepts any iterable, including a Map key view', () => {
			const targets = new Map([
				['/Users/test/.claude-a', 1],
				['/Users/test/.claude-b', 2],
			]);
			rememberQuotaAccounts('claude-code', targets.keys());

			expect(getRememberedQuotaAccountKeys('claude-code')).toEqual([
				'/Users/test/.claude-a',
				'/Users/test/.claude-b',
			]);
		});
	});

	describe('forgetQuotaAccounts', () => {
		it('drops only the named keys', () => {
			rememberQuotaAccounts('claude-code', ['/Users/test/.claude-a', '/Users/test/.claude-b']);
			forgetQuotaAccounts('claude-code', ['/Users/test/.claude-a']);

			expect(getRememberedQuotaAccountKeys('claude-code')).toEqual(['/Users/test/.claude-b']);
		});

		it('is a no-op for unknown keys and unknown providers', () => {
			rememberQuotaAccounts('claude-code', ['/Users/test/.claude-a']);
			forgetQuotaAccounts('claude-code', ['/nope']);
			forgetQuotaAccounts('nobody', ['/nope']);

			expect(getRememberedQuotaAccountKeys('claude-code')).toEqual(['/Users/test/.claude-a']);
		});
	});

	describe('pruneMissingQuotaAccounts', () => {
		it('forgets accounts whose directory is gone and keeps the rest in order', async () => {
			rememberQuotaAccounts('claude-code', [
				'/Users/test/.claude-live',
				'/Users/test/.claude-deleted',
				'/Users/test/.claude-also-live',
			]);
			const access = vi.spyOn(fs.promises, 'access').mockImplementation(async (target) => {
				if (String(target).endsWith('.claude-deleted')) {
					throw Object.assign(new Error('missing'), { code: 'ENOENT' });
				}
			});

			try {
				const surviving = await pruneMissingQuotaAccounts('claude-code');
				expect(surviving).toEqual(['/Users/test/.claude-live', '/Users/test/.claude-also-live']);
			} finally {
				access.mockRestore();
			}

			expect(getRememberedQuotaAccountKeys('claude-code')).toEqual([
				'/Users/test/.claude-live',
				'/Users/test/.claude-also-live',
			]);
		});

		it('keeps an account whose directory is merely unreadable', async () => {
			// An unmounted volume or a permissions blip must not erase the row.
			rememberQuotaAccounts('claude-code', ['/Volumes/keys/.claude-work']);
			const access = vi
				.spyOn(fs.promises, 'access')
				.mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }));

			try {
				expect(await pruneMissingQuotaAccounts('claude-code')).toEqual([
					'/Volumes/keys/.claude-work',
				]);
			} finally {
				access.mockRestore();
			}

			expect(getRememberedQuotaAccountKeys('claude-code')).toEqual(['/Volumes/keys/.claude-work']);
		});

		it('returns an empty list when nothing is remembered', async () => {
			expect(await pruneMissingQuotaAccounts('claude-code')).toEqual([]);
		});
	});
});

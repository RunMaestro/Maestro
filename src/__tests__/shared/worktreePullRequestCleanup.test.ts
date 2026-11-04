import { describe, expect, it } from 'vitest';
import {
	getWorktreePullRequestCleanupIntent,
	resolveWorktreePullRequestCleanupPolicy,
} from '../../shared/worktreePullRequestCleanup';

describe('worktree PR cleanup policy', () => {
	it.each([
		undefined,
		null,
		false,
		true,
		'automatic',
		{},
		[],
		{ mode: 'unknown' },
		{ mode: 'automatic' },
		{ mode: 'automatic', optedIn: false },
		{ mode: 'automatic', optedIn: 'true' },
		{ mode: 'automatic', optedIn: 1 },
		{ mode: 'keep', optedIn: true },
		Object.create({ mode: 'automatic', optedIn: true }),
		Object.assign(Object.create({ optedIn: true }), { mode: 'automatic' }),
	])('preserves the checkout for an absent or unsafe stored choice (%j)', (stored) => {
		expect(resolveWorktreePullRequestCleanupPolicy(stored)).toEqual({ mode: 'keep' });
		expect(getWorktreePullRequestCleanupIntent(stored, 'MERGED')).toBe('keep');
	});

	it('keeps asking when automatic cleanup was not selected', () => {
		expect(resolveWorktreePullRequestCleanupPolicy({ mode: 'ask', optedIn: true })).toEqual({
			mode: 'ask',
		});
		expect(getWorktreePullRequestCleanupIntent({ mode: 'ask', optedIn: true }, 'MERGED')).toBe(
			'ask'
		);
	});

	it('requires preflight even when the user opted in and the UI reports a merge', () => {
		const stored = Object.freeze({ mode: 'automatic', optedIn: true });
		expect(resolveWorktreePullRequestCleanupPolicy(stored)).toEqual({
			mode: 'automatic',
			optedIn: true,
		});
		expect(getWorktreePullRequestCleanupIntent(stored, 'MERGED')).toBe('preflight-required');
	});

	it.each([undefined, 'OPEN', 'CLOSED'] as const)(
		'does not ask or schedule cleanup for an unconfirmed merge (%s)',
		(state) => {
			for (const policy of [{ mode: 'ask' }, { mode: 'automatic', optedIn: true }]) {
				expect(getWorktreePullRequestCleanupIntent(policy, state)).toBe('awaiting-merge');
			}
		}
	);

	it('defaults old agents to keep without modifying or migrating their saved data', () => {
		const legacy = Object.freeze({ id: 'old-agent', cwd: '/existing-checkout' });
		expect(resolveWorktreePullRequestCleanupPolicy(undefined)).toEqual({ mode: 'keep' });
		expect(resolveWorktreePullRequestCleanupPolicy(legacy)).toEqual({ mode: 'keep' });
		expect(legacy).toEqual({ id: 'old-agent', cwd: '/existing-checkout' });
	});

	it('returns a new policy so callers cannot change the persisted choice', () => {
		const stored = Object.freeze({ mode: 'ask' });
		const resolved = resolveWorktreePullRequestCleanupPolicy(stored);
		expect(resolved).not.toBe(stored);
		expect(resolved).toEqual({ mode: 'ask' });
	});
});

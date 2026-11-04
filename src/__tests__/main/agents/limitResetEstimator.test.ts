import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the usage store so the estimator can be exercised without electron-store.
const { mockGetSnapshot } = vi.hoisted(() => ({ mockGetSnapshot: vi.fn() }));
vi.mock('../../../main/stores/claudeUsageStore', () => ({
	getSnapshot: (...args: unknown[]) => mockGetSnapshot(...args),
	resolveConfigDirKey: (env: NodeJS.ProcessEnv) => env.CLAUDE_CONFIG_DIR ?? '/home/u/.claude',
}));

import { getLimitResetAt } from '../../../main/agents/limitResetEstimator';

/** Build a minimal usage snapshot with the two reset windows the estimator reads. */
function snap(sessionResetsAt: string, weekResetsAt: string) {
	return {
		sampledAt: new Date().toISOString(),
		configDirKey: '/home/u/.claude',
		session: { percent: 100, resetsAt: sessionResetsAt },
		weekAllModels: { percent: 50, resetsAt: weekResetsAt },
		weekSonnetOnly: { percent: 0, resetsAt: weekResetsAt },
	};
}

describe('getLimitResetAt', () => {
	beforeEach(() => {
		mockGetSnapshot.mockReset();
	});

	it('returns the nearest FUTURE reset for Claude', () => {
		const now = Date.now();
		const soon = new Date(now + 60_000).toISOString();
		const later = new Date(now + 3_600_000).toISOString();
		mockGetSnapshot.mockReturnValue(snap(soon, later));

		expect(getLimitResetAt('claude-code')).toBe(new Date(soon).getTime());
	});

	it('skips a past reset and returns the future one', () => {
		const now = Date.now();
		const past = new Date(now - 60_000).toISOString();
		const future = new Date(now + 120_000).toISOString();
		mockGetSnapshot.mockReturnValue(snap(past, future));

		expect(getLimitResetAt('claude-code')).toBe(new Date(future).getTime());
	});

	it('returns undefined when every reset window is already in the past (stale/expired)', () => {
		const now = Date.now();
		const past1 = new Date(now - 120_000).toISOString();
		const past2 = new Date(now - 60_000).toISOString();
		mockGetSnapshot.mockReturnValue(snap(past1, past2));

		expect(getLimitResetAt('claude-code')).toBeUndefined();
	});

	it('returns undefined when no snapshot is cached', () => {
		mockGetSnapshot.mockReturnValue(null);

		expect(getLimitResetAt('claude-code')).toBeUndefined();
	});

	it('returns undefined for non-Claude providers without touching the store', () => {
		expect(getLimitResetAt('codex')).toBeUndefined();
		expect(getLimitResetAt('opencode')).toBeUndefined();
		expect(mockGetSnapshot).not.toHaveBeenCalled();
	});
});

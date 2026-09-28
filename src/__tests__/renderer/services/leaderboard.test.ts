/**
 * Tests for the leaderboard delta outbox and drift detection.
 *
 * The server accumulates totals from `deltaMs` and ignores a `cumulativeTimeMs`
 * sent without one, so a dropped delta can never be reconstructed by a later
 * submission. Everything here exists to make sure a delta is either delivered
 * or held, never lost, and that a local total sitting above the server's is
 * reported rather than swallowed.
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import {
	submitLeaderboardTimeDelta,
	queueLeaderboardDelta,
	flushLeaderboardOutbox,
	noteAutoRunCreditAccrued,
	noteAutoRunCreditSettled,
	recoverUncommittedAutoRunCredit,
	reportLeaderboardDrift,
	LEADERBOARD_OUTBOX_KEY,
	LEADERBOARD_UNCOMMITTED_KEY,
	LEADERBOARD_DRIFT_NOTIFIED_KEY,
	type PendingLeaderboardDelta,
} from '../../../renderer/services/leaderboard';
import { notifyToast } from '../../../renderer/stores/notificationStore';
import { captureMessage } from '../../../renderer/utils/sentry';

const mockState: Record<string, unknown> = {};

vi.mock('../../../renderer/stores/settingsStore', () => ({
	useSettingsStore: {
		getState: () => mockState,
	},
	selectIsLeaderboardRegistered: (s: Record<string, unknown>) =>
		s.leaderboardRegistration !== null &&
		(s.leaderboardRegistration as { emailConfirmed?: boolean } | null)?.emailConfirmed === true,
}));

vi.mock('../../../renderer/stores/notificationStore', () => ({
	notifyToast: vi.fn(),
}));

vi.mock('../../../renderer/utils/sentry', () => ({
	captureException: vi.fn(),
	captureMessage: vi.fn(),
}));

let store: Record<string, unknown>;
let submit: Mock;

/** Settings-backed fake so the ledgers behave like the real persisted store. */
function installSettings(): void {
	store = {};
	(window as unknown as { maestro: unknown }).maestro = {
		settings: {
			get: vi.fn(async (key: string) => store[key]),
			set: vi.fn(async (key: string, value: unknown) => {
				store[key] = value;
				return true;
			}),
		},
		leaderboard: { submit },
	};
}

function outbox(): PendingLeaderboardDelta[] {
	return (store[LEADERBOARD_OUTBOX_KEY] as PendingLeaderboardDelta[]) ?? [];
}

beforeEach(async () => {
	vi.clearAllMocks();
	submit = vi.fn(async () => ({ success: true, message: 'ok' }));
	installSettings();
	mockState.leaderboardRegistration = {
		email: 'user@example.com',
		displayName: 'User',
		emailConfirmed: true,
		authToken: 'token123',
	};
	mockState.autoRunStats = { cumulativeTimeMs: 1_000_000, totalRuns: 3, longestRunMs: 500 };
	mockState.setLeaderboardRegistration = vi.fn();
});

describe('submitLeaderboardTimeDelta', () => {
	it('queues the delta when the submission is rejected', async () => {
		submit.mockResolvedValue({ success: false, message: 'nope', error: 'server down' });

		await submitLeaderboardTimeDelta({ deltaMs: 60_000, deltaRuns: 1, source: 'auto-run' });

		expect(outbox()).toHaveLength(1);
		expect(outbox()[0]).toMatchObject({ deltaMs: 60_000, deltaRuns: 1, source: 'auto-run' });
	});

	it('queues the delta when the submission throws', async () => {
		submit.mockRejectedValue(new Error('offline'));

		await submitLeaderboardTimeDelta({ deltaMs: 30_000, source: 'cue' });

		expect(outbox()).toHaveLength(1);
		expect(outbox()[0].deltaMs).toBe(30_000);
	});

	it('queues rather than drops when the auth token has not arrived yet', async () => {
		mockState.leaderboardRegistration = {
			email: 'user@example.com',
			displayName: 'User',
			emailConfirmed: true,
		};

		await submitLeaderboardTimeDelta({ deltaMs: 45_000, deltaRuns: 1 });

		expect(submit).not.toHaveBeenCalled();
		expect(outbox()).toHaveLength(1);
	});

	it('does not queue for an unregistered install', async () => {
		// An unregistered user ships their whole local total at registration, so
		// queueing pre-registration deltas would double-count them.
		mockState.leaderboardRegistration = null;

		await submitLeaderboardTimeDelta({ deltaMs: 45_000 });

		expect(outbox()).toHaveLength(0);
	});

	it('leaves the outbox empty on success', async () => {
		await submitLeaderboardTimeDelta({ deltaMs: 60_000, deltaRuns: 1 });

		expect(submit).toHaveBeenCalledTimes(1);
		expect(outbox()).toHaveLength(0);
	});
});

describe('flushLeaderboardOutbox', () => {
	it('drains every queued delta in order', async () => {
		await queueLeaderboardDelta({ deltaMs: 1000, deltaRuns: 1, source: 'auto-run' });
		await queueLeaderboardDelta({ deltaMs: 2000, source: 'cue' });
		await flushLeaderboardOutbox();

		expect(submit).toHaveBeenCalledTimes(2);
		expect(submit.mock.calls[0][0]).toMatchObject({ deltaMs: 1000, deltaRuns: 1 });
		expect(submit.mock.calls[1][0]).toMatchObject({ deltaMs: 2000, deltaRuns: 0 });
		expect(outbox()).toHaveLength(0);
	});

	it('stops at the first failure and keeps the rest', async () => {
		await queueLeaderboardDelta({ deltaMs: 1000 });
		await queueLeaderboardDelta({ deltaMs: 2000 });
		await queueLeaderboardDelta({ deltaMs: 3000 });
		submit.mockResolvedValueOnce({ success: true, message: 'ok' });
		submit.mockResolvedValue({ success: false, message: 'still down' });

		const result = await flushLeaderboardOutbox();

		expect(result.sent).toBe(1);
		expect(outbox().map((e) => e.deltaMs)).toEqual([2000, 3000]);
	});

	it('holds the queue while the user has no auth token', async () => {
		await queueLeaderboardDelta({ deltaMs: 1000 });
		mockState.leaderboardRegistration = {
			email: 'user@example.com',
			displayName: 'User',
			emailConfirmed: true,
		};

		const result = await flushLeaderboardOutbox();

		expect(submit).not.toHaveBeenCalled();
		expect(result.pending).toBe(1);
		expect(outbox()).toHaveLength(1);
	});
});

describe('uncommitted Auto Run credit', () => {
	it('recovers time from a run that never reached its completion submit', async () => {
		await noteAutoRunCreditAccrued(60_000);
		await noteAutoRunCreditAccrued(60_000);
		// App quits here - no completion, so nothing settles the counter.

		const recovered = await recoverUncommittedAutoRunCredit();

		expect(recovered).toBe(120_000);
		expect(outbox()).toHaveLength(1);
		expect(outbox()[0]).toMatchObject({ deltaMs: 120_000, deltaRuns: 0, source: 'auto-run' });
		expect(store[LEADERBOARD_UNCOMMITTED_KEY]).toBe(0);
	});

	it('recovers nothing once the run completed and settled its time', async () => {
		await noteAutoRunCreditAccrued(60_000);
		await noteAutoRunCreditSettled(65_000);

		const recovered = await recoverUncommittedAutoRunCredit();

		expect(recovered).toBe(0);
		expect(outbox()).toHaveLength(0);
	});

	it('does not accrue for an unregistered install', async () => {
		mockState.leaderboardRegistration = null;
		await noteAutoRunCreditAccrued(60_000);

		expect(await recoverUncommittedAutoRunCredit()).toBe(0);
	});
});

describe('reportLeaderboardDrift', () => {
	it('reports a local total that sits above the server', async () => {
		await reportLeaderboardDrift(3_693_225_045, 3_555_745_597);

		expect(captureMessage).toHaveBeenCalled();
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({ color: 'yellow', dismissible: true })
		);
	});

	it('ignores a gap inside the in-flight tolerance', async () => {
		await reportLeaderboardDrift(1_030_000, 1_000_000);

		expect(captureMessage).not.toHaveBeenCalled();
		expect(notifyToast).not.toHaveBeenCalled();
	});

	it('logs but does not nag twice in one day', async () => {
		store[LEADERBOARD_DRIFT_NOTIFIED_KEY] = Date.now();

		await reportLeaderboardDrift(3_693_225_045, 3_555_745_597);

		expect(captureMessage).toHaveBeenCalled();
		expect(notifyToast).not.toHaveBeenCalled();
	});
});

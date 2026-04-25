/**
 * Tests for CueRecoveryService.
 *
 * The recovery service owns three previously-scattered concerns:
 *  - DB init + event prune at engine start
 *  - Sleep gap detection (heartbeat-based)
 *  - Missed-event reconciliation after wake
 *
 * Pulling them behind one façade lets the engine become a thin coordinator.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockInitCueDb = vi.fn();
const mockCloseCueDb = vi.fn();
const mockPruneCueEvents = vi.fn();
const mockGetLastHeartbeat = vi.fn<() => number | null>();

vi.mock('../../../main/cue/cue-db', () => ({
	initCueDb: (...args: unknown[]) => mockInitCueDb(...args),
	closeCueDb: () => mockCloseCueDb(),
	pruneCueEvents: (...args: unknown[]) => mockPruneCueEvents(...args),
	getLastHeartbeat: () => mockGetLastHeartbeat(),
}));

const mockCaptureException = vi.fn();
vi.mock('../../../main/utils/sentry', () => ({
	captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

import {
	createCueRecoveryService,
	EVENT_PRUNE_AGE_MS,
	SLEEP_THRESHOLD_MS,
} from '../../../main/cue/cue-recovery-service';
import type { CueConfig, CueEvent, CueSubscription } from '../../../main/cue/cue-types';

function baseConfig(subscriptions: CueSubscription[]): CueConfig {
	return {
		subscriptions,
		settings: {
			timeout_minutes: 30,
			timeout_on_fail: 'break',
			max_concurrent: 1,
			queue_size: 10,
		},
	};
}

describe('cue-recovery-service', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe('init', () => {
		it('returns ok and initializes the DB + prunes events', () => {
			const onLog = vi.fn();
			const service = createCueRecoveryService({
				onLog,
				getSessions: () => new Map(),
				onDispatch: vi.fn(),
			});

			const result = service.init();

			expect(result.ok).toBe(true);
			expect(mockInitCueDb).toHaveBeenCalledOnce();
			expect(mockPruneCueEvents).toHaveBeenCalledWith(EVENT_PRUNE_AGE_MS);
		});

		it('returns ok=false and logs/captures when DB init throws', () => {
			const dbError = new Error('disk full');
			mockInitCueDb.mockImplementation(() => {
				throw dbError;
			});
			const onLog = vi.fn();
			const service = createCueRecoveryService({
				onLog,
				getSessions: () => new Map(),
				onDispatch: vi.fn(),
			});

			const result = service.init();

			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error).toBe(dbError);
			}
			expect(onLog).toHaveBeenCalledWith(
				'error',
				expect.stringContaining('Failed to initialize Cue database')
			);
			expect(mockCaptureException).toHaveBeenCalledWith(
				dbError,
				expect.objectContaining({ extra: { operation: 'cue.dbInit' } })
			);
			// pruneCueEvents must NOT be called after init failed.
			expect(mockPruneCueEvents).not.toHaveBeenCalled();
		});

		it('wraps non-Error throw values in an Error', () => {
			mockInitCueDb.mockImplementation(() => {
				throw 'plain string failure';
			});
			const service = createCueRecoveryService({
				onLog: vi.fn(),
				getSessions: () => new Map(),
				onDispatch: vi.fn(),
			});

			const result = service.init();

			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error).toBeInstanceOf(Error);
				expect(result.error.message).toBe('plain string failure');
			}
		});
	});

	describe('detectSleepAndReconcile', () => {
		it('does nothing when there is no last heartbeat (first ever start)', () => {
			mockGetLastHeartbeat.mockReturnValue(null);
			const onDispatch = vi.fn();
			const service = createCueRecoveryService({
				onLog: vi.fn(),
				getSessions: () => new Map(),
				onDispatch,
			});

			service.detectSleepAndReconcile();

			expect(onDispatch).not.toHaveBeenCalled();
		});

		it('does nothing when the gap is below the sleep threshold', () => {
			const now = Date.now();
			vi.spyOn(Date, 'now').mockReturnValue(now);
			// Gap of just 1 minute — well under SLEEP_THRESHOLD_MS (2 minutes).
			mockGetLastHeartbeat.mockReturnValue(now - 60_000);

			const onDispatch = vi.fn();
			const onLog = vi.fn();
			const service = createCueRecoveryService({
				onLog,
				getSessions: () =>
					new Map([
						[
							's1',
							{
								config: baseConfig([
									{
										name: 'beat',
										event: 'time.heartbeat',
										enabled: true,
										prompt: 'tick',
										interval_minutes: 1,
									},
								]),
								sessionName: 'Test',
							},
						],
					]),
				onDispatch,
			});

			service.detectSleepAndReconcile();

			expect(onDispatch).not.toHaveBeenCalled();
			expect(onLog).not.toHaveBeenCalledWith('cue', expect.stringContaining('Sleep detected'));
		});

		it('dispatches a catch-up event for each missed time.heartbeat subscription', () => {
			const now = Date.now();
			vi.spyOn(Date, 'now').mockReturnValue(now);
			// 10-minute gap — well over both the threshold and the 1-min interval.
			mockGetLastHeartbeat.mockReturnValue(now - 10 * 60_000);

			const onDispatch =
				vi.fn<(sessionId: string, sub: CueSubscription, event: CueEvent) => void>();
			const onLog = vi.fn();
			const service = createCueRecoveryService({
				onLog,
				getSessions: () =>
					new Map([
						[
							's1',
							{
								config: baseConfig([
									{
										name: 'beat',
										event: 'time.heartbeat',
										enabled: true,
										prompt: 'tick',
										interval_minutes: 1,
									},
								]),
								sessionName: 'Test',
							},
						],
					]),
				onDispatch,
			});

			service.detectSleepAndReconcile();

			expect(onLog).toHaveBeenCalledWith('cue', expect.stringContaining('Sleep detected'));
			expect(onDispatch).toHaveBeenCalledOnce();
			const [sessionId, sub, event] = onDispatch.mock.calls[0];
			expect(sessionId).toBe('s1');
			expect(sub.name).toBe('beat');
			expect(event.type).toBe('time.heartbeat');
			expect(event.payload).toMatchObject({
				reconciled: true,
				missedCount: 10,
			});
		});

		it('survives errors thrown by getLastHeartbeat', () => {
			mockGetLastHeartbeat.mockImplementation(() => {
				throw new Error('db read failed');
			});
			const onLog = vi.fn();
			const service = createCueRecoveryService({
				onLog,
				getSessions: () => new Map(),
				onDispatch: vi.fn(),
			});

			expect(() => service.detectSleepAndReconcile()).not.toThrow();
			expect(onLog).toHaveBeenCalledWith('warn', expect.stringContaining('Sleep detection failed'));
		});

		it('uses the documented sleep threshold value', () => {
			expect(SLEEP_THRESHOLD_MS).toBe(120_000);
		});
	});

	describe('shutdown', () => {
		it('closes the DB', () => {
			const service = createCueRecoveryService({
				onLog: vi.fn(),
				getSessions: () => new Map(),
				onDispatch: vi.fn(),
			});

			service.shutdown();

			expect(mockCloseCueDb).toHaveBeenCalledOnce();
		});

		it('does not throw when DB close fails (e.g. never initialized)', () => {
			mockCloseCueDb.mockImplementation(() => {
				throw new Error('not open');
			});
			const service = createCueRecoveryService({
				onLog: vi.fn(),
				getSessions: () => new Map(),
				onDispatch: vi.fn(),
			});

			expect(() => service.shutdown()).not.toThrow();
		});
	});
});

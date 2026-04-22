/**
 * Tests for cue-heartbeat — Phase 13A consecutive-failure reporting.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockUpdateHeartbeat = vi.fn();
const mockCaptureException = vi.fn();

vi.mock('../../../main/cue/cue-db', () => ({
	updateHeartbeat: () => mockUpdateHeartbeat(),
}));
vi.mock('../../../main/utils/sentry', () => ({
	captureException: (err: unknown, extra?: unknown) => mockCaptureException(err, extra),
}));

import {
	createCueHeartbeat,
	HEARTBEAT_INTERVAL_MS,
	HEARTBEAT_FAILURE_REPORT_THRESHOLD,
} from '../../../main/cue/cue-heartbeat';

describe('cue-heartbeat', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		mockUpdateHeartbeat.mockReset();
		mockCaptureException.mockReset();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('writes the heartbeat immediately on start()', () => {
		const hb = createCueHeartbeat();
		hb.start();
		expect(mockUpdateHeartbeat).toHaveBeenCalledTimes(1);
		hb.stop();
	});

	it('writes the heartbeat on every interval tick', () => {
		const hb = createCueHeartbeat();
		hb.start();
		mockUpdateHeartbeat.mockClear();
		vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
		vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
		expect(mockUpdateHeartbeat).toHaveBeenCalledTimes(2);
		hb.stop();
	});

	it('invokes onTick callback on each interval', () => {
		const onTick = vi.fn();
		const hb = createCueHeartbeat(onTick);
		hb.start();
		vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
		vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
		expect(onTick).toHaveBeenCalledTimes(2);
		hb.stop();
	});

	it('does not call Sentry after 1 or 2 consecutive failures', () => {
		mockUpdateHeartbeat.mockImplementation(() => {
			throw new Error('SQLITE_BUSY: database is locked');
		});
		const hb = createCueHeartbeat();
		hb.start(); // attempt #1 — failure
		vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS); // attempt #2 — failure
		expect(mockCaptureException).not.toHaveBeenCalled();
		hb.stop();
	});

	it('reports exactly once per failure run at the threshold', () => {
		mockUpdateHeartbeat.mockImplementation(() => {
			throw new Error('SQLITE_BUSY: database is locked');
		});
		const hb = createCueHeartbeat();
		hb.start();
		for (let i = 0; i < HEARTBEAT_FAILURE_REPORT_THRESHOLD + 5; i++) {
			vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
		}
		// Strict equality in the emit condition means ONE Sentry event even
		// though the failures continued well past the threshold.
		expect(mockCaptureException).toHaveBeenCalledTimes(1);
		expect(mockCaptureException).toHaveBeenCalledWith(
			expect.any(Error),
			expect.objectContaining({ operation: 'cue:heartbeat' })
		);
		hb.stop();
	});

	it('resets the counter on first success after a failure run', () => {
		let fail = true;
		mockUpdateHeartbeat.mockImplementation(() => {
			if (fail) throw new Error('SQLITE_BUSY: database is locked');
		});
		const hb = createCueHeartbeat();
		hb.start(); // #1 fail
		vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS); // #2 fail
		fail = false;
		vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS); // #3 succeeds — counter resets
		// Now trigger a fresh failure run. Need to reach threshold AGAIN to report.
		fail = true;
		vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS); // #1 fail
		vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS); // #2 fail
		expect(mockCaptureException).not.toHaveBeenCalled();
		vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS); // #3 fail → reports
		expect(mockCaptureException).toHaveBeenCalledTimes(1);
		hb.stop();
	});

	it('stop() clears the failure counter', () => {
		mockUpdateHeartbeat.mockImplementation(() => {
			throw new Error('SQLITE_BUSY: database is locked');
		});
		const hb = createCueHeartbeat();
		hb.start();
		vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS); // 2 failures total
		hb.stop();

		// Re-start — because stop cleared the counter, we need THREE more
		// failures to trigger Sentry, not one.
		mockCaptureException.mockReset();
		hb.start();
		vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS); // #2
		expect(mockCaptureException).not.toHaveBeenCalled();
		vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS); // #3 → reports
		expect(mockCaptureException).toHaveBeenCalledTimes(1);
		hb.stop();
	});

	it('reports unexpected (non-DB-lock) errors immediately without waiting for the threshold', () => {
		// Novel failure modes — a programming error, a type mismatch, a
		// permission problem — should not hide behind the 3-tick threshold
		// that exists specifically for SQLite lock races. Surface them on
		// the first occurrence so the field data from Sentry flags them.
		mockUpdateHeartbeat.mockImplementation(() => {
			throw new Error('something completely unexpected went wrong');
		});
		const onFailure = vi.fn();
		const hb = createCueHeartbeat({ onFailure });
		hb.start(); // attempt #1 — single failure
		expect(mockCaptureException).toHaveBeenCalledTimes(1);
		expect(mockCaptureException).toHaveBeenCalledWith(
			expect.any(Error),
			expect.objectContaining({ operation: 'cue:heartbeat', consecutiveFailures: 1 })
		);
		expect(onFailure).toHaveBeenCalledWith({ type: 'heartbeatFailure', consecutiveFailures: 1 });
		hb.stop();
	});

	it('clears the interval on stop()', () => {
		const hb = createCueHeartbeat();
		hb.start();
		hb.stop();
		mockUpdateHeartbeat.mockClear();
		vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 3);
		expect(mockUpdateHeartbeat).not.toHaveBeenCalled();
	});
});

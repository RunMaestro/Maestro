/**
 * Tests for wireMultiWindowTelemetry - the main-process subscriber that records
 * aggregate multi-window usage as windows open.
 *
 * The wiring is exercised against a REAL WindowRegistry (it has no native deps)
 * with an injected fake stats DB, so we verify the full open -> record path:
 * secondary opens record with the live concurrent count, the primary and window
 * closes do not, and the analytics setting / DB-readiness gates are honored.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BrowserWindow } from 'electron';

// Mock Sentry so the failure-path test can assert reporting without the real
// (dynamically imported) Sentry module.
const mockCaptureException = vi.fn();
vi.mock('../../../main/utils/sentry', () => ({
	captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

import { WindowRegistry } from '../../../main/window-registry';
import { wireMultiWindowTelemetry } from '../../../main/stats/multi-window-telemetry';

/** Minimal fake BrowserWindow - the registry only calls getBounds/isDestroyed. */
function makeWindow(): BrowserWindow {
	return {
		getBounds: vi.fn(() => ({ x: 0, y: 0, width: 800, height: 600 })),
		isDestroyed: vi.fn(() => false),
	} as unknown as BrowserWindow;
}

/** A fake stats DB exposing just what the telemetry wiring touches. */
function makeStatsDb(opts: { ready?: boolean; throwOnRecord?: boolean } = {}) {
	const { ready = true, throwOnRecord = false } = opts;
	return {
		isReady: vi.fn(() => ready),
		recordWindowOpened: vi.fn((..._args: unknown[]) => {
			if (throwOnRecord) throw new Error('db boom');
			return '2026-06-23';
		}),
	};
}

describe('wireMultiWindowTelemetry', () => {
	let registry: WindowRegistry;

	beforeEach(() => {
		mockCaptureException.mockClear();
		registry = new WindowRegistry();
	});

	it('records a secondary window open with the live concurrent window count', () => {
		const db = makeStatsDb();
		wireMultiWindowTelemetry(registry, { getStatsDb: () => db });

		// Primary first (count 1, not recorded), then a secondary (count 2).
		registry.create({ windowId: 'main', browserWindow: makeWindow(), isMain: true });
		registry.create({ windowId: 'w2', browserWindow: makeWindow(), isMain: false });

		expect(db.recordWindowOpened).toHaveBeenCalledTimes(1);
		expect(db.recordWindowOpened).toHaveBeenCalledWith(expect.any(Number), 2);
	});

	it('does NOT record the primary window opening', () => {
		const db = makeStatsDb();
		wireMultiWindowTelemetry(registry, { getStatsDb: () => db });

		registry.create({ windowId: 'main', browserWindow: makeWindow(), isMain: true });

		expect(db.recordWindowOpened).not.toHaveBeenCalled();
	});

	it('raises the concurrent count as more secondary windows open', () => {
		const db = makeStatsDb();
		wireMultiWindowTelemetry(registry, { getStatsDb: () => db });

		registry.create({ windowId: 'main', browserWindow: makeWindow(), isMain: true });
		registry.create({ windowId: 'w2', browserWindow: makeWindow(), isMain: false });
		registry.create({ windowId: 'w3', browserWindow: makeWindow(), isMain: false });

		expect(db.recordWindowOpened).toHaveBeenNthCalledWith(1, expect.any(Number), 2);
		expect(db.recordWindowOpened).toHaveBeenNthCalledWith(2, expect.any(Number), 3);
	});

	it('records nothing when statsCollectionEnabled is false', () => {
		const db = makeStatsDb();
		const settingsStore = { get: vi.fn(() => false) };
		wireMultiWindowTelemetry(registry, { getStatsDb: () => db, settingsStore });

		registry.create({ windowId: 'main', browserWindow: makeWindow(), isMain: true });
		registry.create({ windowId: 'w2', browserWindow: makeWindow(), isMain: false });

		expect(settingsStore.get).toHaveBeenCalledWith('statsCollectionEnabled');
		expect(db.recordWindowOpened).not.toHaveBeenCalled();
	});

	it('records when statsCollectionEnabled is unset (defaults to enabled)', () => {
		const db = makeStatsDb();
		const settingsStore = { get: vi.fn(() => undefined) };
		wireMultiWindowTelemetry(registry, { getStatsDb: () => db, settingsStore });

		registry.create({ windowId: 'main', browserWindow: makeWindow(), isMain: true });
		registry.create({ windowId: 'w2', browserWindow: makeWindow(), isMain: false });

		expect(db.recordWindowOpened).toHaveBeenCalledTimes(1);
	});

	it('skips recording when the stats DB is not ready', () => {
		const db = makeStatsDb({ ready: false });
		wireMultiWindowTelemetry(registry, { getStatsDb: () => db });

		registry.create({ windowId: 'main', browserWindow: makeWindow(), isMain: true });
		registry.create({ windowId: 'w2', browserWindow: makeWindow(), isMain: false });

		expect(db.recordWindowOpened).not.toHaveBeenCalled();
	});

	it('does not record on window close (removed)', () => {
		const db = makeStatsDb();
		wireMultiWindowTelemetry(registry, { getStatsDb: () => db });

		registry.create({ windowId: 'main', browserWindow: makeWindow(), isMain: true });
		registry.create({ windowId: 'w2', browserWindow: makeWindow(), isMain: false });
		db.recordWindowOpened.mockClear();

		registry.remove('w2');

		expect(db.recordWindowOpened).not.toHaveBeenCalled();
	});

	it('swallows a stats failure (never breaks window creation) and reports it to Sentry', () => {
		const db = makeStatsDb({ throwOnRecord: true });
		wireMultiWindowTelemetry(registry, { getStatsDb: () => db });

		registry.create({ windowId: 'main', browserWindow: makeWindow(), isMain: true });

		expect(() =>
			registry.create({ windowId: 'w2', browserWindow: makeWindow(), isMain: false })
		).not.toThrow();
		// The window was still registered despite the telemetry failure.
		expect(registry.get('w2')).toBeDefined();
		expect(mockCaptureException).toHaveBeenCalledTimes(1);
	});

	it('stops recording after the returned unsubscribe is called', () => {
		const db = makeStatsDb();
		const unsubscribe = wireMultiWindowTelemetry(registry, { getStatsDb: () => db });

		registry.create({ windowId: 'main', browserWindow: makeWindow(), isMain: true });
		unsubscribe();
		registry.create({ windowId: 'w2', browserWindow: makeWindow(), isMain: false });

		expect(db.recordWindowOpened).not.toHaveBeenCalled();
	});
});

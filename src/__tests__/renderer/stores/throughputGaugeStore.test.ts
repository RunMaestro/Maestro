/**
 * Tests for throughputGaugeStore: the persisted open/closed latch, the peak
 * that only rises until reset, the bounded history of every metric, the
 * restart a new reading rule triggers, the idle short-circuit that keeps an
 * idle gauge at zero store writes, and the persisted per-layout card rects.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { installLocalStorageMock } from '../../helpers/mockLocalStorage';
import {
	THROUGHPUT_GAUGE_RECTS_KEY,
	THROUGHPUT_GAUGE_VISIBLE_KEY,
	THROUGHPUT_HISTORY_LENGTH,
	useThroughputGaugeStore,
} from '../../../renderer/stores/throughputGaugeStore';

const ZERO = { in: 0, out: 0, combined: 0 };
const EMPTY_HISTORY = { in: [], out: [], combined: [] };

function rates(inRate: number, outRate: number) {
	return { in: inRate, out: outRate, combined: inRate + outRate };
}

describe('throughputGaugeStore', () => {
	let storage: Map<string, string>;

	beforeEach(() => {
		storage = installLocalStorageMock();
		useThroughputGaugeStore.setState({
			visible: true,
			rates: ZERO,
			peak: ZERO,
			history: EMPTY_HISTORY,
			rects: {},
		});
	});

	describe('visible latch', () => {
		it('hide, show and toggle flip visible and persist it', () => {
			const store = useThroughputGaugeStore.getState();
			store.hide();
			expect(useThroughputGaugeStore.getState().visible).toBe(false);
			expect(storage.get(THROUGHPUT_GAUGE_VISIBLE_KEY)).toBe('false');

			store.show();
			expect(useThroughputGaugeStore.getState().visible).toBe(true);
			expect(storage.get(THROUGHPUT_GAUGE_VISIBLE_KEY)).toBe('true');

			store.toggle();
			expect(useThroughputGaugeStore.getState().visible).toBe(false);
			expect(storage.get(THROUGHPUT_GAUGE_VISIBLE_KEY)).toBe('false');
		});

		it('loads the persisted value at startup and defaults to visible', async () => {
			storage.set(THROUGHPUT_GAUGE_VISIBLE_KEY, 'false');
			vi.resetModules();
			const hidden = await import('../../../renderer/stores/throughputGaugeStore');
			expect(hidden.useThroughputGaugeStore.getState().visible).toBe(false);

			storage.clear();
			vi.resetModules();
			const fresh = await import('../../../renderer/stores/throughputGaugeStore');
			expect(fresh.useThroughputGaugeStore.getState().visible).toBe(true);
		});
	});

	describe('publish', () => {
		it('sets the rates and appends every metric to its own history in one write', () => {
			const listener = vi.fn();
			const unsubscribe = useThroughputGaugeStore.subscribe(listener);
			useThroughputGaugeStore.getState().publish(rates(10, 5));
			unsubscribe();

			const state = useThroughputGaugeStore.getState();
			expect(state.rates).toEqual(rates(10, 5));
			expect(state.history).toEqual({ in: [10], out: [5], combined: [15] });
			expect(listener).toHaveBeenCalledTimes(1);
		});

		it('raises each peak independently and never lowers it', () => {
			const { publish } = useThroughputGaugeStore.getState();
			publish(rates(40, 2));
			publish(rates(1, 30));
			publish(rates(0, 0));
			expect(useThroughputGaugeStore.getState().peak).toEqual({ in: 40, out: 30, combined: 42 });
		});

		it('caps history at THROUGHPUT_HISTORY_LENGTH, oldest dropped first', () => {
			const { publish } = useThroughputGaugeStore.getState();
			for (let i = 1; i <= THROUGHPUT_HISTORY_LENGTH + 5; i++) publish(rates(i, 0));
			const { history } = useThroughputGaugeStore.getState();
			for (const buffer of [history.in, history.out, history.combined]) {
				expect(buffer).toHaveLength(THROUGHPUT_HISTORY_LENGTH);
			}
			expect(history.in[0]).toBe(6);
			expect(history.in[history.in.length - 1]).toBe(THROUGHPUT_HISTORY_LENGTH + 5);
		});

		it('keeps writing zeros until the history has drained, then stops writing', () => {
			const { publish } = useThroughputGaugeStore.getState();
			publish(rates(3, 0));
			publish(ZERO);
			expect(useThroughputGaugeStore.getState().history.combined).toEqual([3, 0]);

			// Drain the nonzero reading out of the history.
			for (let i = 0; i < THROUGHPUT_HISTORY_LENGTH; i++) publish(ZERO);
			const drained = useThroughputGaugeStore.getState();
			expect(drained.history.combined.every((value) => value === 0)).toBe(true);

			// Fully idle now: another zero is not a write.
			publish(ZERO);
			expect(useThroughputGaugeStore.getState()).toBe(drained);
		});

		it('does not write at all when an idle gauge publishes zeros', () => {
			const before = useThroughputGaugeStore.getState();
			before.publish(ZERO);
			expect(useThroughputGaugeStore.getState()).toBe(before);
		});
	});

	it('resetPeak drops the peak to the current reading', () => {
		const { publish, resetPeak } = useThroughputGaugeStore.getState();
		publish(rates(100, 50));
		publish(rates(4, 1));
		resetPeak();
		expect(useThroughputGaugeStore.getState().peak).toEqual(rates(4, 1));
	});

	it('restartReadings zeroes the peak and empties the history', () => {
		const { publish, restartReadings } = useThroughputGaugeStore.getState();
		publish(rates(100, 50));
		restartReadings();
		const state = useThroughputGaugeStore.getState();
		expect(state.peak).toEqual(ZERO);
		expect(state.history).toEqual(EMPTY_HISTORY);
		expect(state.rates).toEqual(rates(100, 50));
	});

	describe('rects', () => {
		const rect = { left: 40, top: 300, width: 240, height: 220 };

		it('setRect stores the rect for its layout and persists all of them', () => {
			const { setRect } = useThroughputGaugeStore.getState();
			setRect('single', rect);
			setRect('all', { ...rect, width: 600 });

			expect(useThroughputGaugeStore.getState().rects).toEqual({
				single: rect,
				all: { ...rect, width: 600 },
			});
			expect(JSON.parse(storage.get(THROUGHPUT_GAUGE_RECTS_KEY) ?? '')).toEqual({
				single: rect,
				all: { ...rect, width: 600 },
			});
		});

		it('loads stored rects at startup, dropping bad ones', async () => {
			storage.set(
				THROUGHPUT_GAUGE_RECTS_KEY,
				JSON.stringify({ single: rect, all: { left: 'nope' } })
			);
			vi.resetModules();
			const fresh = await import('../../../renderer/stores/throughputGaugeStore');
			expect(fresh.useThroughputGaugeStore.getState().rects).toEqual({ single: rect });
		});

		it('starts with no rects when the stored value is not JSON', async () => {
			storage.set(THROUGHPUT_GAUGE_RECTS_KEY, '{not json');
			vi.resetModules();
			const fresh = await import('../../../renderer/stores/throughputGaugeStore');
			expect(fresh.useThroughputGaugeStore.getState().rects).toEqual({});
		});
	});
});

/**
 * throughputGaugeStore - what the Throughput Gauge shows.
 *
 * Written on a timer only: `useThroughputCapture` feeds every stream chunk and
 * usage event to the rate engine (`src/shared/throughputRate.ts`) and calls
 * `publish()` with the rolling rates every `THROUGHPUT_PUBLISH_MS`. Nothing
 * writes here per chunk, so a fast stream costs the gauge four renders a
 * second, not one per token.
 *
 * `history` keeps one buffer per metric (in, out, combined), so the sparkline
 * style has a past to draw in both layouts and switching the shown metric does
 * not start its chart from empty. Each publish appends to all three in the
 * same single write.
 *
 * `peak` and `history` only compare readings taken under one rule. The capture
 * hook calls `restartReadings()` when the scope or the rolling window changes,
 * and when it stops (the feature turned off), so a later start begins clean.
 *
 * `visible` is the user's close/open latch and is remembered across launches.
 * It is separate from the Encore flag: the flag decides whether the gauge
 * exists at all, `visible` whether its card is on screen.
 *
 * `rects` is where the card sits and how big it is, one rect per layout,
 * remembered across launches. It is written when a drag or resize ENDS, never
 * per pointer move.
 */

import { create } from 'zustand';
import type { ThroughputLayout } from '../../shared/throughputGauge';
import {
	EMPTY_THROUGHPUT_HISTORY,
	ZERO_THROUGHPUT_RATES,
	type ThroughputHistory,
	type ThroughputMetric,
	type ThroughputRates,
} from '../../shared/throughputRate';
import {
	sanitizeGaugeRects,
	type GaugeRect,
	type GaugeRects,
} from '../components/ThroughputGauge/gaugeGeometry';
import { safeStorageGet, safeStorageSet } from '../utils/safeLocalStorage';

/** localStorage key for the card's open/closed latch. */
export const THROUGHPUT_GAUGE_VISIBLE_KEY = 'throughputGauge.visible';
/** localStorage key for the card's per-layout position and size. */
export const THROUGHPUT_GAUGE_RECTS_KEY = 'throughputGauge.rects';

/** How many published readings each `history` buffer keeps (for a sparkline). */
export const THROUGHPUT_HISTORY_LENGTH = 60;

export type { ThroughputHistory };

const METRICS: readonly ThroughputMetric[] = ['in', 'out', 'combined'];

function loadVisible(): boolean {
	const raw = safeStorageGet(THROUGHPUT_GAUGE_VISIBLE_KEY);
	return raw === null ? true : raw === 'true';
}

function loadRects(): GaugeRects {
	const raw = safeStorageGet(THROUGHPUT_GAUGE_RECTS_KEY);
	if (raw === null) return {};
	try {
		return sanitizeGaugeRects(JSON.parse(raw));
	} catch {
		// Not JSON: an older or hand-edited value. Open at the defaults.
		return {};
	}
}

/** `buffer` with `reading` appended, capped at {@link THROUGHPUT_HISTORY_LENGTH}. */
function appendReading(buffer: readonly number[], reading: number): number[] {
	const kept =
		buffer.length >= THROUGHPUT_HISTORY_LENGTH
			? buffer.slice(buffer.length - THROUGHPUT_HISTORY_LENGTH + 1)
			: buffer.slice();
	kept.push(reading);
	return kept;
}

function hasNonzeroHistory(history: ThroughputHistory): boolean {
	return METRICS.some((metric) => history[metric].some((value) => value > 0));
}

function isIdle(rates: ThroughputRates): boolean {
	return rates.in === 0 && rates.out === 0 && rates.combined === 0;
}

export interface ThroughputGaugeState {
	/** Whether the floating card is on screen. Persisted; defaults to true. */
	visible: boolean;
	/** Latest published rates, tokens per second. */
	rates: ThroughputRates;
	/** Highest reading per metric since the last `resetPeak()`. */
	peak: ThroughputRates;
	/** The last {@link THROUGHPUT_HISTORY_LENGTH} readings of each metric. */
	history: ThroughputHistory;
	/** Where the card sits, per layout. Persisted; empty until the user moves or resizes it. */
	rects: GaugeRects;
}

export interface ThroughputGaugeActions {
	show: () => void;
	hide: () => void;
	toggle: () => void;
	/** Start the peak again from the current reading (the user's Reset peak). */
	resetPeak: () => void;
	/** Zero `peak` and empty `history`: the reading rule (scope or window) changed. */
	restartReadings: () => void;
	/** Take one timer reading: set `rates`, raise `peak`, and append each metric to its history. */
	publish: (rates: ThroughputRates) => void;
	/** Remember the card's rect for a layout. Call at the END of a drag or resize. */
	setRect: (layout: ThroughputLayout, rect: GaugeRect) => void;
}

export type ThroughputGaugeStore = ThroughputGaugeState & ThroughputGaugeActions;

export const useThroughputGaugeStore = create<ThroughputGaugeStore>()((set, get) => {
	const setVisible = (visible: boolean) => {
		safeStorageSet(THROUGHPUT_GAUGE_VISIBLE_KEY, String(visible));
		set({ visible });
	};

	return {
		visible: loadVisible(),
		rates: ZERO_THROUGHPUT_RATES,
		peak: ZERO_THROUGHPUT_RATES,
		history: EMPTY_THROUGHPUT_HISTORY,
		rects: loadRects(),

		show: () => setVisible(true),
		hide: () => setVisible(false),
		toggle: () => setVisible(!get().visible),

		resetPeak: () => set({ peak: get().rates }),

		restartReadings: () => set({ peak: ZERO_THROUGHPUT_RATES, history: EMPTY_THROUGHPUT_HISTORY }),

		publish: (rates) => {
			const state = get();
			// An idle app publishes zeros four times a second. Once the histories
			// have drained to zeros too there is nothing left to change, so skip the
			// write and keep an idle gauge at zero renders.
			if (isIdle(rates) && isIdle(state.rates) && !hasNonzeroHistory(state.history)) {
				return;
			}
			set({
				rates,
				peak: {
					in: Math.max(state.peak.in, rates.in),
					out: Math.max(state.peak.out, rates.out),
					combined: Math.max(state.peak.combined, rates.combined),
				},
				history: {
					in: appendReading(state.history.in, rates.in),
					out: appendReading(state.history.out, rates.out),
					combined: appendReading(state.history.combined, rates.combined),
				},
			});
		},

		setRect: (layout, rect) => {
			const rects = { ...get().rects, [layout]: rect };
			safeStorageSet(THROUGHPUT_GAUGE_RECTS_KEY, JSON.stringify(rects));
			set({ rects });
		},
	};
});

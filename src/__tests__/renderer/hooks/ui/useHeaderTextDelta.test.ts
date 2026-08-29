import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useHeaderTextDelta } from '../../../../renderer/hooks/ui/useHeaderTextDelta';
import { clearTextMeasurementCache } from '../../../../renderer/utils/measureTextWidth';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';

/**
 * Replace ONLY `createElement('canvas')`. renderHook needs the real
 * implementation for every other tag - intercepting all of them breaks React's
 * own rendering before the hook ever runs.
 */
function stubCanvas(makeContext: () => unknown) {
	const realCreateElement = document.createElement.bind(document);
	vi.spyOn(document, 'createElement').mockImplementation(((tag: string, ...rest: unknown[]) => {
		if (tag === 'canvas') return { getContext: makeContext } as unknown as HTMLCanvasElement;
		return realCreateElement(tag, ...(rest as []));
	}) as typeof document.createElement);
}

/**
 * A canvas stub whose advance width depends on the font string, so a
 * proportional face measures wider than the monospace baseline - the whole
 * condition this hook exists to detect.
 */
function installCanvasStub() {
	stubCanvas(() => {
		const ctx = { font: '' } as { font: string; measureText: (text: string) => TextMetrics };
		ctx.measureText = (text: string) => {
			const px = Number(/(\d+(?:\.\d+)?)px/.exec(ctx.font)?.[1] ?? 14);
			// Only the FIRST family decides the metrics, the way a browser picks
			// the first installed face. Testing the whole string would match the
			// monospace fallback chain that `withMonoFallback` appends to every
			// value, and report a proportional font as monospace.
			const leading = /px\s+(.+)$/.exec(ctx.font)?.[1]?.split(',')[0] ?? '';
			const perEm = /Mono|Menlo|Courier|monospace/i.test(leading) ? 0.6 : 0.75;
			return { width: text.length * px * perEm } as TextMetrics;
		};
		return ctx;
	});
}

beforeEach(() => {
	clearTextMeasurementCache();
	useSettingsStore.setState({
		fontFamily: 'Roboto Mono, Menlo, "Courier New", monospace',
		fontSize: 14,
		fontZoom: 1,
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	clearTextMeasurementCache();
});

describe('useHeaderTextDelta', () => {
	it('is zero on the baseline font, so the shipped thresholds are unchanged', () => {
		// The constants were measured against exactly this font at this size.
		// Any correction here would move a threshold that was already right.
		installCanvasStub();
		const { result } = renderHook(() => useHeaderTextDelta());

		expect(result.current.wordmark).toBe(0);
		expect(result.current.liveLabel).toBe(0);
	});

	it('reports extra width for the LIVE label under a proportional face', () => {
		installCanvasStub();
		useSettingsStore.setState({ fontFamily: 'Inter' });
		const { result } = renderHook(() => useHeaderTextDelta());

		expect(result.current.liveLabel).toBeGreaterThan(0);
	});

	it('does NOT widen the wordmark for a proportional face', () => {
		// The wordmark is pinned to the brand font (see Wordmark.tsx), so the
		// interface font cannot change its width. Reserving for a widening that
		// cannot happen would hide the wordmark earlier than necessary.
		installCanvasStub();
		useSettingsStore.setState({ fontFamily: 'Inter' });
		const { result } = renderHook(() => useHeaderTextDelta());

		expect(result.current.wordmark).toBe(0);
	});

	it('grows the wordmark delta with the root size', () => {
		// The wordmark is `text-lg`, a rem size, so it scales with the root.
		installCanvasStub();
		useSettingsStore.setState({ fontFamily: 'Inter', fontSize: 14 });
		const small = renderHook(() => useHeaderTextDelta()).result.current.wordmark;

		clearTextMeasurementCache();
		useSettingsStore.setState({ fontSize: 20 });
		const large = renderHook(() => useHeaderTextDelta()).result.current.wordmark;

		expect(large).toBeGreaterThan(small);
	});

	it('leaves the LIVE label delta alone when only the root size changes', () => {
		// That label is `text-[10px]`, an absolute size - it does not scale with
		// the root, so reserving more for it would be wrong.
		installCanvasStub();
		useSettingsStore.setState({ fontFamily: 'Inter', fontSize: 14 });
		const small = renderHook(() => useHeaderTextDelta()).result.current.liveLabel;

		clearTextMeasurementCache();
		useSettingsStore.setState({ fontSize: 20 });
		const large = renderHook(() => useHeaderTextDelta()).result.current.liveLabel;

		expect(large).toBe(small);
	});

	it('accounts for zoom, since thresholds compare against real pixels', () => {
		installCanvasStub();
		useSettingsStore.setState({ fontFamily: 'Inter', fontZoom: 1 });
		const unzoomed = renderHook(() => useHeaderTextDelta()).result.current.wordmark;

		clearTextMeasurementCache();
		useSettingsStore.setState({ fontZoom: 2 });
		const zoomed = renderHook(() => useHeaderTextDelta()).result.current.wordmark;

		expect(zoomed).toBeGreaterThan(unzoomed);
	});

	it('never goes negative for a narrower face', () => {
		// A negative correction would pull a threshold below the chrome it also
		// has to cover, showing a label that does not fit.
		stubCanvas(() => {
			const ctx = { font: '' } as { font: string; measureText: (text: string) => TextMetrics };
			// Narrower for everything EXCEPT the baseline mono font.
			ctx.measureText = (text: string) => {
				const leading = /px\s+(.+)$/.exec(ctx.font)?.[1]?.split(',')[0] ?? '';
				return {
					width: /Mono|monospace/i.test(leading) ? text.length * 20 : text.length * 5,
				} as TextMetrics;
			};
			return ctx;
		});
		useSettingsStore.setState({ fontFamily: 'Tiny Face' });

		const { result } = renderHook(() => useHeaderTextDelta());
		expect(result.current.wordmark).toBe(0);
		expect(result.current.liveLabel).toBe(0);
	});

	it('reports no correction when no canvas is available', () => {
		// jsdom and headless builds keep the original constants.
		stubCanvas(() => null);
		useSettingsStore.setState({ fontFamily: 'Inter' });

		const { result } = renderHook(() => useHeaderTextDelta());
		expect(result.current.wordmark).toBe(0);
		expect(result.current.liveLabel).toBe(0);
	});
});

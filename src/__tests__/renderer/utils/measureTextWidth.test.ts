import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	measureTextWidth,
	clearTextMeasurementCache,
} from '../../../renderer/utils/measureTextWidth';

/**
 * jsdom has no canvas text engine, so `getContext('2d')` returns null unless a
 * test installs one. Both branches matter: the null path is what every headless
 * build takes, and it must degrade to 0 rather than throw.
 */
function installCanvasStub(widthPerChar = 10) {
	const measureText = vi.fn((text: string) => ({ width: text.length * widthPerChar }));
	const getContext = vi.fn(
		() => ({ font: '', measureText }) as unknown as CanvasRenderingContext2D
	);
	vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
		if (tag === 'canvas') return { getContext } as unknown as HTMLCanvasElement;
		return document.createElement.wrappedMethod?.(tag);
	}) as typeof document.createElement);
	return { measureText, getContext };
}

beforeEach(() => {
	clearTextMeasurementCache();
});

afterEach(() => {
	vi.restoreAllMocks();
	clearTextMeasurementCache();
});

describe('measureTextWidth', () => {
	it('returns 0 for empty text without touching the canvas', () => {
		const { getContext } = installCanvasStub();
		expect(measureTextWidth('', 'bold 14px Inter')).toBe(0);
		expect(getContext).not.toHaveBeenCalled();
	});

	it('measures a string in the given font', () => {
		installCanvasStub(10);
		expect(measureTextWidth('MAESTRO', 'bold 14px Inter')).toBe(70);
	});

	it('adds letter-spacing, which measureText ignores', () => {
		// tracking-widest is real width on screen; leaving it out would
		// under-reserve for exactly the wordmark this exists to measure.
		installCanvasStub(10);
		expect(measureTextWidth('MAESTRO', 'bold 14px Inter', 2)).toBe(70 + 7 * 2);
	});

	it('caches by font, so a different font re-measures', () => {
		const { measureText } = installCanvasStub(10);

		measureTextWidth('MAESTRO', 'bold 14px Inter');
		measureTextWidth('MAESTRO', 'bold 14px Inter');
		expect(measureText).toHaveBeenCalledTimes(1);

		measureTextWidth('MAESTRO', 'bold 14px Roboto Mono');
		expect(measureText).toHaveBeenCalledTimes(2);
	});

	it('caches by letter-spacing too', () => {
		const { measureText } = installCanvasStub(10);

		measureTextWidth('MAESTRO', 'bold 14px Inter', 0);
		measureTextWidth('MAESTRO', 'bold 14px Inter', 2);
		expect(measureText).toHaveBeenCalledTimes(2);
	});

	it('degrades to 0 when no canvas is available', () => {
		// The headless path. Callers read 0 as "no correction" and keep their
		// uncorrected constants, rather than collapsing a layout to nothing.
		vi.spyOn(document, 'createElement').mockImplementation((() => ({
			getContext: () => null,
		})) as unknown as typeof document.createElement);
		expect(measureTextWidth('MAESTRO', 'bold 14px Inter')).toBe(0);
	});

	it('only tries to acquire a context once', () => {
		const getContext = vi.fn(() => null);
		vi.spyOn(document, 'createElement').mockImplementation((() => ({
			getContext,
		})) as unknown as typeof document.createElement);

		measureTextWidth('a', 'bold 14px Inter');
		measureTextWidth('b', 'bold 14px Inter');
		expect(getContext).toHaveBeenCalledTimes(1);
	});

	it('survives a canvas constructor that throws', () => {
		vi.spyOn(document, 'createElement').mockImplementation(() => {
			throw new Error('no canvas');
		});
		expect(() => measureTextWidth('MAESTRO', 'bold 14px Inter')).not.toThrow();
		expect(measureTextWidth('MAESTRO', 'bold 14px Inter')).toBe(0);
	});
});

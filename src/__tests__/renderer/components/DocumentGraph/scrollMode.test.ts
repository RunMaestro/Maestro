/**
 * Tests for the Document Graph's scroll wheel mode (scrollMode.ts).
 *
 * The module is small, but three surfaces read from it - the canvas wheel
 * handler, the toolbar pill, and the Help panel toggle - so the labels and the
 * boolean round-trip are worth pinning: a label that disagrees with what the
 * wheel actually does is worse than no label, because the user reads it to
 * decide whether to reach for Shift.
 */

import { describe, it, expect } from 'vitest';
import {
	DEFAULT_SCROLL_MODE,
	SCROLL_MODE_LABELS,
	SCROLL_MODE_STORAGE_KEY,
	nextScrollMode,
	scrollModeFromPans,
	scrollModePans,
	type GraphScrollMode,
} from '../../../../renderer/components/DocumentGraph/scrollMode';

describe('scrollMode', () => {
	describe('DEFAULT_SCROLL_MODE', () => {
		it('keeps the graph zooming on scroll, as it always has', () => {
			// Changing the default would silently repurpose the wheel for every
			// existing user on their next launch.
			expect(DEFAULT_SCROLL_MODE).toBe('zoom');
		});
	});

	describe('nextScrollMode', () => {
		it('swaps the two modes', () => {
			expect(nextScrollMode('zoom')).toBe('pan');
			expect(nextScrollMode('pan')).toBe('zoom');
		});

		it('returns to the starting mode after two presses', () => {
			expect(nextScrollMode(nextScrollMode('zoom'))).toBe('zoom');
			expect(nextScrollMode(nextScrollMode('pan'))).toBe('pan');
		});
	});

	describe('persistence round-trip', () => {
		it('survives the boolean the storage layer keeps', () => {
			const modes: GraphScrollMode[] = ['zoom', 'pan'];
			modes.forEach((mode) => {
				expect(scrollModeFromPans(scrollModePans(mode))).toBe(mode);
			});
		});

		it('reads pan as the panning mode', () => {
			expect(scrollModePans('pan')).toBe(true);
			expect(scrollModePans('zoom')).toBe(false);
			expect(scrollModeFromPans(true)).toBe('pan');
			expect(scrollModeFromPans(false)).toBe('zoom');
		});

		it('namespaces its storage key to the graph', () => {
			expect(SCROLL_MODE_STORAGE_KEY.startsWith('documentGraph.')).toBe(true);
		});
	});

	describe('SCROLL_MODE_LABELS', () => {
		it('describes every mode', () => {
			(['zoom', 'pan'] as GraphScrollMode[]).forEach((mode) => {
				expect(SCROLL_MODE_LABELS[mode].name).toBeTruthy();
				expect(SCROLL_MODE_LABELS[mode].wheelAction).toBeTruthy();
				expect(SCROLL_MODE_LABELS[mode].modifierAction).toBeTruthy();
			});
		});

		it('makes the modifier reach the other mode', () => {
			// This is the whole contract of the feature: whichever mode is on,
			// Shift still gets you the other action, so the mode is a default
			// rather than a lock. A label pair that broke this would be telling
			// the user an action is unavailable when it is one key away.
			expect(SCROLL_MODE_LABELS.zoom.modifierAction).toBe(SCROLL_MODE_LABELS.pan.wheelAction);
			expect(SCROLL_MODE_LABELS.pan.modifierAction).toBe(SCROLL_MODE_LABELS.zoom.wheelAction);
		});

		it('never describes the wheel and the modifier as doing the same thing', () => {
			(['zoom', 'pan'] as GraphScrollMode[]).forEach((mode) => {
				expect(SCROLL_MODE_LABELS[mode].wheelAction).not.toBe(
					SCROLL_MODE_LABELS[mode].modifierAction
				);
			});
		});
	});

	describe('wheel binding', () => {
		/**
		 * The rule the canvas applies: Shift INVERTS the mode rather than naming
		 * a fixed action. Mirrored here because it is one expression in
		 * `MindMap`'s wheel handler and it is easy to "simplify" into
		 * `mode === 'pan' || e.shiftKey`, which would strand a Pan-mode user
		 * with no way to zoom at all.
		 */
		const panning = (mode: GraphScrollMode, shiftKey: boolean) => (mode === 'pan') !== shiftKey;

		it('pans on a bare wheel only in pan mode', () => {
			expect(panning('zoom', false)).toBe(false);
			expect(panning('pan', false)).toBe(true);
		});

		it('gives the other action to Shift in both modes', () => {
			expect(panning('zoom', true)).toBe(true);
			expect(panning('pan', true)).toBe(false);
		});

		it('leaves zoom reachable from every mode', () => {
			const zoomReachable = (mode: GraphScrollMode) =>
				!panning(mode, false) || !panning(mode, true);
			expect(zoomReachable('zoom')).toBe(true);
			expect(zoomReachable('pan')).toBe(true);
		});
	});
});

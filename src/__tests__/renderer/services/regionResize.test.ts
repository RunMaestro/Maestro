/**
 * Tests for keyboard-step region resize.
 *
 * `growRegion` / `shrinkRegion` ship unassigned, so nothing in default mode
 * exercises them until a user binds a chord or switches to Vim mode. Four
 * parts of the contract are the ones that would otherwise break in silence:
 *
 *   - The step CLAMPS at both bounds, and it clamps by going through
 *     settingsStore's setters rather than by doing its own arithmetic. A second
 *     clamp here would drift the first time a bound moved.
 *   - It writes through the SAME setter the drag handle commits to, which is
 *     what keeps a keyboard resize and a mouse resize landing on one width and
 *     persisting under one settings key.
 *   - The Main Window has no width of its own, so a press there moves the Right
 *     Bar's edge INVERTED: "grow" has to grow the region that has focus.
 *   - A bar that is not on screen is not resizable, and a resize key must not
 *     reveal it. This is the deliberate difference from `focusRegion`.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
	REGION_RESIZE_STEP_PX,
	growFocusedRegion,
	resizeFocusedRegion,
	shrinkFocusedRegion,
} from '../../../renderer/services/regionResize';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { useUIStore } from '../../../renderer/stores/uiStore';
import {
	RIGHT_PANEL_MAX_WIDTH,
	RIGHT_PANEL_MIN_WIDTH,
} from '../../../renderer/constants/rightPanel';
import { resetStores } from '../../helpers/resetStores';

/** The bounds `setLeftSidebarWidth` clamps to, restated so a drift shows up here. */
const LEFT_MIN = 256;
const LEFT_MAX = 600;

/** Put focus in a region without going through the focus service. */
function focus(area: 'sidebar' | 'main' | 'right'): void {
	useUIStore.getState().setActiveFocus(area);
}

function widths(): { left: number; right: number } {
	const s = useSettingsStore.getState();
	return { left: s.leftSidebarWidth, right: s.rightPanelWidth };
}

describe('regionResize', () => {
	beforeEach(() => {
		resetStores(useSettingsStore, useUIStore);
		vi.mocked(window.maestro.settings.set).mockClear();
	});

	it('steps by a single positive amount shared by both bars', () => {
		// One constant for both bars: a press should travel the same distance
		// wherever focus is. Positive because the two wrappers get their
		// direction by negating it, not by holding separate numbers.
		expect(REGION_RESIZE_STEP_PX).toBeGreaterThan(0);
	});

	describe('the Left Bar', () => {
		beforeEach(() => {
			focus('sidebar');
			useSettingsStore.getState().setLeftSidebarWidth(400);
			vi.mocked(window.maestro.settings.set).mockClear();
		});

		it('grows and shrinks by exactly one step', () => {
			expect(growFocusedRegion()).toBe(true);
			expect(widths().left).toBe(400 + REGION_RESIZE_STEP_PX);

			expect(shrinkFocusedRegion()).toBe(true);
			expect(widths().left).toBe(400);
		});

		it('writes through the setter the drag handle uses, under its settings key', () => {
			// The drag handle commits with `setLeftSidebarWidth` and persists
			// 'leftSidebarWidth'. Seeing that key written is how we know this went
			// through the setter rather than a raw `set({ leftSidebarWidth })`,
			// which would skip both the clamp and the persistence.
			growFocusedRegion();
			expect(window.maestro.settings.set).toHaveBeenCalledWith(
				'leftSidebarWidth',
				400 + REGION_RESIZE_STEP_PX
			);
		});

		it('clamps at the maximum instead of running past it', () => {
			useSettingsStore.getState().setLeftSidebarWidth(LEFT_MAX);
			growFocusedRegion();
			expect(widths().left).toBe(LEFT_MAX);
		});

		it('clamps at the minimum instead of running past it', () => {
			useSettingsStore.getState().setLeftSidebarWidth(LEFT_MIN);
			shrinkFocusedRegion();
			expect(widths().left).toBe(LEFT_MIN);
		});

		it('leaves the Right Bar alone', () => {
			const before = widths().right;
			growFocusedRegion();
			expect(widths().right).toBe(before);
		});

		it('is a no-op while collapsed to the status-dot strip', () => {
			// A collapsed Left Bar renders a fixed 64px strip and ignores the
			// stored width, so a resize would write a number nothing draws.
			useUIStore.getState().setLeftSidebarOpen(false);
			const before = widths().left;
			expect(growFocusedRegion()).toBe(false);
			expect(widths().left).toBe(before);
			expect(window.maestro.settings.set).not.toHaveBeenCalled();
		});

		it('is a no-op while hidden, and does not reveal it', () => {
			useUIStore.getState().setLeftSidebarHidden(true);
			const before = widths().left;
			expect(shrinkFocusedRegion()).toBe(false);
			expect(widths().left).toBe(before);
			// The difference from `focusRegion`, which DOES reveal: a key about a
			// width must not reopen chrome the user deliberately closed.
			expect(useUIStore.getState().leftSidebarHidden).toBe(true);
		});
	});

	describe('the Right Bar', () => {
		beforeEach(() => {
			focus('right');
			useSettingsStore.getState().setRightPanelWidth(500);
			vi.mocked(window.maestro.settings.set).mockClear();
		});

		it('grows and shrinks by exactly one step', () => {
			expect(growFocusedRegion()).toBe(true);
			expect(widths().right).toBe(500 + REGION_RESIZE_STEP_PX);

			expect(shrinkFocusedRegion()).toBe(true);
			expect(widths().right).toBe(500);
		});

		it('writes through the setter the drag handle uses, under its settings key', () => {
			growFocusedRegion();
			expect(window.maestro.settings.set).toHaveBeenCalledWith(
				'rightPanelWidth',
				500 + REGION_RESIZE_STEP_PX
			);
		});

		it('clamps at both bounds instead of running past them', () => {
			useSettingsStore.getState().setRightPanelWidth(RIGHT_PANEL_MAX_WIDTH);
			growFocusedRegion();
			expect(widths().right).toBe(RIGHT_PANEL_MAX_WIDTH);

			useSettingsStore.getState().setRightPanelWidth(RIGHT_PANEL_MIN_WIDTH);
			shrinkFocusedRegion();
			expect(widths().right).toBe(RIGHT_PANEL_MIN_WIDTH);
		});

		it('leaves the Left Bar alone', () => {
			const before = widths().left;
			growFocusedRegion();
			expect(widths().left).toBe(before);
		});

		it('is a no-op while closed, and does not reopen it', () => {
			useUIStore.getState().setRightPanelOpen(false);
			const before = widths().right;
			expect(growFocusedRegion()).toBe(false);
			expect(widths().right).toBe(before);
			expect(useUIStore.getState().rightPanelOpen).toBe(false);
			expect(window.maestro.settings.set).not.toHaveBeenCalled();
		});
	});

	describe('the Main Window', () => {
		beforeEach(() => {
			focus('main');
			useSettingsStore.getState().setRightPanelWidth(500);
			vi.mocked(window.maestro.settings.set).mockClear();
		});

		it('grows itself by taking a step back from the Right Bar', () => {
			// The Main Window is the flex child with no width of its own, so the
			// only way to grow it is to narrow the bar beside it. The action is
			// named for the FOCUSED region, so Grow Region has to make the thing
			// the user is looking at bigger.
			expect(growFocusedRegion()).toBe(true);
			expect(widths().right).toBe(500 - REGION_RESIZE_STEP_PX);
		});

		it('shrinks itself by giving a step back to the Right Bar', () => {
			expect(shrinkFocusedRegion()).toBe(true);
			expect(widths().right).toBe(500 + REGION_RESIZE_STEP_PX);
		});

		it('leaves the Left Bar alone', () => {
			const before = widths().left;
			growFocusedRegion();
			shrinkFocusedRegion();
			expect(widths().left).toBe(before);
		});

		it('clamps at the Right Bar bounds, which are reached in the other order', () => {
			// Growing the Main Window drives the Right Bar toward its MINIMUM.
			useSettingsStore.getState().setRightPanelWidth(RIGHT_PANEL_MIN_WIDTH);
			growFocusedRegion();
			expect(widths().right).toBe(RIGHT_PANEL_MIN_WIDTH);

			useSettingsStore.getState().setRightPanelWidth(RIGHT_PANEL_MAX_WIDTH);
			shrinkFocusedRegion();
			expect(widths().right).toBe(RIGHT_PANEL_MAX_WIDTH);
		});

		it('is a no-op while the Right Bar is closed', () => {
			useUIStore.getState().setRightPanelOpen(false);
			const before = widths();
			expect(growFocusedRegion()).toBe(false);
			expect(widths()).toEqual(before);
			expect(useUIStore.getState().rightPanelOpen).toBe(false);
		});
	});

	it('takes a signed pixel delta, not a direction flag', () => {
		// The wrappers are the only callers that know the step; the function
		// itself moves by whatever it is handed, which is what lets a future
		// coarse step (a modifier, say) reuse it without a second code path.
		focus('sidebar');
		useSettingsStore.getState().setLeftSidebarWidth(300);
		resizeFocusedRegion(100);
		expect(widths().left).toBe(400);
		resizeFocusedRegion(-50);
		expect(widths().left).toBe(350);
	});
});

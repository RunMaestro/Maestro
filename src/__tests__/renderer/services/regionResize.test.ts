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
import { act, renderHook } from '@testing-library/react';
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react';
import {
	REGION_RESIZE_STEP_PX,
	growFocusedRegion,
	resizeFocusedRegion,
	shrinkFocusedRegion,
} from '../../../renderer/services/regionResize';
import { useResizablePanel } from '../../../renderer/hooks/ui/useResizablePanel';
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

/**
 * Drive one mouse resize through `useResizablePanel`, the hook both drag
 * handles are built on, from `startX` to `endX`.
 *
 * The options are the ones the real call sites pass (SessionList for the Left
 * Bar, RightPanel for the Right Bar), including the setter - that is the point
 * of driving the hook rather than a mock: it is what lets a test compare where
 * a drag lands with where a keyboard press lands.
 *
 * jsdom has no PointerEvent constructor; MouseEvent carries clientX and
 * matches the 'pointermove' / 'pointerup' listeners by their type string, the
 * same substitution useResizablePanel.test.ts makes.
 */
function dragHandleTo(opts: {
	side: 'left' | 'right';
	width: number;
	minWidth: number;
	maxWidth: number;
	settingsKey: string;
	setWidth: (w: number) => void;
	startX: number;
	endX: number;
}): void {
	const panel = document.createElement('div');
	const handle = document.createElement('div');
	document.body.append(panel, handle);
	const externalRef = { current: panel } as RefObject<HTMLDivElement>;

	const { result, unmount } = renderHook(() =>
		useResizablePanel({
			width: opts.width,
			minWidth: opts.minWidth,
			maxWidth: opts.maxWidth,
			settingsKey: opts.settingsKey,
			setWidth: opts.setWidth,
			side: opts.side,
			externalRef,
		})
	);

	act(() => {
		result.current.onResizeStart({
			preventDefault: () => {},
			clientX: opts.startX,
			pointerId: 1,
			currentTarget: handle,
		} as unknown as ReactPointerEvent);
	});
	act(() => {
		handle.dispatchEvent(new MouseEvent('pointermove', { clientX: opts.endX, bubbles: true }));
	});
	act(() => {
		handle.dispatchEvent(new MouseEvent('pointerup', { clientX: opts.endX, bubbles: true }));
	});

	unmount();
	panel.remove();
	handle.remove();
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

	/**
	 * The header's second claim - a mouse resize and a keyboard resize cannot
	 * land on two different widths - holds only while the SETTER is the single
	 * clamp between them. The assertions above can see the settings key this
	 * service writes, but not that the drag handle writes it too, so they would
	 * stay green if the handle were rewired to a raw `set({ leftSidebarWidth })`
	 * or given a clamp of its own. These drive `useResizablePanel` with the
	 * arguments its real call sites pass (SessionList for the Left Bar,
	 * RightPanel for the Right Bar) and compare where a drag stops with where a
	 * press stops.
	 */
	describe('one source of truth with the drag handle', () => {
		it('stops a dragged Right Bar and a pressed Right Bar at the same ceiling', () => {
			focus('right');
			useSettingsStore.getState().setRightPanelWidth(500);

			// Drag well past the maximum. 'right' inverts the delta, so moving the
			// pointer LEFT widens the panel.
			dragHandleTo({
				side: 'right',
				width: 500,
				minWidth: RIGHT_PANEL_MIN_WIDTH,
				maxWidth: RIGHT_PANEL_MAX_WIDTH,
				settingsKey: 'rightPanelWidth',
				setWidth: useSettingsStore.getState().setRightPanelWidth,
				startX: 1200,
				endX: 0,
			});
			expect(widths().right).toBe(RIGHT_PANEL_MAX_WIDTH);

			// And the keyboard agrees that is the end of the road.
			expect(growFocusedRegion()).toBe(true);
			expect(widths().right).toBe(RIGHT_PANEL_MAX_WIDTH);
		});

		it('persists a keyboard step under the key the drag handle writes', () => {
			focus('right');
			useSettingsStore.getState().setRightPanelWidth(500);
			vi.mocked(window.maestro.settings.set).mockClear();

			dragHandleTo({
				side: 'right',
				width: 500,
				minWidth: RIGHT_PANEL_MIN_WIDTH,
				maxWidth: RIGHT_PANEL_MAX_WIDTH,
				settingsKey: 'rightPanelWidth',
				setWidth: useSettingsStore.getState().setRightPanelWidth,
				startX: 500,
				endX: 460,
			});
			expect(window.maestro.settings.set).toHaveBeenCalledWith('rightPanelWidth', 540);

			vi.mocked(window.maestro.settings.set).mockClear();
			expect(shrinkFocusedRegion()).toBe(true);
			expect(window.maestro.settings.set).toHaveBeenCalledWith(
				'rightPanelWidth',
				540 - REGION_RESIZE_STEP_PX
			);
		});

		it("leaves the setter authoritative over the handle's own minimum", () => {
			// SessionList passes `minWidth: 280` while `setLeftSidebarWidth` clamps
			// to 256, so the handle's floor is cosmetic and the setter's is the real
			// one. A press that starts at the handle's floor has to be able to keep
			// going, which is exactly why this service reads no bound of its own: a
			// copy of 280 here would stop the keyboard 24px short of the width the
			// store will happily hold.
			focus('sidebar');
			useSettingsStore.getState().setLeftSidebarWidth(400);

			dragHandleTo({
				side: 'left',
				width: 400,
				minWidth: 280,
				maxWidth: LEFT_MAX,
				settingsKey: 'leftSidebarWidth',
				setWidth: useSettingsStore.getState().setLeftSidebarWidth,
				startX: 400,
				endX: 0,
			});
			expect(widths().left).toBe(280);

			expect(shrinkFocusedRegion()).toBe(true);
			expect(widths().left).toBe(LEFT_MIN);
			// And the setter's floor does hold.
			expect(shrinkFocusedRegion()).toBe(true);
			expect(widths().left).toBe(LEFT_MIN);
		});
	});
});

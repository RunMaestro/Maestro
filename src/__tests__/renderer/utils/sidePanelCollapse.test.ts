/**
 * Tests for src/renderer/utils/sidePanelCollapse.ts
 *
 * What `restore` gives back is the whole feature: it must reopen only the bars
 * this call closed, and never fight the user over a bar they touched while it
 * was folded. These run against the real uiStore.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collapseSidePanels } from '../../../renderer/utils/sidePanelCollapse';
import { useUIStore } from '../../../renderer/stores/uiStore';
import { resetStore } from '../../helpers';

const WIDE_WINDOW = 1440;
const NARROW_WINDOW = 600;

function setWindowWidth(width: number) {
	Object.defineProperty(window, 'innerWidth', { value: width, configurable: true, writable: true });
}

function bars() {
	const { leftSidebarOpen, leftSidebarHidden, rightPanelOpen } = useUIStore.getState();
	return { left: leftSidebarOpen, leftHidden: leftSidebarHidden, right: rightPanelOpen };
}

describe('collapseSidePanels', () => {
	const originalWidth = window.innerWidth;

	beforeEach(() => {
		resetStore(useUIStore);
		setWindowWidth(WIDE_WINDOW);
	});

	afterEach(() => {
		setWindowWidth(originalWidth);
	});

	it('closes both open bars and reopens both on restore', () => {
		const restore = collapseSidePanels();

		expect(bars()).toMatchObject({ left: false, right: false });

		restore();

		expect(bars()).toMatchObject({ left: true, right: true });
	});

	it('only reopens the bar it closed when the other was already shut', () => {
		useUIStore.getState().setRightPanelOpen(false);

		const restore = collapseSidePanels();
		expect(bars()).toMatchObject({ left: false, right: false });

		restore();

		expect(bars()).toMatchObject({ left: true, right: false });
	});

	it('never opens a bar that was shut when it started', () => {
		useUIStore.getState().setLeftSidebarOpen(false);
		useUIStore.getState().setRightPanelOpen(false);

		const restore = collapseSidePanels();
		restore();

		expect(bars()).toMatchObject({ left: false, right: false });
	});

	it('leaves a bar the user reopened alone, and still restores the other', () => {
		const restore = collapseSidePanels();

		useUIStore.getState().setRightPanelOpen(true);
		restore();

		expect(bars()).toMatchObject({ left: true, right: true });
	});

	it('does not reopen a bar the user opened and then closed again', () => {
		const restore = collapseSidePanels();

		useUIStore.getState().setLeftSidebarOpen(true);
		useUIStore.getState().setLeftSidebarOpen(false);
		restore();

		// Closed is where the user left it; the Right Bar was never touched.
		expect(bars()).toMatchObject({ left: false, right: true });
	});

	it('does not reopen a Left Bar the user cycled on to hidden', () => {
		const restore = collapseSidePanels();

		// The Left Bar button walks full, collapsed strip, hidden.
		useUIStore.getState().cycleLeftSidebar();
		expect(bars()).toMatchObject({ left: false, leftHidden: true });
		restore();

		expect(bars()).toMatchObject({ left: false, leftHidden: true, right: true });
	});

	it('keeps its claim through store writes that are not the user touching a bar', () => {
		const restore = collapseSidePanels();

		useUIStore.getState().setActiveFocus('right');
		useUIStore.getState().setActiveRightTab('history');
		// The per-window state hydration writes the value a bar already has.
		useUIStore.getState().setLeftSidebarOpen(false);
		useUIStore.getState().setRightPanelOpen(false);
		restore();

		expect(bars()).toMatchObject({ left: true, right: true });
	});

	it('leaves a collapsed strip and a hidden Left Bar as they were', () => {
		// Collapsed strip: not open, not hidden. Nothing for Design Mode to fold.
		useUIStore.getState().setLeftSidebarOpen(false);
		const stripRestore = collapseSidePanels();
		stripRestore();
		expect(bars()).toMatchObject({ left: false, leftHidden: false, right: true });

		// Hidden: no panel at all.
		useUIStore.getState().setRightPanelOpen(true);
		useUIStore.getState().setLeftSidebarHidden(true);
		const hiddenRestore = collapseSidePanels();
		hiddenRestore();
		expect(bars()).toMatchObject({ left: false, leftHidden: true, right: true });
	});

	it('does nothing on a second restore', () => {
		const restore = collapseSidePanels();
		restore();
		expect(bars()).toMatchObject({ left: true, right: true });

		// The user closes both again; a stray second restore must not undo that.
		useUIStore.getState().setLeftSidebarOpen(false);
		useUIStore.getState().setRightPanelOpen(false);
		restore();

		expect(bars()).toMatchObject({ left: false, right: false });
	});

	it('opens nothing on restore when the window narrowed meanwhile', () => {
		const restore = collapseSidePanels();

		// Below the md breakpoint the bars are drawers the app keeps shut.
		setWindowWidth(NARROW_WINDOW);
		restore();

		expect(bars()).toMatchObject({ left: false, right: false });
	});

	it('nests: an inner collapse restores to the outer one, not to open', () => {
		const outer = collapseSidePanels();
		const inner = collapseSidePanels();

		// Nothing was open for the inner call to close, so it owns nothing.
		inner();
		expect(bars()).toMatchObject({ left: false, right: false });

		outer();
		expect(bars()).toMatchObject({ left: true, right: true });
	});
});

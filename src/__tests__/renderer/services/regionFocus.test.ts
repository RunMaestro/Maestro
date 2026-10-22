/**
 * Tests for region focus navigation.
 *
 * These actions ship unassigned, so nothing in default mode exercises them
 * until a user binds a chord or switches to Vim mode. That makes the contract
 * here the only thing holding them honest, and three parts of it are the ones
 * that would break silently:
 *
 *   - LEFT/RIGHT clamps instead of wrapping. A wrap looks identical in a
 *     screenshot and throws the user across the window in use.
 *   - Focusing a hidden region reveals it FIRST. A hidden Left Bar is
 *     `display: none` and cannot take focus, so an action that moved
 *     `activeFocus` without revealing would leave the arrow keys pointed at a
 *     region that is not on screen.
 *   - UP/DOWN hits the documented target per region: transcript / composer in
 *     the Main Window, and the list selection in either bar - which the bars
 *     already own on a bare arrow key.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	REGION_ORDER,
	LEFT_BAR_SELECTOR,
	RIGHT_BAR_SELECTOR,
	TRANSCRIPT_SELECTOR,
	cancelRegionFocus,
	focusRegion,
	focusRegionDirection,
	focusRegionVertical,
	focusedRegion,
} from '../../../renderer/services/regionFocus';
import { useUIStore } from '../../../renderer/stores/uiStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { createMockSession } from '../../helpers';
import { resetStores } from '../../helpers/resetStores';

/**
 * Stand-ins for the three regions' real elements. Each carries the same
 * attribute / class and `tabIndex` the app gives it, because that is what the
 * service queries and what lets the element hold focus.
 */
function mountRegions(): {
	leftBar: HTMLElement;
	rightBar: HTMLElement;
	transcript: HTMLElement;
} {
	const leftBar = document.createElement('div');
	leftBar.setAttribute('data-panel', 'left');
	leftBar.tabIndex = 0;

	const rightBar = document.createElement('div');
	rightBar.setAttribute('data-panel', 'right');
	rightBar.tabIndex = 0;

	const transcript = document.createElement('div');
	transcript.className = 'terminal-output';
	transcript.tabIndex = 0;

	document.body.append(leftBar, transcript, rightBar);
	return { leftBar, rightBar, transcript };
}

describe('regionFocus', () => {
	beforeEach(() => {
		resetStores(useUIStore, useSessionStore);
		document.body.innerHTML = '';
	});

	afterEach(() => {
		cancelRegionFocus();
		vi.useRealTimers();
	});

	it('orders the regions left to right', () => {
		// The order is the contract `focusRegionDirection` walks, not an
		// implementation detail - a reordering here silently reverses the keys.
		expect(REGION_ORDER).toEqual(['leftBar', 'mainWindow', 'rightBar']);
	});

	describe('focusedRegion', () => {
		it('reads the region from uiStore activeFocus', () => {
			useUIStore.getState().setActiveFocus('sidebar');
			expect(focusedRegion()).toBe('leftBar');
			useUIStore.getState().setActiveFocus('main');
			expect(focusedRegion()).toBe('mainWindow');
			useUIStore.getState().setActiveFocus('right');
			expect(focusedRegion()).toBe('rightBar');
		});
	});

	describe('focusRegionDirection', () => {
		it('walks one region at a time', () => {
			mountRegions();
			useUIStore.getState().setActiveFocus('sidebar');

			focusRegionDirection('right');
			expect(useUIStore.getState().activeFocus).toBe('main');

			focusRegionDirection('right');
			expect(useUIStore.getState().activeFocus).toBe('right');
		});

		it('clamps at the right end instead of wrapping', () => {
			mountRegions();
			useUIStore.getState().setActiveFocus('right');

			focusRegionDirection('right');

			// Not 'sidebar': the Right Bar is the rightmost region, so there is
			// nothing further right and staying put is the honest answer.
			expect(useUIStore.getState().activeFocus).toBe('right');
		});

		it('clamps at the left end instead of wrapping', () => {
			mountRegions();
			useUIStore.getState().setActiveFocus('sidebar');

			focusRegionDirection('left');

			expect(useUIStore.getState().activeFocus).toBe('sidebar');
		});

		it('leaves a clamped region untouched rather than re-revealing it', () => {
			mountRegions();
			useUIStore.setState({ activeFocus: 'right', rightPanelOpen: false });

			focusRegionDirection('right');

			// A clamp is a no-op end to end: it must not reveal the bar the user
			// deliberately closed just because they pressed into the window edge.
			expect(useUIStore.getState().rightPanelOpen).toBe(false);
		});
	});

	describe('focusRegion', () => {
		it('moves real DOM focus into the Left Bar', () => {
			const { leftBar } = mountRegions();

			focusRegion('leftBar');

			expect(useUIStore.getState().activeFocus).toBe('sidebar');
			expect(document.activeElement).toBe(leftBar);
		});

		it('moves real DOM focus into the Right Bar', () => {
			const { rightBar } = mountRegions();

			focusRegion('rightBar');

			expect(useUIStore.getState().activeFocus).toBe('right');
			expect(document.activeElement).toBe(rightBar);
		});

		it('reveals a collapsed Left Bar before focusing it', () => {
			const { leftBar } = mountRegions();
			useUIStore.setState({ leftSidebarOpen: false, leftSidebarHidden: false });

			focusRegion('leftBar');

			expect(useUIStore.getState().leftSidebarOpen).toBe(true);
			expect(document.activeElement).toBe(leftBar);
		});

		it('reveals a hidden Left Bar before focusing it', () => {
			const { leftBar } = mountRegions();
			useUIStore.setState({ leftSidebarOpen: false, leftSidebarHidden: true });

			focusRegion('leftBar');

			// Both halves of the tri-state: hidden drops the element from layout
			// entirely, so un-hiding alone would focus a 64px dot strip.
			expect(useUIStore.getState().leftSidebarHidden).toBe(false);
			expect(useUIStore.getState().leftSidebarOpen).toBe(true);
			expect(document.activeElement).toBe(leftBar);
		});

		it('reveals a closed Right Bar before focusing it', () => {
			const { rightBar } = mountRegions();
			useUIStore.setState({ rightPanelOpen: false });

			focusRegion('rightBar');

			expect(useUIStore.getState().rightPanelOpen).toBe(true);
			expect(document.activeElement).toBe(rightBar);
		});

		it("leaves an already-open bar's visibility alone", () => {
			mountRegions();
			useUIStore.setState({ leftSidebarOpen: true, leftSidebarHidden: false });

			focusRegion('leftBar');

			expect(useUIStore.getState().leftSidebarOpen).toBe(true);
			expect(useUIStore.getState().leftSidebarHidden).toBe(false);
		});

		it('keeps re-trying while the revealed element still refuses focus', () => {
			vi.useFakeTimers();
			useUIStore.setState({ leftSidebarHidden: true });

			// The element does not exist yet, standing in for a region React has
			// not committed the reveal for. The first attempt must fail.
			focusRegion('leftBar');
			expect(document.querySelector(LEFT_BAR_SELECTOR)).toBeNull();

			const leftBar = document.createElement('div');
			leftBar.setAttribute('data-panel', 'left');
			leftBar.tabIndex = 0;
			document.body.appendChild(leftBar);

			vi.advanceTimersByTime(64);

			expect(document.activeElement).toBe(leftBar);
		});

		it('asks the Main Window for its caret through the focusRequest slot', () => {
			mountRegions();
			const session = createMockSession({
				id: 'agent-1',
				aiTabs: [{ id: 'tab-1' } as never],
				activeTabId: 'tab-1',
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'agent-1' });

			focusRegion('mainWindow');

			expect(useUIStore.getState().activeFocus).toBe('main');
			// The composer is a ref three components down and the Main Window may
			// be showing a terminal or a browser instead, so the caret is routed
			// through the one request slot MainPanelContent consumes.
			expect(useUIStore.getState().focusRequest).toEqual({ tab: { type: 'ai', id: 'tab-1' } });
		});

		it('still moves activeFocus when the Main Window has no input to focus', () => {
			mountRegions();
			useSessionStore.setState({ sessions: [], activeSessionId: null });

			focusRegion('mainWindow');

			// No agent open: the arrow keys and Cmd+F still belong to the Main
			// Window, there is simply nowhere to put a caret.
			expect(useUIStore.getState().activeFocus).toBe('main');
			expect(useUIStore.getState().focusRequest).toBeNull();
		});
	});

	describe('focusRegionVertical', () => {
		it('focuses the transcript on up in the Main Window', () => {
			const { transcript } = mountRegions();
			useUIStore.getState().setActiveFocus('main');

			focusRegionVertical('up');

			expect(document.activeElement).toBe(transcript);
		});

		it('focuses the composer on down in the Main Window', () => {
			mountRegions();
			const session = createMockSession({
				id: 'agent-1',
				aiTabs: [{ id: 'tab-1' } as never],
				activeTabId: 'tab-1',
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'agent-1' });
			useUIStore.getState().setActiveFocus('main');

			focusRegionVertical('down');

			expect(useUIStore.getState().focusRequest).toEqual({ tab: { type: 'ai', id: 'tab-1' } });
		});

		it('sends a bare ArrowDown at the Left Bar so its own list navigation moves', () => {
			const { leftBar } = mountRegions();
			useUIStore.getState().setActiveFocus('sidebar');
			const seen: KeyboardEvent[] = [];
			const listener = (e: Event) => seen.push(e as KeyboardEvent);
			window.addEventListener('keydown', listener);

			try {
				focusRegionVertical('down');
			} finally {
				window.removeEventListener('keydown', listener);
			}

			// Bare, bubbling, and targeted at the panel: `handleSidebarNavigation`
			// is a window listener that ignores modified arrows and text-field
			// targets, so all three matter.
			expect(seen).toHaveLength(1);
			expect(seen[0].key).toBe('ArrowDown');
			expect(seen[0].metaKey).toBe(false);
			expect(seen[0].ctrlKey).toBe(false);
			expect(seen[0].altKey).toBe(false);
			expect(seen[0].target).toBe(leftBar);
		});

		it('sends a bare ArrowUp at the Right Bar so its own list navigation moves', () => {
			const { rightBar } = mountRegions();
			useUIStore.getState().setActiveFocus('right');
			const seen: KeyboardEvent[] = [];
			const listener = (e: Event) => seen.push(e as KeyboardEvent);
			window.addEventListener('keydown', listener);

			try {
				focusRegionVertical('up');
			} finally {
				window.removeEventListener('keydown', listener);
			}

			expect(seen).toHaveLength(1);
			expect(seen[0].key).toBe('ArrowUp');
			expect(seen[0].target).toBe(rightBar);
		});

		it('ignores the echo of its own arrow instead of recursing', () => {
			// The arrow it sends bubbles to the window, which is where
			// useMainKeyboardHandler listens. A user who binds focusRegionUp to a
			// bare ArrowUp therefore has the action match its own dispatch; without
			// the re-entrancy guard that is an unbounded recursion, not a no-op.
			// This listener stands in for that binding.
			const { leftBar } = mountRegions();
			useUIStore.getState().setActiveFocus('sidebar');
			const seen: KeyboardEvent[] = [];
			const listener = (e: Event) => {
				seen.push(e as KeyboardEvent);
				focusRegionVertical('up');
			};
			window.addEventListener('keydown', listener);

			try {
				expect(() => focusRegionVertical('up')).not.toThrow();
			} finally {
				window.removeEventListener('keydown', listener);
			}

			expect(seen).toHaveLength(1);
			expect(seen[0].target).toBe(leftBar);

			// And the guard is released afterwards: it covers one synchronous
			// dispatch, not the rest of the session.
			const later: KeyboardEvent[] = [];
			const recorder = (e: Event) => later.push(e as KeyboardEvent);
			window.addEventListener('keydown', recorder);
			try {
				focusRegionVertical('down');
			} finally {
				window.removeEventListener('keydown', recorder);
			}
			expect(later).toHaveLength(1);
			expect(later[0].key).toBe('ArrowDown');
		});

		it('is a no-op when the focused bar is not mounted', () => {
			useUIStore.getState().setActiveFocus('sidebar');
			const listener = vi.fn();
			window.addEventListener('keydown', listener);

			try {
				expect(() => focusRegionVertical('down')).not.toThrow();
			} finally {
				window.removeEventListener('keydown', listener);
			}

			expect(listener).not.toHaveBeenCalled();
		});
	});

	it('exposes the selectors the regions are marked up with', () => {
		// Hard-coded rather than read back from the module: these strings are the
		// contract with SessionList, RightPanel, and TerminalOutput.
		expect(LEFT_BAR_SELECTOR).toBe('[data-panel="left"]');
		expect(RIGHT_BAR_SELECTOR).toBe('[data-panel="right"]');
		expect(TRANSCRIPT_SELECTOR).toBe('.terminal-output');
	});
});

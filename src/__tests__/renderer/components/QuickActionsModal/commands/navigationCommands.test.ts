/**
 * The command-palette routes to region focus, region resize, and zen mode.
 *
 * All seven of those actions ship with `keys: []`, so until a user binds a chord
 * (or switches to Vim mode) the palette IS the way to reach them. That makes
 * these entries the primary surface rather than a convenience, which is what
 * these tests pin:
 *
 *   - every action has a row, with the label the help sheet and the zen flash
 *     name it by, and the chord badge wired to the right shortcut id;
 *   - the four focus rows run AFTER the palette closes, because the palette
 *     re-asserts focus on its own input while it is mounted and the keyboard
 *     handler drops the bare arrow key that drives the up/down axis while any
 *     modal layer is open;
 *   - the two resize rows do NOT wait, since they only write a width.
 *
 * The services themselves (`regionFocus`, `regionResize`) have their own tests
 * and are mocked here: what is under test is the wiring, not the behavior of
 * the action.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { buildNavigationCommands } from '../../../../../renderer/components/QuickActionsModal/commands/navigationCommands';
import { DEFAULT_SHORTCUTS } from '../../../../../renderer/constants/shortcuts';

const focusRegionDirection = vi.fn();
const focusRegionVertical = vi.fn();
const growFocusedRegion = vi.fn();
const shrinkFocusedRegion = vi.fn();

vi.mock('../../../../../renderer/services/regionFocus', () => ({
	focusRegionDirection: (direction: 'left' | 'right') => focusRegionDirection(direction),
	focusRegionVertical: (direction: 'up' | 'down') => focusRegionVertical(direction),
}));
vi.mock('../../../../../renderer/services/regionResize', () => ({
	growFocusedRegion: () => growFocusedRegion(),
	shrinkFocusedRegion: () => shrinkFocusedRegion(),
}));

const setQuickActionOpen = vi.fn();
const toggleZenMode = vi.fn();

/**
 * The region and zen rows are GLOBAL - they act on the window, not on an agent -
 * so this builds with no active session on purpose. Everything asserted below
 * has to be offered even to a brand new install with nothing open.
 */
function build(shortcuts: Parameters<typeof buildNavigationCommands>[0]['shortcuts'] = {}) {
	return buildNavigationCommands({
		activeSession: undefined,
		activeSessionId: '',
		setQuickActionOpen,
		setLeftSidebarOpen: vi.fn(),
		setRightPanelOpen: vi.fn(),
		addNewSession: vi.fn(),
		deleteSession: vi.fn(),
		getOpenInLabel: () => 'Open',
		platform: 'darwin',
		toggleZenMode,
		shortcuts,
	});
}

function row(id: string) {
	const found = build({
		focusRegionLeft: DEFAULT_SHORTCUTS.focusRegionLeft,
		focusRegionRight: DEFAULT_SHORTCUTS.focusRegionRight,
		focusRegionUp: DEFAULT_SHORTCUTS.focusRegionUp,
		focusRegionDown: DEFAULT_SHORTCUTS.focusRegionDown,
		growRegion: DEFAULT_SHORTCUTS.growRegion,
		shrinkRegion: DEFAULT_SHORTCUTS.shrinkRegion,
		toggleZenMode: DEFAULT_SHORTCUTS.toggleZenMode,
	}).find((command) => command.id === id);
	if (!found) throw new Error(`no palette entry for ${id}`);
	return found;
}

describe('buildNavigationCommands - region focus, resize, and zen', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('offers a row for all seven actions, with no active agent', () => {
		expect(build().map((command) => command.id)).toEqual(
			expect.arrayContaining([
				'focusRegionLeft',
				'focusRegionRight',
				'focusRegionUp',
				'focusRegionDown',
				'growRegion',
				'shrinkRegion',
				'toggleZenMode',
			])
		);
	});

	it('labels each row the way the shortcut table does', () => {
		// Same string in both places or the chord in Settings > Shortcuts and the
		// row in the palette read as two different actions. Zen's label is load
		// bearing beyond that: its entry flash tells the user to "run Toggle Zen
		// Mode again from Quick Actions", so the row has to still answer to that
		// name while zen is on.
		for (const id of [
			'focusRegionLeft',
			'focusRegionRight',
			'focusRegionUp',
			'focusRegionDown',
			'growRegion',
			'shrinkRegion',
			'toggleZenMode',
		] as const) {
			expect(row(id).label).toBe(DEFAULT_SHORTCUTS[id].label);
		}
	});

	it('hands each row its own shortcut, so a bound chord shows on the right line', () => {
		for (const id of [
			'focusRegionLeft',
			'focusRegionRight',
			'focusRegionUp',
			'focusRegionDown',
			'growRegion',
			'shrinkRegion',
			'toggleZenMode',
		] as const) {
			expect(row(id).shortcut).toBe(DEFAULT_SHORTCUTS[id]);
		}
	});

	it('renders no badge while the action ships unassigned', () => {
		// QuickActionRow drops the pill when `keys` is empty, which is the shipped
		// state for all seven. Passing the real entries through must not invent a
		// chord that does not exist.
		for (const id of ['focusRegionLeft', 'growRegion', 'toggleZenMode'] as const) {
			expect(row(id).shortcut?.keys).toEqual([]);
		}
	});

	describe('deferral', () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it.each([
			['focusRegionLeft', 'left'],
			['focusRegionRight', 'right'],
		] as const)('%s closes the palette first, then walks regions', (id, direction) => {
			row(id).action();

			expect(setQuickActionOpen).toHaveBeenCalledWith(false);
			// Nothing yet: the palette is still mounted at this point, and it would
			// take focus straight back on its next render.
			expect(focusRegionDirection).not.toHaveBeenCalled();

			vi.runAllTimers();
			expect(focusRegionDirection).toHaveBeenCalledWith(direction);
		});

		it.each([
			['focusRegionUp', 'up'],
			['focusRegionDown', 'down'],
		] as const)('%s closes the palette first, then moves within the region', (id, direction) => {
			row(id).action();

			expect(setQuickActionOpen).toHaveBeenCalledWith(false);
			// The vertical axis dispatches a bare arrow key, which the main keyboard
			// handler ignores while any modal layer is open - so this one MUST wait.
			expect(focusRegionVertical).not.toHaveBeenCalled();

			vi.runAllTimers();
			expect(focusRegionVertical).toHaveBeenCalledWith(direction);
		});

		it('resizes immediately - a width needs no DOM focus', () => {
			row('growRegion').action();
			expect(growFocusedRegion).toHaveBeenCalledTimes(1);
			expect(setQuickActionOpen).toHaveBeenCalledWith(false);

			row('shrinkRegion').action();
			expect(shrinkFocusedRegion).toHaveBeenCalledTimes(1);

			// No pending work left behind.
			vi.runAllTimers();
			expect(growFocusedRegion).toHaveBeenCalledTimes(1);
			expect(shrinkFocusedRegion).toHaveBeenCalledTimes(1);
		});
	});

	it('toggles zen through the store action, after closing the palette', () => {
		// The flash zen raises on entry lands in the center of the window, which is
		// exactly where the open palette sits.
		row('toggleZenMode').action();
		expect(setQuickActionOpen).toHaveBeenCalledWith(false);
		expect(setQuickActionOpen.mock.invocationCallOrder[0]).toBeLessThan(
			toggleZenMode.mock.invocationCallOrder[0]
		);
		expect(toggleZenMode).toHaveBeenCalledTimes(1);
	});

	it('still renders the zen row when the host passes no toggle', () => {
		// Optional prop: a surface that builds the palette without uiStore wired up
		// must not crash on a click.
		const zen = buildNavigationCommands({
			activeSession: undefined,
			activeSessionId: '',
			setQuickActionOpen,
			setLeftSidebarOpen: vi.fn(),
			setRightPanelOpen: vi.fn(),
			addNewSession: vi.fn(),
			deleteSession: vi.fn(),
			getOpenInLabel: () => 'Open',
			platform: 'darwin',
			shortcuts: {},
		}).find((command) => command.id === 'toggleZenMode');
		expect(zen).toBeDefined();
		expect(() => zen?.action()).not.toThrow();
	});
});

/**
 * Arrow-key navigation over the Extensions tile grid.
 *
 * The grid is a composite widget: one roving tabindex for the whole thing,
 * arrows to move, Enter to open, Escape to come back. These tests defend the
 * parts that are easy to regress:
 *  - the grid takes focus as soon as the pane is on screen, so the arrows work
 *    without clicking or tabbing into it first
 *  - exactly one tile is tabbable, and it tracks the active tile
 *  - left/right step one tile, up/down jump a full ROW (measured column count,
 *    not a hard-coded 3)
 *  - Enter opens the active tile's details exactly once
 *  - coming back from details restores focus to the tile the user opened, so
 *    exploring can continue from where it left off
 *  - ArrowDown in the search box hands focus down into the grid
 *  - the row jump SURVIVES the details round trip (the grid unmounts there, and
 *    a column count measured off the old detached node collapses to 1)
 *
 * jsdom has no layout engine, so `grid-template-columns` never resolves on its
 * own: the suite stubs the computed value to three tracks, which is exactly
 * what `useGridColumnCount` reads in the app.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExtensionsView } from '../../../../../renderer/components/Settings/Extensions/ExtensionsView';
import {
	BUILTIN_FEATURES,
	builtinExtension,
	type UnifiedExtension,
} from '../../../../../renderer/components/Settings/Extensions/extensionModel';
import { LayerStackProvider } from '../../../../../renderer/contexts/LayerStackContext';
import type { EncoreFeatureFlags } from '../../../../../renderer/types';
import { mockTheme } from '../../../../helpers/mockTheme';

const COLUMNS = 3;

const ALL_FLAGS_OFF = Object.fromEntries(
	BUILTIN_FEATURES.map((f) => [f.flag, false])
) as EncoreFeatureFlags;

const TILES: UnifiedExtension[] = BUILTIN_FEATURES.map((def) =>
	builtinExtension(def, ALL_FLAGS_OFF)
);

vi.mock('../../../../../renderer/components/Settings/Extensions/useExtensions', () => ({
	useExtensions: () => ({
		extensions: TILES,
		encoreFeatures: {},
		contributions: null,
		pluginsSubsystemEnabled: true,
		loading: false,
		busyId: null,
		reload: vi.fn(),
		toggleBuiltin: vi.fn(),
		pendingEnable: null,
		confirmPendingEnable: vi.fn(),
		cancelPendingEnable: vi.fn(),
		enablePluginsSubsystem: vi.fn(),
		togglePlugin: vi.fn(),
		installPlugin: vi.fn(),
		uninstallPlugin: vi.fn(),
		revokePlugin: vi.fn(),
		getGrants: vi.fn(async () => ({ requested: [], granted: [] })),
	}),
}));

vi.mock('../../../../../renderer/components/Settings/Extensions/ExtensionDetails', () => ({
	ExtensionDetails: ({ ext }: { ext: UnifiedExtension }) => (
		<div data-testid="extension-details-stub">
			<span data-testid="details-name">{ext.name}</span>
		</div>
	),
}));

/**
 * Resolve `grid-template-columns` to N tracks, the way a browser would - and to
 * the EMPTY STRING for a detached node, which is also what a browser does and is
 * the thing that used to collapse the count to one column.
 */
function stubGridColumns(tracks: number): void {
	const original = window.getComputedStyle.bind(window);
	vi.spyOn(window, 'getComputedStyle').mockImplementation(((
		el: Element,
		pseudo?: string | null
	) => {
		const style = original(el, pseudo);
		if ((el as HTMLElement).dataset?.testid !== 'extensions-grid') return style;
		if (!el.isConnected) {
			return new Proxy(style, {
				get(target, prop) {
					if (prop === 'gridTemplateColumns') return '';
					const value = Reflect.get(target, prop);
					return typeof value === 'function' ? value.bind(target) : value;
				},
			});
		}
		return new Proxy(style, {
			get(target, prop) {
				if (prop === 'gridTemplateColumns') return Array(tracks).fill('240px').join(' ');
				const value = Reflect.get(target, prop);
				return typeof value === 'function' ? value.bind(target) : value;
			},
		});
	}) as typeof window.getComputedStyle);
}

function renderView(): void {
	render(
		<LayerStackProvider>
			<ExtensionsView theme={mockTheme} />
		</LayerStackProvider>
	);
}

function tiles(): HTMLElement[] {
	return screen.getAllByTestId('extension-card');
}

function activeTile(): HTMLElement {
	const active = tiles().filter((t) => t.dataset.active === 'true');
	expect(active).toHaveLength(1);
	return active[0];
}

/** Press a key on whatever currently holds focus, so it bubbles like a real one. */
function press(key: string): void {
	act(() => {
		fireEvent.keyDown(document.activeElement ?? document.body, { key });
	});
}

/**
 * A ResizeObserver whose callbacks fire on demand. The shared setup mock fires
 * once on observe and never again, so it cannot express the case that matters:
 * removing an observed element from the document resizes it to 0 and fires the
 * callback on a node that is no longer in the tree.
 */
const liveObservers: Array<{ callback: ResizeObserverCallback; connected: boolean }> = [];

function installControllableResizeObserver(): void {
	vi.stubGlobal(
		'ResizeObserver',
		class {
			private entry = { callback: undefined as unknown as ResizeObserverCallback };
			constructor(callback: ResizeObserverCallback) {
				this.entry.callback = callback;
			}
			observe() {
				liveObservers.push({ callback: this.entry.callback, connected: true });
			}
			unobserve() {}
			disconnect() {
				for (const o of liveObservers) if (o.callback === this.entry.callback) o.connected = false;
			}
		}
	);
}

/** Fire every observer that has not been disconnected. */
function flushResizeObservers(): void {
	act(() => {
		for (const o of liveObservers) {
			if (o.connected) o.callback([], {} as ResizeObserver);
		}
	});
}

beforeEach(() => {
	liveObservers.length = 0;
	installControllableResizeObserver();
	stubGridColumns(COLUMNS);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	cleanup();
});

describe('ExtensionsView grid keyboard navigation', () => {
	it('focuses the grid on mount so the arrows work straight away', () => {
		renderView();

		expect(document.activeElement).toBe(activeTile());
		expect(activeTile()).toBe(tiles()[0]);

		// No click, no Tab - just an arrow.
		press('ArrowRight');
		expect(document.activeElement).toBe(tiles()[1]);
	});

	it('exposes a single tab stop that follows the active tile', () => {
		renderView();

		expect(tiles().filter((t) => t.getAttribute('tabindex') === '0')).toHaveLength(1);
		expect(activeTile()).toBe(tiles()[0]);

		press('ArrowRight');

		expect(activeTile()).toBe(tiles()[1]);
		expect(tiles().filter((t) => t.getAttribute('tabindex') === '0')).toHaveLength(1);
		expect(tiles()[1]).toHaveAttribute('tabindex', '0');
	});

	it('steps one tile with left/right and moves the DOM focus along', () => {
		renderView();

		press('ArrowRight');
		expect(document.activeElement).toBe(tiles()[1]);

		press('ArrowLeft');
		expect(document.activeElement).toBe(tiles()[0]);
	});

	it('jumps a full row with up/down, using the measured column count', () => {
		renderView();

		press('ArrowDown');
		expect(document.activeElement).toBe(tiles()[COLUMNS]);

		press('ArrowUp');
		expect(document.activeElement).toBe(tiles()[0]);
	});

	it('jumps to the first and last tile with Home and End', () => {
		renderView();

		press('End');
		expect(activeTile()).toBe(tiles()[tiles().length - 1]);

		press('Home');
		expect(activeTile()).toBe(tiles()[0]);
	});

	it('opens the active tile once on Enter', () => {
		renderView();
		press('ArrowRight');
		const expected = tiles()[1].querySelector('.truncate')?.textContent;

		press('Enter');

		expect(screen.getAllByTestId('extension-details-stub')).toHaveLength(1);
		expect(screen.getByTestId('details-name')).toHaveTextContent(expected ?? '');
	});

	it('restores focus to the tile the user opened after Escape', () => {
		renderView();
		press('ArrowDown');
		const opened = activeTile();

		press('Enter');
		expect(screen.getByTestId('extension-details-stub')).toBeInTheDocument();

		act(() => {
			fireEvent.keyDown(window, { key: 'Escape' });
		});

		expect(screen.queryByTestId('extension-details-stub')).not.toBeInTheDocument();
		expect(document.activeElement).toBe(activeTile());
		expect(activeTile()).toHaveTextContent(opened.textContent ?? '');
	});

	it('still jumps a full row after a trip through the details pane', () => {
		// The grid unmounts while details are open. A column count re-measured off
		// that detached node reads as one column, which silently turns the row jump
		// back into a single step for the rest of the visit.
		renderView();
		press('ArrowDown');
		expect(activeTile()).toBe(tiles()[COLUMNS]);

		press('Enter');
		expect(screen.getByTestId('extension-details-stub')).toBeInTheDocument();
		// The removal resizes the old grid to 0 and fires its observer.
		flushResizeObservers();

		act(() => {
			fireEvent.keyDown(window, { key: 'Escape' });
		});
		flushResizeObservers();

		press('ArrowDown');
		expect(activeTile()).toBe(tiles()[COLUMNS * 2]);
	});

	it('hands focus from the search box down into the grid', () => {
		renderView();
		const search = screen.getByTestId('extensions-search');
		act(() => search.focus());

		act(() => {
			fireEvent.keyDown(search, { key: 'ArrowDown' });
		});

		expect(document.activeElement).toBe(activeTile());
	});

	it('keeps left/right working when the grid reflows to a single column', () => {
		// A narrow Settings pane drops the grid to one column. Horizontal arrows
		// have to keep stepping there, not go dead.
		vi.restoreAllMocks();
		stubGridColumns(1);
		renderView();

		press('ArrowRight');
		expect(document.activeElement).toBe(tiles()[1]);

		press('ArrowLeft');
		expect(document.activeElement).toBe(tiles()[0]);
	});

	it('does not steal focus from the search box while filtering', () => {
		renderView();
		const search = screen.getByTestId('extensions-search');
		act(() => search.focus());

		fireEvent.change(search, { target: { value: 'cue' } });

		expect(document.activeElement).toBe(search);
	});
});

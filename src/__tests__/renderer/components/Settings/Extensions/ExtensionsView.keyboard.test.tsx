/**
 * Arrow-key navigation over the Extensions tile grid.
 *
 * The grid is a composite widget: one roving tabindex for the whole thing,
 * arrows to move, Enter to open, Escape to come back. These tests defend the
 * parts that are easy to regress:
 *  - exactly one tile is tabbable, and it tracks the active tile
 *  - left/right step one tile, up/down jump a full ROW (measured column count,
 *    not a hard-coded 3)
 *  - Enter opens the active tile's details exactly once
 *  - coming back from details restores focus to the tile the user opened, so
 *    exploring can continue from where it left off
 *  - ArrowDown in the search box hands focus down into the grid
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
	ExtensionDetails: ({ ext, onBack }: { ext: UnifiedExtension; onBack: () => void }) => (
		<div data-testid="extension-details-stub">
			<span data-testid="details-name">{ext.name}</span>
			<button data-testid="details-back" onClick={onBack} />
		</div>
	),
}));

/** Resolve `grid-template-columns` to N tracks, the way a browser would. */
function stubGridColumns(tracks: number): void {
	const original = window.getComputedStyle.bind(window);
	vi.spyOn(window, 'getComputedStyle').mockImplementation(((
		el: Element,
		pseudo?: string | null
	) => {
		const style = original(el, pseudo);
		if ((el as HTMLElement).dataset?.testid !== 'extensions-grid') return style;
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

beforeEach(() => stubGridColumns(COLUMNS));

afterEach(() => {
	vi.restoreAllMocks();
	cleanup();
});

describe('ExtensionsView grid keyboard navigation', () => {
	it('exposes a single tab stop that follows the active tile', () => {
		renderView();

		expect(tiles().filter((t) => t.getAttribute('tabindex') === '0')).toHaveLength(1);
		expect(activeTile()).toBe(tiles()[0]);

		act(() => tiles()[0].focus());
		press('ArrowRight');

		expect(activeTile()).toBe(tiles()[1]);
		expect(tiles().filter((t) => t.getAttribute('tabindex') === '0')).toHaveLength(1);
		expect(tiles()[1]).toHaveAttribute('tabindex', '0');
	});

	it('steps one tile with left/right and moves the DOM focus along', () => {
		renderView();
		act(() => tiles()[0].focus());

		press('ArrowRight');
		expect(document.activeElement).toBe(tiles()[1]);

		press('ArrowLeft');
		expect(document.activeElement).toBe(tiles()[0]);
	});

	it('jumps a full row with up/down, using the measured column count', () => {
		renderView();
		act(() => tiles()[0].focus());

		press('ArrowDown');
		expect(document.activeElement).toBe(tiles()[COLUMNS]);

		press('ArrowUp');
		expect(document.activeElement).toBe(tiles()[0]);
	});

	it('jumps to the first and last tile with Home and End', () => {
		renderView();
		act(() => tiles()[0].focus());

		press('End');
		expect(activeTile()).toBe(tiles()[tiles().length - 1]);

		press('Home');
		expect(activeTile()).toBe(tiles()[0]);
	});

	it('opens the active tile once on Enter', () => {
		renderView();
		act(() => tiles()[0].focus());
		press('ArrowRight');
		const expected = tiles()[1].querySelector('.truncate')?.textContent;

		press('Enter');

		expect(screen.getAllByTestId('extension-details-stub')).toHaveLength(1);
		expect(screen.getByTestId('details-name')).toHaveTextContent(expected ?? '');
	});

	it('restores focus to the tile the user opened after Escape', () => {
		renderView();
		act(() => tiles()[0].focus());
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

	it('hands focus from the search box down into the grid', () => {
		renderView();
		const search = screen.getByTestId('extensions-search');
		act(() => search.focus());

		act(() => {
			fireEvent.keyDown(search, { key: 'ArrowDown' });
		});

		expect(document.activeElement).toBe(activeTile());
	});

	it('does not steal focus from the search box while filtering', () => {
		renderView();
		const search = screen.getByTestId('extensions-search');
		act(() => search.focus());

		fireEvent.change(search, { target: { value: 'cue' } });

		expect(document.activeElement).toBe(search);
	});
});

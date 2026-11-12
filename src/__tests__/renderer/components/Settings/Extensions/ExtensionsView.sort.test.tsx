/**
 * Ordering of the Extensions tile grid.
 *
 * The grid used to render in registry order, which reads as no order at all
 * once there are nine built-ins and any number of plugins. It now sorts, and
 * these tests defend the parts that are easy to regress:
 *  - the default is alphabetical, not registry order
 *  - "Newest" orders by release date, newest first, with undated tiles last
 *  - re-sorting carries the keyboard cursor by TILE, not by index
 *  - the chosen mode is remembered across a remount (Settings unmounts this
 *    view on every tab switch)
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExtensionsView } from '../../../../../renderer/components/Settings/Extensions/ExtensionsView';
import {
	EXTENSION_SORT_STORAGE_KEY,
	type UnifiedExtension,
} from '../../../../../renderer/components/Settings/Extensions/extensionModel';
import { LayerStackProvider } from '../../../../../renderer/contexts/LayerStackContext';
import { mockTheme } from '../../../../helpers/mockTheme';
import { installLocalStorageMock } from '../../../../helpers/mockLocalStorage';

function tile(name: string, releaseDate?: string): UnifiedExtension {
	return {
		key: `plugin:${name}`,
		kind: 'plugin',
		id: name,
		name,
		description: '',
		category: 'other',
		state: 'installed',
		...(releaseDate ? { releaseDate } : {}),
	};
}

// Deliberately in neither alphabetical nor chronological order, so a grid that
// simply renders what it was handed fails both assertions.
const TILES: UnifiedExtension[] = [
	tile('Cue', '2026-03-01'),
	tile('Alpha', '2026-07-10'),
	tile('Undated'),
	tile('Beta', '2025-06-01'),
];

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

function renderView(): void {
	render(
		<LayerStackProvider>
			<ExtensionsView theme={mockTheme} />
		</LayerStackProvider>
	);
}

function names(): string[] {
	return screen.getAllByTestId('extension-card').map((t) => t.dataset.extensionId ?? '');
}

function clickSort(mode: 'name' | 'newest'): void {
	act(() => {
		fireEvent.click(screen.getByTestId(`extensions-sort-${mode}`));
	});
}

let storage: Map<string, string>;

beforeEach(() => {
	// jsdom here ships no working Storage; the shared stand-in also resets
	// between tests, so the remembered sort mode cannot leak across them.
	storage = installLocalStorageMock();
});

afterEach(() => {
	cleanup();
});

describe('ExtensionsView sorting', () => {
	it('defaults to alphabetical rather than registry order', () => {
		renderView();
		expect(names()).toEqual(['Alpha', 'Beta', 'Cue', 'Undated']);
	});

	it('orders by release date, newest first, with undated tiles last', () => {
		renderView();
		clickSort('newest');
		expect(names()).toEqual(['Alpha', 'Cue', 'Beta', 'Undated']);
	});

	it('shows each tile its own release date', () => {
		renderView();
		const dates = screen
			.getAllByTestId('extension-release-date')
			.map((el) => el.dataset.releaseDate);
		expect(dates).toEqual(['2026-07-10', '2025-06-01', '2026-03-01']);
		// The undated tile renders no pill rather than an empty one.
		expect(dates).toHaveLength(TILES.length - 1);
	});

	it('carries the keyboard cursor with the tile when the order changes', () => {
		renderView();
		// Alphabetical: [Alpha, Beta, Cue, Undated]. Walk to Cue.
		act(() => {
			fireEvent.keyDown(document.activeElement ?? document.body, { key: 'ArrowRight' });
		});
		act(() => {
			fireEvent.keyDown(document.activeElement ?? document.body, { key: 'ArrowRight' });
		});
		expect(screen.getAllByTestId('extension-card')[2].dataset.extensionId).toBe('Cue');
		expect(document.activeElement?.getAttribute('data-extension-id')).toBe('Cue');

		clickSort('newest');

		// Newest: [Alpha, Cue, Beta, Undated] - the ring rides Cue to slot 1.
		const active = screen
			.getAllByTestId('extension-card')
			.filter((t) => t.dataset.active === 'true');
		expect(active).toHaveLength(1);
		expect(active[0].dataset.extensionId).toBe('Cue');
	});

	it('remembers the mode across a remount', () => {
		renderView();
		clickSort('newest');
		expect(storage.get(EXTENSION_SORT_STORAGE_KEY)).toBe('newest');

		cleanup();
		renderView();
		expect(names()).toEqual(['Alpha', 'Cue', 'Beta', 'Undated']);
	});

	it('ignores a stored mode this build no longer has a control for', () => {
		storage.set(EXTENSION_SORT_STORAGE_KEY, 'by-vibes');
		renderView();
		expect(names()).toEqual(['Alpha', 'Beta', 'Cue', 'Undated']);
	});
});

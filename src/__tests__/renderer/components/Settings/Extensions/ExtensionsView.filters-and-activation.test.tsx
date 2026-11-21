// Source: src/__tests__/renderer/components/Settings/Extensions/ExtensionsView.encoreFilter.test.tsx
// Source: src/__tests__/renderer/components/Settings/Extensions/ExtensionsView.sort.test.tsx
// Source: src/__tests__/renderer/components/Settings/Extensions/FirstPartyEnableModal.test.tsx
import { describe as describeSourceSuite } from 'vitest';
import { cleanup } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import { render } from '@testing-library/react';
import { screen } from '@testing-library/react';
import { afterEach } from 'vitest';
import { describe } from 'vitest';
import { expect } from 'vitest';
import { it } from 'vitest';
import { vi } from 'vitest';
import { ExtensionsView } from '../../../../../renderer/components/Settings/Extensions/ExtensionsView';
import type { UnifiedExtension } from '../../../../../renderer/components/Settings/Extensions/extensionModel';
import { LayerStackProvider } from '../../../../../renderer/contexts/LayerStackContext';
import { mockTheme } from '../../../../helpers/mockTheme';
import { act } from '@testing-library/react';
import { beforeEach } from 'vitest';
import { EXTENSION_SORT_STORAGE_KEY } from '../../../../../renderer/components/Settings/Extensions/extensionModel';
import { installLocalStorageMock } from '../../../../helpers/mockLocalStorage';
import React from 'react';
import { FirstPartyEnableModal } from '../../../../../renderer/components/Settings/Extensions/FirstPartyEnableModal';
import type { PermissionRequest } from '../../../../../shared/plugins/permissions';
let activeTiles: UnifiedExtension[] = [];

afterEach(() => {
	activeTiles = [];
});

vi.mock('../../../../../renderer/components/Settings/Extensions/useExtensions', () => ({
	useExtensions: () => ({
		extensions: activeTiles,
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
describeSourceSuite('ExtensionsView.encoreFilter', () => {
	function tile(over: Partial<UnifiedExtension> & { id: string }): UnifiedExtension {
		return {
			key: `${over.kind ?? 'plugin'}:${over.id}`,
			kind: 'plugin',
			name: over.id,
			description: '',
			category: 'other',
			state: 'installed',
			...over,
		};
	}

	// Two graduated built-ins in DIFFERENT categories, one opt-in built-in, and a
	// plain plugin: a filter that secretly matched on category would fail here.
	const TILES: UnifiedExtension[] = [
		tile({ id: 'Cue', kind: 'builtin', category: 'automation', encore: true, state: 'enabled' }),
		tile({ id: 'Stats', kind: 'builtin', category: 'insights', encore: true, state: 'enabled' }),
		tile({ id: 'Pianola', kind: 'builtin', category: 'ui', beta: true, state: 'not-installed' }),
		tile({ id: 'Community' }),
	];

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

	beforeEach(() => {
		activeTiles = TILES;
	});

	afterEach(cleanup);

	describe('Extensions Encore filter pill', () => {
		it('sits immediately after All in the pill bar', () => {
			renderView();
			const pills = screen.getAllByTestId('extensions-filter');
			expect(pills.map((p) => p.dataset.category).slice(0, 2)).toEqual(['all', 'encore']);
			expect(pills[1]).toHaveTextContent('Encore');
		});

		it('narrows to graduated tiles across categories, dropping Beta and plugins', () => {
			renderView();
			expect(names()).toHaveLength(4);
			fireEvent.click(screen.getAllByTestId('extensions-filter')[1]);
			expect(names().sort()).toEqual(['Cue', 'Stats']);
		});

		it('marks itself pressed and hands the grid back on All', () => {
			renderView();
			const [allPill, encorePill] = screen.getAllByTestId('extensions-filter');
			fireEvent.click(encorePill);
			expect(encorePill).toHaveAttribute('aria-pressed', 'true');
			expect(allPill).toHaveAttribute('aria-pressed', 'false');
			fireEvent.click(allPill);
			expect(names()).toHaveLength(4);
		});

		it('badges graduated tiles Encore, opt-in tiles Beta, and plugins not at all', () => {
			renderView();
			const badges = new Map(
				screen
					.getAllByTestId('extension-card')
					.map((card) => [
						card.dataset.extensionId ?? '',
						card.querySelector('[data-testid="extension-badge"]')?.getAttribute('data-badge') ??
							null,
					])
			);
			expect(badges.get('Cue')).toBe('Encore');
			expect(badges.get('Stats')).toBe('Encore');
			expect(badges.get('Pianola')).toBe('Beta');
			expect(badges.get('Community')).toBeNull();
		});
	});
});
describeSourceSuite('ExtensionsView.sort', () => {
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
		activeTiles = TILES;
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
});
describeSourceSuite('FirstPartyEnableModal', () => {
	// A representative spread across risk buckets, with scope + reason so the row
	// layout is exercised, not just a single trivial capability.
	const PERMISSIONS: readonly PermissionRequest[] = [
		{ capability: 'settings:read', reason: 'Re-read the feature flag before acting.' },
		{ capability: 'net:fetch', scope: 'github.com', reason: 'Poll GitHub for updates.' },
		{ capability: 'process:spawn', reason: 'Run a supervised host binary.' },
	];

	function renderModal(
		overrides: Partial<React.ComponentProps<typeof FirstPartyEnableModal>> = {}
	): {
		onConfirm: ReturnType<typeof vi.fn>;
		onCancel: ReturnType<typeof vi.fn>;
	} {
		const onConfirm = vi.fn();
		const onCancel = vi.fn();
		render(
			<LayerStackProvider>
				<FirstPartyEnableModal
					theme={mockTheme}
					name="Maestro Cue"
					permissions={PERMISSIONS}
					onConfirm={onConfirm}
					onCancel={onCancel}
					{...overrides}
				/>
			</LayerStackProvider>
		);
		return { onConfirm, onCancel };
	}

	afterEach(cleanup);

	describe('FirstPartyEnableModal', () => {
		it('renders the container and the feature name in the title and body', () => {
			renderModal();
			expect(screen.getByTestId('first-party-enable-modal')).toBeInTheDocument();
			// Title "Enable {name}" is the confirm button label too; the aria-label
			// on the dialog carries the title. Assert the name appears in the body copy.
			expect(screen.getByText(/Maestro Cue is a built-in Maestro feature/i)).toBeInTheDocument();
			expect(screen.getByTestId('first-party-enable-confirm')).toHaveTextContent(
				'Enable Maestro Cue'
			);
		});

		it('renders one review row per declared permission, labeled "Will be granted"', () => {
			renderModal();
			const rows = screen.getAllByTestId('extension-permission');
			expect(rows).toHaveLength(PERMISSIONS.length);
			expect(rows.map((r) => r.getAttribute('data-cap'))).toEqual(
				PERMISSIONS.map((p) => p.capability)
			);
			for (const status of screen.getAllByTestId('extension-permission-status')) {
				expect(status.textContent).toBe('Will be granted');
			}
		});

		it('clicking confirm fires onConfirm and nothing else', () => {
			const { onConfirm, onCancel } = renderModal();
			fireEvent.click(screen.getByTestId('first-party-enable-confirm'));
			expect(onConfirm).toHaveBeenCalledTimes(1);
			expect(onCancel).not.toHaveBeenCalled();
		});

		it('clicking cancel fires onCancel and does not confirm', () => {
			const { onConfirm, onCancel } = renderModal();
			fireEvent.click(screen.getByTestId('first-party-enable-cancel'));
			expect(onCancel).toHaveBeenCalledTimes(1);
			expect(onConfirm).not.toHaveBeenCalled();
		});

		it('Escape routes to onCancel via the layer stack', async () => {
			const { onConfirm, onCancel } = renderModal();
			await act(async () => {
				document.dispatchEvent(
					new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
				);
			});
			expect(onCancel).toHaveBeenCalledTimes(1);
			expect(onConfirm).not.toHaveBeenCalled();
		});

		it('renders honest "no special capabilities" copy when permissions are empty', () => {
			renderModal({ permissions: [] });
			expect(screen.queryByTestId('extension-permission')).not.toBeInTheDocument();
			expect(screen.getByText(/requests no special capabilities/i)).toBeInTheDocument();
		});
	});
});

/**
 * The Encore pill in the Extensions filter bar.
 *
 * Encore is not a category - a graduated feature still belongs to Automation or
 * Insights - so the pill narrows by BADGE, across categories. These tests cover
 * the parts that are easy to regress:
 *  - the pill exists, and sits right after All
 *  - clicking it leaves only graduated tiles, spanning several categories
 *  - a graduated tile wears an Encore badge, an opt-in one wears Beta, and a
 *    plain community plugin wears neither
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExtensionsView } from '../../../../../renderer/components/Settings/Extensions/ExtensionsView';
import type { UnifiedExtension } from '../../../../../renderer/components/Settings/Extensions/extensionModel';
import { LayerStackProvider } from '../../../../../renderer/contexts/LayerStackContext';
import { mockTheme } from '../../../../helpers/mockTheme';

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
					card.querySelector('[data-testid="extension-badge"]')?.getAttribute('data-badge') ?? null,
				])
		);
		expect(badges.get('Cue')).toBe('Encore');
		expect(badges.get('Stats')).toBe('Encore');
		expect(badges.get('Pianola')).toBe('Beta');
		expect(badges.get('Community')).toBeNull();
	});
});

/**
 * ExtensionsView escape routing.
 *
 * The marketplace is a drill-down INSIDE the Settings modal: grid -> details.
 * While the details pane is open it registers its own layer above Settings, so
 * Escape means "back to the grid", not "close Settings". These tests stand up a
 * fake Settings layer (a plain layer at MODAL_PRIORITIES.SETTINGS with a spy
 * onEscape) underneath the view and assert which layer Escape reaches:
 *  - grid showing        -> Settings closes
 *  - details showing     -> back to the grid, Settings untouched
 *  - Escape twice        -> back, then Settings closes
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExtensionsView } from '../../../../../renderer/components/Settings/Extensions/ExtensionsView';
import {
	BUILTIN_FEATURES,
	builtinExtension,
	type UnifiedExtension,
} from '../../../../../renderer/components/Settings/Extensions/extensionModel';
import { LayerStackProvider } from '../../../../../renderer/contexts/LayerStackContext';
import { useModalLayer } from '../../../../../renderer/hooks/ui/useModalLayer';
import { MODAL_PRIORITIES } from '../../../../../renderer/constants/modalPriorities';
import type { EncoreFeatureFlags } from '../../../../../renderer/types';
import { mockTheme } from '../../../../helpers/mockTheme';

const flags = (overrides: Partial<EncoreFeatureFlags> = {}): EncoreFeatureFlags => ({
	directorNotes: false,
	usageStats: false,
	symphony: false,
	maestroCue: false,
	pianola: false,
	plugins: false,
	...overrides,
});

function builtinTile(flag: keyof EncoreFeatureFlags, enabled: boolean): UnifiedExtension {
	const def = BUILTIN_FEATURES.find((f) => f.flag === flag);
	if (!def) throw new Error(`no builtin feature for flag ${flag}`);
	return builtinExtension(def, flags({ [flag]: enabled }));
}

const TILES = [builtinTile('usageStats', true), builtinTile('maestroCue', false)];

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

// The detail pane's internals are covered by the ExtensionDetails suites; this
// suite only needs to know whether it is on screen.
vi.mock('../../../../../renderer/components/Settings/Extensions/ExtensionDetails', () => ({
	ExtensionDetails: ({ ext, onBack }: { ext: UnifiedExtension; onBack: () => void }) => (
		<div data-testid="extension-details-stub">
			<span data-testid="details-name">{ext.name}</span>
			<button data-testid="details-back" onClick={onBack} />
		</div>
	),
}));

/** Stand-in for the Settings modal that hosts the view. */
function SettingsHost({ onEscape }: { onEscape: () => void }) {
	useModalLayer(MODAL_PRIORITIES.SETTINGS, 'Settings', onEscape);
	return <ExtensionsView theme={mockTheme} />;
}

function renderView(): { settingsEscape: ReturnType<typeof vi.fn> } {
	const settingsEscape = vi.fn();
	render(
		<LayerStackProvider>
			<SettingsHost onEscape={settingsEscape} />
		</LayerStackProvider>
	);
	return { settingsEscape };
}

function pressEscape(): void {
	act(() => {
		fireEvent.keyDown(window, { key: 'Escape' });
	});
}

function openFirstTile(): void {
	fireEvent.click(screen.getAllByTestId('extension-card')[0]);
}

afterEach(cleanup);

describe('ExtensionsView escape routing', () => {
	it('lets Escape close Settings while the grid is showing', () => {
		const { settingsEscape } = renderView();

		expect(screen.queryByTestId('extension-details-stub')).not.toBeInTheDocument();
		pressEscape();

		expect(settingsEscape).toHaveBeenCalledTimes(1);
	});

	it('goes back to the grid on Escape instead of closing Settings', () => {
		const { settingsEscape } = renderView();
		openFirstTile();
		expect(screen.getByTestId('extension-details-stub')).toBeInTheDocument();

		pressEscape();

		expect(screen.queryByTestId('extension-details-stub')).not.toBeInTheDocument();
		expect(screen.getByTestId('extensions-search')).toBeInTheDocument();
		expect(settingsEscape).not.toHaveBeenCalled();
	});

	it('closes Settings on the second Escape, once the details pane is dismissed', () => {
		const { settingsEscape } = renderView();
		openFirstTile();

		pressEscape();
		expect(settingsEscape).not.toHaveBeenCalled();

		pressEscape();
		expect(settingsEscape).toHaveBeenCalledTimes(1);
	});

	it('still supports the explicit back button', () => {
		const { settingsEscape } = renderView();
		openFirstTile();

		fireEvent.click(screen.getByTestId('details-back'));

		expect(screen.queryByTestId('extension-details-stub')).not.toBeInTheDocument();
		expect(settingsEscape).not.toHaveBeenCalled();
	});
});

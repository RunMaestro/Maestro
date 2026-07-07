/**
 * ExtensionDetails sub-tabs contract.
 *
 * The detail pane splits into two sub-tabs (role=tab, aria-selected):
 * - Settings: first-party config body / plugin's consent-gated editor /
 *   Pianola's Open-Pianola entry. Default when the tile is configurable.
 * - Permissions: capability disclosure + supervised background services +
 *   (plugins) contributions. Default when there is nothing to configure.
 *
 * These tests defend:
 * - which sub-tab opens first (configurable → Settings, else Permissions),
 * - that capability/service disclosure is gated behind the Permissions tab,
 * - the disabled first-party hint, Pianola's moved Open-Pianola entry, and the
 *   plugin Configure (grant + edit) → setting-inputs flow,
 * - that the removed action-row affordances (extension-configure-builtin, and
 *   extension-configure / extension-open-pianola in the action row) are gone.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { ExtensionDetails } from '../../../../../renderer/components/Settings/Extensions/ExtensionDetails';
import {
	BUILTIN_FEATURES,
	builtinExtension,
	type UnifiedExtension,
} from '../../../../../renderer/components/Settings/Extensions/extensionModel';
import type { EncoreFeatureFlags, Theme } from '../../../../../renderer/types';
import type { PluginRecord } from '../../../../../shared/plugins/plugin-registry';
import type {
	AggregatedContributions,
	SettingContribution,
} from '../../../../../shared/plugins/contributions';

const theme = {
	colors: {
		textMain: '#eee',
		textDim: '#999',
		bgMain: '#111',
		bgActivity: '#222',
		accent: '#4af',
		border: '#333',
		warning: '#fa0',
		error: '#f44',
		success: '#4f4',
	},
} as unknown as Theme;

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

const SETTINGS_BODY = <div data-testid="first-party-body">Usage config body</div>;

function renderDetails(overrides: Partial<React.ComponentProps<typeof ExtensionDetails>>): void {
	const base: React.ComponentProps<typeof ExtensionDetails> = {
		theme,
		ext: builtinTile('usageStats', true),
		contributions: null,
		busy: false,
		onBack: vi.fn(),
		onTogglePlugin: vi.fn(),
		onToggleBuiltin: vi.fn(),
		onUninstall: vi.fn(),
		onRevoke: vi.fn(),
		getGrants: vi.fn(async () => ({ requested: [], granted: [] })),
	};
	render(<ExtensionDetails {...base} {...overrides} />);
}

function pluginRecord(id: string): PluginRecord {
	return {
		id,
		source: `/plugins/${id}`,
		folderName: id,
		enabled: true,
		loadStatus: 'ok',
		errors: [],
		manifest: {
			id,
			name: 'Demo Plugin',
			version: '1.0.0',
			tier: 1,
			maestro: { minHostApi: '1.0.0' },
			entry: 'main.js',
		},
	};
}

function pluginTile(id: string): UnifiedExtension {
	return {
		key: `plugin:${id}`,
		kind: 'plugin',
		id,
		name: 'Demo Plugin',
		description: 'A demo.',
		category: 'automation',
		state: 'enabled',
		tier: 0,
		trust: 'trusted',
		version: '1.0.0',
		loadStatus: 'ok',
		record: pluginRecord(id),
	} as UnifiedExtension;
}

function contributionsWith(setting: SettingContribution): AggregatedContributions {
	return {
		themes: [],
		prompts: [],
		settings: [setting],
		commandMacros: [],
		cueTriggers: [],
		commands: [],
		panels: [],
		agents: [],
		tools: [],
		keybindings: [],
		uiItems: [],
		errorsByPlugin: {},
	};
}

afterEach(cleanup);

describe('ExtensionDetails sub-tabs — configurable first-party tile', () => {
	it('opens on the Settings sub-tab and renders the config body there', () => {
		renderDetails({ ext: builtinTile('usageStats', true), settingsBody: SETTINGS_BODY });

		const settingsTab = screen.getByTestId('extension-subtab-settings');
		expect(settingsTab).toHaveAttribute('role', 'tab');
		expect(settingsTab).toHaveAttribute('aria-selected', 'true');
		expect(screen.getByTestId('extension-subtab-permissions')).toHaveAttribute(
			'aria-selected',
			'false'
		);

		// The Settings panel holds the config body; permission/service disclosure
		// is NOT visible until the Permissions tab is selected.
		expect(screen.getByTestId('extension-settings-panel')).toBeInTheDocument();
		expect(screen.getByTestId('first-party-body')).toBeInTheDocument();
		expect(screen.queryByTestId('extension-permission')).not.toBeInTheDocument();
		expect(screen.queryByTestId('extension-background-service')).not.toBeInTheDocument();
	});

	it('reveals capabilities + background services only after clicking Permissions, then back', () => {
		renderDetails({ ext: builtinTile('usageStats', true), settingsBody: SETTINGS_BODY });

		fireEvent.click(screen.getByTestId('extension-subtab-permissions'));

		expect(screen.getByTestId('extension-subtab-permissions')).toHaveAttribute(
			'aria-selected',
			'true'
		);
		// usageStats declares permissions AND a supervised stats.sampler service.
		expect(screen.getAllByTestId('extension-permission').length).toBeGreaterThan(0);
		const service = screen.getByTestId('extension-background-service');
		expect(service.getAttribute('data-service')).toBe('stats.sampler');
		expect(screen.getByTestId('extension-background-service-status').textContent).toBe(
			'Running (supervised)'
		);
		// The config body is hidden while Permissions is active.
		expect(screen.queryByTestId('first-party-body')).not.toBeInTheDocument();

		// Clicking Settings returns to the config body.
		fireEvent.click(screen.getByTestId('extension-subtab-settings'));
		expect(screen.getByTestId('first-party-body')).toBeInTheDocument();
		expect(screen.queryByTestId('extension-permission')).not.toBeInTheDocument();
	});

	it('shows the disabled hint (not the config body) when the feature is disabled', () => {
		renderDetails({ ext: builtinTile('usageStats', false), settingsBody: SETTINGS_BODY });

		// Still opens on Settings (it is configurable), but the body is gated
		// behind the enable state — a hint takes its place.
		expect(screen.getByTestId('extension-subtab-settings')).toHaveAttribute(
			'aria-selected',
			'true'
		);
		expect(screen.getByTestId('extension-settings-disabled-hint')).toHaveTextContent(
			'Enable this plugin to configure it.'
		);
		expect(screen.queryByTestId('first-party-body')).not.toBeInTheDocument();
	});
});

describe('ExtensionDetails sub-tabs — non-configurable tile', () => {
	it('opens straight on Permissions when there is nothing to configure', () => {
		// A disabled directorNotes tile with NO settingsBody: not configurable,
		// so the Settings tab is absent and the pane opens on Permissions.
		renderDetails({ ext: builtinTile('directorNotes', false) });

		expect(screen.queryByTestId('extension-subtab-settings')).not.toBeInTheDocument();
		expect(screen.getByTestId('extension-subtab-permissions')).toHaveAttribute(
			'aria-selected',
			'true'
		);
		expect(screen.getAllByTestId('extension-permission').length).toBeGreaterThan(0);
	});
});

describe('ExtensionDetails sub-tabs — Pianola', () => {
	it('shows Open Pianola inside the Settings sub-tab (not the action row)', () => {
		renderDetails({ ext: builtinTile('pianola', true) });

		// Pianola is configurable via its own modal → Settings is the default tab.
		expect(screen.getByTestId('extension-subtab-settings')).toHaveAttribute(
			'aria-selected',
			'true'
		);
		const openBtn = screen.getByTestId('extension-open-pianola');
		// Open Pianola lives INSIDE the Settings panel, not the action row.
		expect(screen.getByTestId('extension-settings-panel').contains(openBtn)).toBe(true);
	});

	it('shows the disabled hint on the Settings tab when Pianola is off', () => {
		renderDetails({ ext: builtinTile('pianola', false) });

		expect(screen.queryByTestId('extension-open-pianola')).not.toBeInTheDocument();
		expect(screen.getByTestId('extension-settings-disabled-hint')).toHaveTextContent(
			'Enable Pianola to open its manager and rules.'
		);
	});
});

describe('ExtensionDetails sub-tabs — plugin Configure (grant + edit)', () => {
	const pluginId = 'com.example.settings';
	const setting: SettingContribution = {
		id: `${pluginId}:poll`,
		localId: 'poll',
		pluginId,
		key: 'poll',
		type: 'boolean',
		default: false,
		description: 'Poll automatically',
	};

	it('shows Configure in the Settings tab, then renders setting inputs after granting', async () => {
		vi.mocked(window.maestro.plugins.requestConsent).mockResolvedValue({ opened: true });
		vi.mocked(window.maestro.settings.get).mockResolvedValue(undefined);

		renderDetails({ ext: pluginTile(pluginId), contributions: contributionsWith(setting) });

		// A configurable plugin opens on Settings; the Configure button lives in
		// the Settings panel (the old action-row Configure is gone).
		const settingsPanel = screen.getByTestId('extension-settings-panel');
		const configureBtn = screen.getByTestId('extension-configure');
		expect(settingsPanel.contains(configureBtn)).toBe(true);
		expect(configureBtn).toHaveTextContent('Configure (grant + edit)');
		expect(screen.queryByTestId('extension-setting-input')).not.toBeInTheDocument();

		await act(async () => {
			fireEvent.click(configureBtn);
		});

		// requestConsent runs, then the contributed settings render as inputs.
		expect(window.maestro.plugins.requestConsent).toHaveBeenCalledWith(pluginId);
		await waitFor(() => {
			expect(screen.getByTestId('extension-setting-input')).toBeInTheDocument();
		});
		expect(screen.getByText('Poll automatically')).toBeInTheDocument();
	});
});

describe('ExtensionDetails sub-tabs — removed action-row affordances', () => {
	it('never renders the removed extension-configure-builtin control', () => {
		renderDetails({ ext: builtinTile('usageStats', true), settingsBody: SETTINGS_BODY });
		expect(screen.queryByTestId('extension-configure-builtin')).not.toBeInTheDocument();
	});

	it('keeps the plugin Configure out of the Permissions tab', async () => {
		const pluginId = 'com.example.settings';
		const setting: SettingContribution = {
			id: `${pluginId}:poll`,
			localId: 'poll',
			pluginId,
			key: 'poll',
			type: 'boolean',
			default: false,
			description: 'Poll automatically',
		};
		renderDetails({ ext: pluginTile(pluginId), contributions: contributionsWith(setting) });

		fireEvent.click(screen.getByTestId('extension-subtab-permissions'));
		expect(screen.queryByTestId('extension-configure')).not.toBeInTheDocument();
	});
});

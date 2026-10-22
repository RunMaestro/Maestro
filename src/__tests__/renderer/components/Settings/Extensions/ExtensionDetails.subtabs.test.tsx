/**
 * ExtensionDetails sub-tabs contract.
 *
 * The detail pane splits into three sub-tabs (role=tab, aria-selected):
 * - Help: the usage guide. Always present. Default for anything not yet
 *   enabled, and for an enabled tile with nothing to configure.
 * - Settings: first-party config body / plugin's consent-gated editor /
 *   Pianola's Open-Pianola entry. Default when the tile is enabled and
 *   configurable.
 * - Permissions: capability disclosure + supervised background services +
 *   (plugins) contributions.
 *
 * These tests defend:
 * - which sub-tab opens first (enabled + configurable → Settings, else Help),
 * - that the Enable switch sits in the header row on every tile, and that
 *   flipping the switch never moves the user's tab,
 * - that capability/service disclosure is gated behind the Permissions tab,
 * - the disabled first-party hint, Pianola's moved Open-Pianola entry (which
 *   dismisses Settings so its modal is not hidden behind it), and the
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
import { useModalStore } from '../../../../../renderer/stores/modalStore';
import type {
	AggregatedContributions,
	PanelContribution,
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

function renderDetails(overrides: Partial<React.ComponentProps<typeof ExtensionDetails>>) {
	const base: React.ComponentProps<typeof ExtensionDetails> = {
		theme,
		ext: builtinTile('usageStats', true),
		contributions: null,
		busy: false,
		onTogglePlugin: vi.fn(),
		onToggleBuiltin: vi.fn(),
		onUninstall: vi.fn(),
		onRevoke: vi.fn(),
		getGrants: vi.fn(async () => ({ requested: [], granted: [] })),
	};
	return render(<ExtensionDetails {...base} {...overrides} />);
}

function pluginRecord(id: string, declaresPanel = false): PluginRecord {
	return {
		id,
		source: `/plugins/${id}`,
		folderName: id,
		enabled: true,
		loadStatus: 'ok',
		signature: { status: 'trusted' },
		errors: [],
		manifest: {
			id,
			name: 'Demo Plugin',
			version: '1.0.0',
			tier: 1,
			maestro: { minHostApi: '1.0.0' },
			entry: 'main.js',
			...(declaresPanel
				? {
						contributes: {
							panels: [
								{
									id: 'config',
									title: `${id} config`,
									entry: 'panel.html',
									placement: 'settings' as const,
								},
							],
						},
					}
				: {}),
		},
	};
}

function pluginTile(id: string, declaresPanel = false): UnifiedExtension {
	return {
		key: `plugin:${id}`,
		kind: 'plugin',
		id,
		name: 'Demo Plugin',
		description: 'A demo.',
		category: 'automation',
		state: 'enabled',
		tier: 1,
		trust: 'trusted',
		version: '1.0.0',
		loadStatus: 'ok',
		record: pluginRecord(id, declaresPanel),
	} as UnifiedExtension;
}

function contributionsWith(setting?: SettingContribution): AggregatedContributions {
	return {
		themes: [],
		iconPacks: [],
		prompts: [],
		settings: setting ? [setting] : [],
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

describe('ExtensionDetails sub-tabs - configurable first-party tile', () => {
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

	it('a settings deep link switches an open pane from Help back to Settings', () => {
		const props = { ext: builtinTile('usageStats', true), settingsBody: SETTINGS_BODY };
		const { rerender } = renderDetails(props);
		fireEvent.click(screen.getByTestId('extension-subtab-help'));
		expect(screen.queryByTestId('first-party-body')).not.toBeInTheDocument();

		const base = {
			theme,
			contributions: null,
			busy: false,
			onTogglePlugin: vi.fn(),
			onToggleBuiltin: vi.fn(),
			onUninstall: vi.fn(),
			onRevoke: vi.fn(),
			getGrants: vi.fn(async () => ({ requested: [], granted: [] })),
		};
		rerender(<ExtensionDetails {...base} {...props} settingsRequest={{ flag: 'usageStats' }} />);
		expect(screen.getByTestId('extension-subtab-settings')).toHaveAttribute(
			'aria-selected',
			'true'
		);
		expect(screen.getByTestId('first-party-body')).toBeInTheDocument();
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

		// Disabled opens on Help; the Settings tab still exists, but its body
		// is gated behind the enable state - a hint takes its place.
		expect(screen.getByTestId('extension-subtab-help')).toHaveAttribute('aria-selected', 'true');
		fireEvent.click(screen.getByTestId('extension-subtab-settings'));
		expect(screen.getByTestId('extension-settings-disabled-hint')).toHaveTextContent(
			'Enable this plugin to configure it.'
		);
		expect(screen.queryByTestId('first-party-body')).not.toBeInTheDocument();
	});
});

describe('ExtensionDetails sub-tabs - non-configurable tile', () => {
	it('opens on Help when there is nothing to configure, enabled or not', () => {
		// directorNotes with NO settingsBody: not configurable, so the Settings
		// tab is absent and the pane opens on its guide either way.
		for (const enabled of [false, true]) {
			const view = renderDetails({ ext: builtinTile('directorNotes', enabled) });
			expect(screen.queryByTestId('extension-subtab-settings')).not.toBeInTheDocument();
			expect(screen.getByTestId('extension-subtab-help')).toHaveAttribute('aria-selected', 'true');
			expect(screen.getByTestId('extension-usage-guide')).toBeInTheDocument();
			fireEvent.click(screen.getByTestId('extension-subtab-permissions'));
			expect(screen.getAllByTestId('extension-permission').length).toBeGreaterThan(0);
			view.unmount();
		}
	});
});

describe('ExtensionDetails header - Enable switch', () => {
	it('puts the switch in the header and reports its state as a switch', () => {
		const onToggleBuiltin = vi.fn();
		renderDetails({ ext: builtinTile('directorNotes', false), onToggleBuiltin });

		const toggle = screen.getByTestId('extension-enable-toggle');
		expect(toggle).toHaveAttribute('role', 'switch');
		expect(toggle).toHaveAttribute('aria-checked', 'false');
		expect(screen.getByTestId('extension-details-state')).toHaveTextContent('Disabled');
		// It sits above the description and the tab strip, not below them.
		const tablist = screen.getByRole('tablist');
		expect(toggle.compareDocumentPosition(tablist) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

		fireEvent.click(toggle);
		expect(onToggleBuiltin).toHaveBeenCalledExactlyOnceWith('directorNotes');
	});

	it('the Help tab selects the guide from any other tab, with no separate header button', () => {
		renderDetails({ ext: builtinTile('usageStats', true), settingsBody: SETTINGS_BODY });
		expect(screen.getByTestId('extension-subtab-settings')).toHaveAttribute(
			'aria-selected',
			'true'
		);
		// The tab strip is the only way to the guide; a header "?" duplicated it.
		expect(screen.queryByTestId('extension-help-button')).not.toBeInTheDocument();

		fireEvent.click(screen.getByTestId('extension-subtab-help'));
		expect(screen.getByTestId('extension-subtab-help')).toHaveAttribute('aria-selected', 'true');
		expect(screen.getByTestId('extension-usage-guide')).toBeInTheDocument();
	});

	it('flipping the switch keeps the user on the tab they chose', () => {
		const view = renderDetails({
			ext: builtinTile('usageStats', false),
			settingsBody: SETTINGS_BODY,
		});
		expect(screen.getByTestId('extension-subtab-help')).toHaveAttribute('aria-selected', 'true');

		view.rerender(
			<ExtensionDetails
				theme={theme}
				ext={builtinTile('usageStats', true)}
				contributions={null}
				busy={false}
				onTogglePlugin={vi.fn()}
				onToggleBuiltin={vi.fn()}
				onUninstall={vi.fn()}
				onRevoke={vi.fn()}
				getGrants={vi.fn(async () => ({ requested: [], granted: [] }))}
				settingsBody={SETTINGS_BODY}
			/>
		);
		expect(screen.getByTestId('extension-subtab-help')).toHaveAttribute('aria-selected', 'true');
		expect(screen.getByTestId('extension-details-state')).toHaveTextContent('Enabled');
	});

	it('says so on the Help tab for a plugin that ships no guide', () => {
		renderDetails({ ext: pluginTile('plugin-a') });
		fireEvent.click(screen.getByTestId('extension-subtab-help'));
		expect(screen.getByTestId('extension-help-missing')).toBeInTheDocument();
	});
});

describe('ExtensionDetails sub-tabs - Pianola', () => {
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

	it('closes Settings when Open Pianola is clicked, so the modal is not hidden behind it', () => {
		useModalStore.getState().closeAll();
		useModalStore.getState().openModal('settings', { tab: 'general' });
		renderDetails({ ext: builtinTile('pianola', true) });

		fireEvent.click(screen.getByTestId('extension-open-pianola'));

		// Settings is the topmost modal, so it MUST be gone before Pianola shows.
		expect(useModalStore.getState().isOpen('settings')).toBe(false);
		expect(useModalStore.getState().isOpen('pianolaModal')).toBe(true);
	});

	it('shows the disabled hint on the Settings tab when Pianola is off', () => {
		renderDetails({ ext: builtinTile('pianola', false) });
		fireEvent.click(screen.getByTestId('extension-subtab-settings'));

		expect(screen.queryByTestId('extension-open-pianola')).not.toBeInTheDocument();
		expect(screen.getByTestId('extension-settings-disabled-hint')).toHaveTextContent(
			'Enable Pianola to open its manager and rules.'
		);
	});
});

describe('ExtensionDetails sub-tabs - plugin Configure (grant + edit)', () => {
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

describe('ExtensionDetails - plugin settings panels', () => {
	const panel = (pluginId: string): PanelContribution => ({
		id: `${pluginId}/config`,
		localId: 'config',
		pluginId,
		title: `${pluginId} config`,
		entry: 'panel.html',
		placement: 'settings',
		size: 'default',
	});
	const contributions = (panels: PanelContribution[]): AggregatedContributions => ({
		...contributionsWith(),
		panels,
	});
	const granted = { requested: [], granted: [{ capability: 'ui:panel' as const, grantedAt: 1 }] };

	it('shows only the owning plugin settings link and keeps management free of executable content', async () => {
		const { container } = renderDetails({
			ext: pluginTile('plugin-a', true),
			contributions: contributions([panel('plugin-a'), panel('plugin-b')]),
			getGrants: vi.fn(async () => granted),
		});
		expect(screen.getByTestId('extension-subtab-settings')).toHaveAttribute(
			'aria-selected',
			'true'
		);
		expect(container.querySelector('webview')).toBeNull();
		await waitFor(() =>
			expect(screen.getByRole('button', { name: 'Open plugin-a config' })).toBeEnabled()
		);
		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: 'Open plugin-a config' }));
		});
		expect(useModalStore.getState().getData('settings')).toMatchObject({
			tab: 'encore',
			settingId: 'plugin-settings:plugin-a/config',
		});
		expect(screen.queryByText('plugin-b config')).not.toBeInTheDocument();
		expect(screen.getByTestId('extension-revoke')).toBeInTheDocument();
		expect(screen.getByTestId('extension-uninstall')).toBeInTheDocument();
	});

	it('offers a local update for plugins, including disabled ones', () => {
		const onUpdate = vi.fn();
		const plugin = pluginTile('plugin-a');
		plugin.record = { ...plugin.record!, enabled: false };
		plugin.state = 'installed';
		renderDetails({ ext: plugin, onUpdate });

		fireEvent.click(screen.getByTestId('extension-update'));
		expect(onUpdate).toHaveBeenCalledExactlyOnceWith(plugin.record);
		expect(screen.getByTestId('extension-uninstall')).toBeInTheDocument();
	});

	it('keeps a disabled installed panel discoverable without mounting plugin content', async () => {
		const plugin = pluginTile('plugin-a', true);
		plugin.state = 'installed';
		plugin.record = { ...plugin.record!, enabled: false };
		const onTogglePlugin = vi.fn();
		const { container } = renderDetails({
			ext: plugin,
			contributions: contributions([]),
			getGrants: vi.fn(async () => granted),
			onTogglePlugin,
		});
		await waitFor(() =>
			expect(screen.getByTestId('extension-subtab-settings')).toBeInTheDocument()
		);
		fireEvent.click(screen.getByTestId('extension-subtab-settings'));
		expect(screen.getByTestId('extension-plugin-settings-status')).toHaveTextContent(
			'Select Enable to review permissions for this version'
		);
		expect(container.querySelector('webview')).toBeNull();
		fireEvent.click(screen.getByTestId('extension-enable-toggle'));
		expect(onTogglePlugin).toHaveBeenCalledExactlyOnceWith(plugin.record);
	});

	it('keeps the settings link disabled until the owning plugin is enabled', async () => {
		const disabled = pluginTile('plugin-a', true);
		disabled.state = 'installed';
		disabled.record = { ...disabled.record!, enabled: false };
		let grantedNow = false;
		const getGrants = vi.fn(async () => (grantedNow ? granted : { requested: [], granted: [] }));
		const props = {
			theme,
			ext: disabled,
			contributions: contributions([]),
			busy: false,
			onTogglePlugin: vi.fn(),
			onToggleBuiltin: vi.fn(),
			onUninstall: vi.fn(),
			onRevoke: vi.fn(),
			getGrants,
		};
		const view = render(<ExtensionDetails {...props} />);
		fireEvent.click(screen.getByTestId('extension-subtab-settings'));
		expect(view.container.querySelector('webview')).toBeNull();
		const enabled = pluginTile('plugin-a', true);
		view.rerender(<ExtensionDetails {...props} ext={enabled} />);
		expect(view.container.querySelector('webview')).toBeNull();
		grantedNow = true;
		view.rerender(
			<ExtensionDetails
				{...props}
				ext={enabled}
				contributions={contributions([panel('plugin-a')])}
				getGrants={vi.fn(async () => granted)}
			/>
		);
		expect(view.container.querySelector('webview')).toBeNull();
		await waitFor(() =>
			expect(screen.getByRole('button', { name: 'Open plugin-a config' })).toBeEnabled()
		);
	});

	it.each(['no-grant', 'untrusted', 'inactive'] as const)(
		'keeps declared Settings links disabled when the live destination is %s',
		async (reason) => {
			useModalStore.getState().closeModal('settings');
			const plugin = pluginTile('plugin-a', true);
			if (reason === 'untrusted') plugin.record!.signature = { status: 'unknown' };
			renderDetails({
				ext: plugin,
				contributions: contributions(reason === 'inactive' ? [] : [panel('plugin-a')]),
				getGrants: vi.fn(async () =>
					reason === 'no-grant' ? { requested: [], granted: [] } : granted
				),
			});
			await act(async () => {});
			const open = screen.getByRole('button', { name: 'Open plugin-a config' });
			expect(open).toBeDisabled();
			fireEvent.click(open);
			expect(useModalStore.getState().isOpen('settings')).toBe(false);
		}
	);

	it('discovers a disabled declarative setting, but not an unrelated settings-less plugin', () => {
		const plugin = pluginTile('plugin-a');
		plugin.state = 'installed';
		plugin.record = {
			...plugin.record!,
			enabled: false,
			manifest: {
				...plugin.record!.manifest!,
				contributes: {
					settings: [{ id: 'enabled', key: 'enabled', type: 'boolean', default: false }],
				},
			},
		};
		const view = renderDetails({ ext: plugin, contributions: contributions([]) });
		fireEvent.click(screen.getByTestId('extension-subtab-settings'));
		expect(screen.getByTestId('extension-plugin-settings-status')).toBeInTheDocument();
		view.rerender(
			<ExtensionDetails
				{...{
					theme,
					ext: pluginTile('plugin-b'),
					contributions: contributions([]),
					busy: false,
					onTogglePlugin: vi.fn(),
					onToggleBuiltin: vi.fn(),
					onUninstall: vi.fn(),
					onRevoke: vi.fn(),
					getGrants: vi.fn(async () => ({ requested: [], granted: [] })),
				}}
			/>
		);
		expect(screen.queryByTestId('extension-subtab-settings')).not.toBeInTheDocument();
	});

	it('does not discover or mount panels from unloadable or invalid packages', () => {
		for (const change of [
			{ loadStatus: 'incompatible' as const },
			{ loadStatus: 'invalid' as const, manifest: null },
			{ signature: { status: 'invalid' as const } },
		]) {
			const plugin = pluginTile('plugin-a', true);
			plugin.state = 'installed';
			plugin.record = { ...plugin.record!, enabled: false, ...change };
			plugin.loadStatus = plugin.record.loadStatus;
			plugin.trust = plugin.record.signature?.status;
			const view = renderDetails({ ext: plugin, contributions: contributions([]) });
			expect(screen.queryByTestId('extension-subtab-settings')).not.toBeInTheDocument();
			expect(view.container.querySelector('webview')).toBeNull();
			view.unmount();
		}
	});

	it('does not offer a local update for built-in features', () => {
		renderDetails({ ext: builtinTile('usageStats', true), onUpdate: vi.fn() });
		expect(screen.queryByTestId('extension-update')).not.toBeInTheDocument();
	});

	it('keeps contributed setting controls beside a plugin settings panel', async () => {
		const pluginId = 'plugin-a';
		renderDetails({
			ext: pluginTile(pluginId, true),
			contributions: {
				...contributions([panel(pluginId)]),
				settings: [
					{
						id: `${pluginId}:enabled`,
						localId: 'enabled',
						pluginId,
						key: 'enabled',
						type: 'boolean',
						default: false,
					},
				],
			},
			getGrants: vi.fn(async () => granted),
		});
		expect(screen.getByRole('button', { name: 'Open plugin-a config' })).toBeInTheDocument();
		expect(screen.getByTestId('extension-configure')).toBeInTheDocument();
	});
});

describe('ExtensionDetails sub-tabs - removed action-row affordances', () => {
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

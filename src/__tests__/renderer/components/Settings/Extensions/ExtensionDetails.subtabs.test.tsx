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
import type { PluginRegistry } from '../../../../../shared/plugins/plugin-registry';
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
		// behind the enable state - a hint takes its place.
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

describe('ExtensionDetails sub-tabs - non-configurable tile', () => {
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

	it('shows Settings for a panel-only plugin and mounts only its own isolated panel', async () => {
		const { container } = renderDetails({
			ext: pluginTile('plugin-a', true),
			contributions: contributions([panel('plugin-a'), panel('plugin-b')]),
			getGrants: vi.fn(async () => granted),
		});
		expect(screen.getByTestId('extension-subtab-settings')).toHaveAttribute(
			'aria-selected',
			'true'
		);
		await waitFor(() => expect(container.querySelector('webview')).not.toBeNull());
		expect(container.querySelectorAll('webview')).toHaveLength(1);
		expect(container.querySelector('webview')?.getAttribute('partition')).toBe('plugin:plugin-a');
		expect(container.querySelector('webview')?.getAttribute('src')).toBe(
			'plugin-panel://panel/plugin-a%2Fconfig'
		);
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
		expect(screen.getByTestId('extension-plugin-settings-status')).toHaveTextContent(
			'Select Enable to review permissions for this version'
		);
		expect(container.querySelector('webview')).toBeNull();
		fireEvent.click(screen.getByTestId('extension-enable-toggle'));
		expect(onTogglePlugin).toHaveBeenCalledExactlyOnceWith(plugin.record);
	});

	it('mounts the declared panel only after consent enables it and active contributions arrive', async () => {
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
		await waitFor(() => expect(view.container.querySelectorAll('webview')).toHaveLength(1));
	});

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
		expect(screen.getByTestId('extension-subtab-settings')).toBeInTheDocument();
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
		await waitFor(() =>
			expect(screen.getByTestId('extension-plugin-settings-panels')).toBeInTheDocument()
		);
		expect(screen.getByTestId('extension-configure')).toBeInTheDocument();
	});

	it('detaches the panel when disabled or revoked', async () => {
		const props = {
			ext: pluginTile('plugin-a', true),
			contributions: contributions([panel('plugin-a')]),
			getGrants: vi.fn(async () => granted),
			onRevoke: vi.fn(),
		};
		const view = renderDetails(props);
		await waitFor(() => expect(view.container.querySelector('webview')).not.toBeNull());
		fireEvent.click(screen.getByTestId('extension-revoke'));
		expect(view.container.querySelector('webview')).toBeNull();
		expect(props.onRevoke).toHaveBeenCalledWith('plugin-a');

		const disabled = { ...pluginTile('plugin-a', true), state: 'installed' as const };
		view.rerender(
			<ExtensionDetails
				{...{
					theme,
					ext: disabled,
					contributions: props.contributions,
					busy: false,
					onTogglePlugin: vi.fn(),
					onToggleBuiltin: vi.fn(),
					onUninstall: vi.fn(),
					onRevoke: vi.fn(),
					getGrants: props.getGrants,
				}}
			/>
		);
		expect(view.container.querySelector('webview')).toBeNull();
	});

	it('does not mount a panel when ui:panel was never granted', async () => {
		const { container } = renderDetails({
			ext: pluginTile('plugin-a', true),
			contributions: contributions([panel('plugin-a')]),
			getGrants: vi.fn(async () => ({ requested: [], granted: [] })),
		});
		await waitFor(() =>
			expect(screen.getByTestId('extension-subtab-settings')).toBeInTheDocument()
		);
		expect(container.querySelector('webview')).toBeNull();
		expect(screen.getByTestId('extension-plugin-settings-status')).toHaveTextContent(
			'without current ui:panel permission'
		);
	});

	it('keeps a disabled plugin panel detached when a stale grants request resolves', async () => {
		let changed: ((registry?: PluginRegistry) => void) | undefined;
		const subscription = vi.spyOn(window.maestro.plugins, 'onChanged').mockImplementation((cb) => {
			changed = cb;
			return () => {};
		});
		let resolveRefresh!: (value: typeof granted) => void;
		const refresh = new Promise<typeof granted>((resolve) => {
			resolveRefresh = resolve;
		});
		const getGrants = vi.fn().mockResolvedValueOnce(granted).mockReturnValueOnce(refresh);
		try {
			const { container } = renderDetails({
				ext: pluginTile('plugin-a', true),
				contributions: contributions([panel('plugin-a')]),
				getGrants,
			});
			await waitFor(() => expect(container.querySelector('webview')).not.toBeNull());
			act(() => changed?.({ records: [pluginRecord('plugin-a', true)] }));
			expect(getGrants).toHaveBeenCalledTimes(2);
			act(() => {
				changed?.({ records: [{ ...pluginRecord('plugin-a', true), enabled: false }] });
			});
			expect(container.querySelector('webview')).toBeNull();
			await act(async () => resolveRefresh(granted));
			expect(container.querySelector('webview')).toBeNull();
		} finally {
			subscription.mockRestore();
		}
	});

	it('keeps an authorized panel mounted during an unrelated registry refresh', async () => {
		let changed: ((registry?: PluginRegistry) => void) | undefined;
		const subscription = vi.spyOn(window.maestro.plugins, 'onChanged').mockImplementation((cb) => {
			changed = cb;
			return () => {};
		});
		let resolveRefresh!: (value: typeof granted) => void;
		const refresh = new Promise<typeof granted>((resolve) => {
			resolveRefresh = resolve;
		});
		const getGrants = vi.fn().mockResolvedValueOnce(granted).mockReturnValueOnce(refresh);
		try {
			const { container } = renderDetails({
				ext: pluginTile('plugin-a', true),
				contributions: contributions([panel('plugin-a')]),
				getGrants,
			});
			await waitFor(() => expect(container.querySelector('webview')).not.toBeNull());
			const mountedPanel = container.querySelector('webview');
			act(() => changed?.({ records: [pluginRecord('plugin-a', true), pluginRecord('plugin-b')] }));
			expect(getGrants).toHaveBeenCalledTimes(2);
			expect(container.querySelector('webview')).toBe(mountedPanel);
			await act(async () => resolveRefresh(granted));
			expect(container.querySelector('webview')).toBe(mountedPanel);
		} finally {
			subscription.mockRestore();
		}
	});

	it('never shows the previous plugin panel while switching selections', async () => {
		let resolveB: (value: typeof granted) => void = () => {};
		const pendingB = new Promise<typeof granted>((resolve) => {
			resolveB = resolve;
		});
		const getGrants = vi.fn((id: string) =>
			id === 'plugin-a' ? Promise.resolve(granted) : pendingB
		);
		const props = {
			theme,
			ext: pluginTile('plugin-a', true),
			contributions: contributions([panel('plugin-a'), panel('plugin-b')]),
			busy: false,
			onTogglePlugin: vi.fn(),
			onToggleBuiltin: vi.fn(),
			onUninstall: vi.fn(),
			onRevoke: vi.fn(),
			getGrants,
		};
		const view = render(<ExtensionDetails {...props} />);
		await waitFor(() => expect(view.container.querySelector('webview')).not.toBeNull());
		view.rerender(<ExtensionDetails {...props} ext={pluginTile('plugin-b', true)} />);
		expect(view.container.querySelector('webview')).toBeNull();
		await act(async () => {
			resolveB(granted);
		});
		await waitFor(() =>
			expect(view.container.querySelector('webview')?.getAttribute('partition')).toBe(
				'plugin:plugin-b'
			)
		);
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

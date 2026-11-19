// Source: src/__tests__/renderer/components/Settings/Extensions/ExtensionDetails.trust.test.tsx
// Source: src/__tests__/renderer/components/Settings/Extensions/ExtensionDetails.firstPartyServices.test.tsx
// Source: src/__tests__/renderer/components/Settings/Extensions/ExtensionDetails.subtabs.test.tsx
// Source: src/__tests__/renderer/components/Settings/Extensions/ExtensionDetails.usageGuide.test.tsx
import { describe as describeSourceSuite } from 'vitest';
import { cleanup } from '@testing-library/react';
import { render } from '@testing-library/react';
import { screen } from '@testing-library/react';
import { afterEach } from 'vitest';
import { describe } from 'vitest';
import { expect } from 'vitest';
import { it } from 'vitest';
import { vi } from 'vitest';
import React from 'react';
import { ExtensionDetails } from '../../../../../renderer/components/Settings/Extensions/ExtensionDetails';
import type { ExtensionTrust } from '../../../../../renderer/components/Settings/Extensions/extensionModel';
import type { UnifiedExtension } from '../../../../../renderer/components/Settings/Extensions/extensionModel';
import type { PluginRecord } from '../../../../../shared/plugins/plugin-registry';
import type { Theme } from '../../../../../renderer/types';
import { fireEvent } from '@testing-library/react';
import { BUILTIN_FEATURES } from '../../../../../renderer/components/Settings/Extensions/extensionModel';
import { builtinExtension } from '../../../../../renderer/components/Settings/Extensions/extensionModel';
import type { EncoreFeatureFlags } from '../../../../../renderer/types';
import { act } from '@testing-library/react';
import { waitFor } from '@testing-library/react';
import { useModalStore } from '../../../../../renderer/stores/modalStore';
import type { AggregatedContributions } from '../../../../../shared/plugins/contributions';
import type { PanelContribution } from '../../../../../shared/plugins/contributions';
import type { SettingContribution } from '../../../../../shared/plugins/contributions';
import { beforeEach } from 'vitest';
import { CONCERTO_FIRST_PARTY_PLUGIN } from '../../../../../shared/plugins/first-party';
import { FIRST_PARTY_PLUGIN_DEFINITIONS } from '../../../../../shared/plugins/first-party';
import { PIANOLA_FIRST_PARTY_PLUGIN } from '../../../../../shared/plugins/first-party';
import { useSettingsStore } from '../../../../../renderer/stores/settingsStore';
import { DEFAULT_SHORTCUTS } from '../../../../../renderer/constants/shortcuts';
import { formatShortcutKeys } from '../../../../../renderer/utils/shortcutFormatter';
describeSourceSuite('ExtensionDetails.trust', () => {
	const theme = {
		colors: {
			textMain: '#eee',
			textDim: '#999',
			bgMain: '#111',
			accent: '#4af',
			border: '#333',
			warning: '#fa0',
			error: '#f44',
			success: '#4f4',
		},
	} as unknown as Theme;

	function record(id: string): PluginRecord {
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

	function ext(trust: ExtensionTrust | undefined): UnifiedExtension {
		return {
			key: 'plugin:demo',
			kind: 'plugin',
			id: 'demo',
			name: 'Demo Plugin',
			description: 'A demo.',
			category: 'automation',
			state: 'enabled',
			tier: 1,
			trust,
			version: '1.0.0',
			loadStatus: 'ok',
			record: record('demo'),
		} as UnifiedExtension;
	}

	function renderDetails(trust: ExtensionTrust | undefined): void {
		render(
			<ExtensionDetails
				theme={theme}
				ext={ext(trust)}
				contributions={null}
				busy={false}
				onTogglePlugin={vi.fn()}
				onToggleBuiltin={vi.fn()}
				onUninstall={vi.fn()}
				onRevoke={vi.fn()}
				getGrants={vi.fn(async () => ({ requested: [], granted: [] }))}
			/>
		);
	}

	afterEach(cleanup);

	describe('ExtensionDetails trust-gate surfacing (FC1)', () => {
		it('unsigned code plugin: explains code will not run but declarative contributions apply', () => {
			renderDetails('unsigned');
			const note = screen.getByTestId('extension-code-disabled');
			expect(note.textContent).toContain('trusted signature');
			expect(note.textContent).toContain('unsigned');
			expect(note.textContent).toContain('declarative contributions');
		});

		it('untrusted code plugin: names the untrusted key as the reason', () => {
			renderDetails('untrusted');
			const note = screen.getByTestId('extension-code-disabled');
			expect(note.textContent).toContain('untrusted key');
		});

		it('invalid (tampered) plugin: fully-disabled copy, no "contributions still apply" claim', () => {
			renderDetails('invalid');
			const note = screen.getByTestId('extension-code-disabled');
			expect(note.textContent).toContain('tampered');
			expect(note.textContent).toContain('fully');
			expect(note.textContent).not.toContain('still apply');
		});

		it('trusted plugin: no gate message rendered', () => {
			renderDetails('trusted');
			expect(screen.queryByTestId('extension-code-disabled')).toBeNull();
		});
	});
});
describeSourceSuite('ExtensionDetails.firstPartyServices', () => {
	const theme = {
		colors: {
			textMain: '#eee',
			textDim: '#999',
			bgMain: '#111',
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

	function renderBuiltin(flag: keyof EncoreFeatureFlags, enabled: boolean): void {
		const def = BUILTIN_FEATURES.find((f) => f.flag === flag);
		if (!def) throw new Error(`no builtin feature for flag ${flag}`);
		render(
			<ExtensionDetails
				theme={theme}
				ext={builtinExtension(def, flags({ [flag]: enabled }))}
				contributions={null}
				busy={false}
				onTogglePlugin={vi.fn()}
				onToggleBuiltin={vi.fn()}
				onUninstall={vi.fn()}
				onRevoke={vi.fn()}
				getGrants={vi.fn(async () => ({ requested: [], granted: [] }))}
			/>
		);
		// Background services + permission disclosure live under the Permissions
		// sub-tab. Tiles with a Settings tab (e.g. Pianola) open on Settings, so
		// select Permissions explicitly; for Permissions-only tiles this is a no-op.
		fireEvent.click(screen.getByTestId('extension-subtab-permissions'));
	}

	afterEach(cleanup);

	describe('ExtensionDetails first-party background services', () => {
		it('shows pianola.supervisor as Running (supervised) when the feature is enabled', () => {
			renderBuiltin('pianola', true);
			const row = screen.getByTestId('extension-background-service');
			expect(row.getAttribute('data-service')).toBe('pianola.supervisor');
			expect(screen.getByTestId('extension-background-service-status').textContent).toBe(
				'Running (supervised)'
			);
		});

		it('shows pianola.supervisor as Stopped when the feature is disabled', () => {
			renderBuiltin('pianola', false);
			expect(screen.getByTestId('extension-background-service-status').textContent).toBe('Stopped');
		});

		it('renders no background-service section for a first-party feature without services', () => {
			// Symphony's definition declares no background services.
			renderBuiltin('symphony', true);
			expect(screen.queryByTestId('extension-background-service')).toBeNull();
		});
	});

	describe('ExtensionDetails first-party permission disclosure', () => {
		it('renders one row per declared permission, labeled "Granted on enable"', () => {
			renderBuiltin('directorNotes', false);
			const def = BUILTIN_FEATURES.find((f) => f.flag === 'directorNotes')!;
			const rows = screen.getAllByTestId('extension-permission');
			expect(rows).toHaveLength(def.pluginBacking.permissions.length);
			const caps = rows.map((r) => r.getAttribute('data-cap'));
			expect(caps).toEqual(def.pluginBacking.permissions.map((p) => p.capability));
			for (const status of screen.getAllByTestId('extension-permission-status')) {
				expect(status.textContent).toBe('Granted on enable');
			}
		});

		it('shows the declared reason text so disclosure is meaningful', () => {
			renderBuiltin('pianola', true);
			expect(screen.getByText(/Record Pianola decisions before any dispatch/i)).toBeInTheDocument();
		});

		it('never calls the grants IPC for a first-party tile (static disclosure)', () => {
			const def = BUILTIN_FEATURES.find((f) => f.flag === 'maestroCue')!;
			const getGrants = vi.fn(async () => ({ requested: [], granted: [] }));
			render(
				<ExtensionDetails
					theme={theme}
					ext={builtinExtension(def, flags({ maestroCue: true }))}
					contributions={null}
					busy={false}
					onTogglePlugin={vi.fn()}
					onToggleBuiltin={vi.fn()}
					onUninstall={vi.fn()}
					onRevoke={vi.fn()}
					getGrants={getGrants}
				/>
			);
			fireEvent.click(screen.getByTestId('extension-subtab-permissions'));
			expect(screen.getAllByTestId('extension-permission').length).toBeGreaterThan(0);
			expect(getGrants).not.toHaveBeenCalled();
		});
	});
});
describeSourceSuite('ExtensionDetails.subtabs', () => {
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
				expect(screen.getByTestId('extension-subtab-help')).toHaveAttribute(
					'aria-selected',
					'true'
				);
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
			expect(
				toggle.compareDocumentPosition(tablist) & Node.DOCUMENT_POSITION_FOLLOWING
			).toBeTruthy();

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
			expect(screen.getAllByRole('button', { name: 'Update from File…' })).toHaveLength(1);
			expect(screen.queryByTestId('extension-update-folder')).not.toBeInTheDocument();
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
});
describeSourceSuite('ExtensionDetails.usageGuide', () => {
	const theme = {
		colors: {
			textMain: '#eee',
			textDim: '#999',
			bgMain: '#111',
			bgSidebar: '#222',
			accent: '#4af',
			border: '#333',
			warning: '#fa0',
			error: '#f44',
			success: '#4f4',
		},
	} as unknown as Theme;

	function renderDetails(ext: UnifiedExtension): void {
		render(
			<ExtensionDetails
				theme={theme}
				ext={ext}
				contributions={null}
				busy={false}
				onTogglePlugin={vi.fn()}
				onToggleBuiltin={vi.fn()}
				onUninstall={vi.fn()}
				onRevoke={vi.fn()}
				getGrants={vi.fn(async () => ({ requested: [], granted: [] }))}
			/>
		);
	}

	/** The real Concerto tile, projected exactly as the grid projects it. */
	function concertoExtension(): UnifiedExtension {
		return builtinExtension(
			{ flag: 'concerto', beta: true, pluginBacking: CONCERTO_FIRST_PARTY_PLUGIN },
			{ concerto: true } as never
		);
	}

	afterEach(cleanup);

	describe('ExtensionDetails usage guide', () => {
		beforeEach(() => {
			useSettingsStore.setState({ shortcuts: { ...DEFAULT_SHORTCUTS } as never });
		});

		it('tells the user how to open the feature, not just what it is', () => {
			renderDetails(concertoExtension());

			const guide = screen.getByTestId('extension-usage-guide');
			expect(guide.textContent).toContain('Concerto stage');
			// All three ways in are named.
			expect(guide.textContent).toContain('Command palette');
			expect(guide.textContent).toContain('Concerto Stage');
			expect(guide.textContent).toContain('hamburger menu');
		});

		it('prints the live binding, so a rebound key is never advertised stale', () => {
			useSettingsStore.setState({
				shortcuts: {
					...DEFAULT_SHORTCUTS,
					toggleConcerto: {
						id: 'toggleConcerto',
						label: 'Show/Hide Concerto Stage',
						keys: ['Meta', '9'],
					},
				} as never,
			});

			renderDetails(concertoExtension());

			// The keycap shows the rebound key, and the shipped default is gone.
			const keycap = screen.getByText(formatShortcutKeys(['Meta', '9']));
			expect(keycap).toBeInTheDocument();
			expect(
				screen.queryByText(formatShortcutKeys(DEFAULT_SHORTCUTS.toggleConcerto.keys))
			).toBeNull();
		});

		it('shows what an agent types to drive it', () => {
			renderDetails(concertoExtension());

			expect(screen.getByTestId('extension-usage-agent').textContent).toContain(
				'maestro-cli movement add'
			);
		});

		it('says so, instead of an empty tab, for an extension with no guide', () => {
			const bare = { ...concertoExtension(), usage: undefined };
			renderDetails(bare);

			expect(screen.queryByTestId('extension-usage-guide')).toBeNull();
			expect(screen.getByTestId('extension-help-missing')).toHaveTextContent(
				'does not ship a usage guide'
			);
		});

		// `usage` is required on the type; this pins that no definition dodges it
		// with an empty guide.
		it.each(FIRST_PARTY_PLUGIN_DEFINITIONS.map((d) => [d.name, d] as const))(
			'%s ships a guide with an overview',
			(_name, def) => {
				expect(def.usage.overview.length).toBeGreaterThan(0);
				for (const paragraph of def.usage.overview) expect(paragraph.trim()).not.toBe('');
			}
		);
	});

	/**
	 * Pianola is the guide's other shape: a feature with no hotkey that takes
	 * several actions to set up, and whose guard rails have to be readable BEFORE
	 * someone switches it on. Those two sections (`steps`, `notes`) are optional,
	 * so Concerto above also pins that a feature without them draws neither.
	 */
	describe('ExtensionDetails usage guide - walkthrough and guard rails', () => {
		beforeEach(() => {
			useSettingsStore.setState({ shortcuts: { ...DEFAULT_SHORTCUTS } as never });
		});

		function pianolaExtension(enabled = true): UnifiedExtension {
			return builtinExtension({ flag: 'pianola', pluginBacking: PIANOLA_FIRST_PARTY_PLUGIN }, {
				pianola: enabled,
			} as never);
		}

		it('numbers the setup walkthrough in the order the definition lists it', () => {
			// Enabled Pianola opens on Settings; the guide is one click away.
			renderDetails(pianolaExtension());
			fireEvent.click(screen.getByTestId('extension-subtab-help'));

			const steps = screen.getByTestId('extension-usage-steps');
			const titles = PIANOLA_FIRST_PARTY_PLUGIN.usage!.steps!.map((s) => s.title);
			for (const title of titles) expect(steps.textContent).toContain(title);
			// Rendered as a real ordered list, so the numbering is the browser's.
			expect(steps.tagName).toBe('OL');
			expect(steps.querySelectorAll('li')).toHaveLength(titles.length);
		});

		it('states the guard rails before the user enables anything', () => {
			// Disabled opens straight on Help, so the guard rails are the first read.
			renderDetails(pianolaExtension(false));

			const notes = screen.getByTestId('extension-usage-notes').textContent ?? '';
			expect(notes).toContain('High-risk prompts ALWAYS escalate');
			expect(notes.toLowerCase()).toContain('no matching rule means escalate');
		});

		it('draws neither section for a guide that omits them', () => {
			// Concerto ships overview + access + agentCommands and no walkthrough.
			renderDetails(concertoExtension());

			expect(screen.queryByTestId('extension-usage-steps')).toBeNull();
			expect(screen.queryByTestId('extension-usage-notes')).toBeNull();
		});
	});
});

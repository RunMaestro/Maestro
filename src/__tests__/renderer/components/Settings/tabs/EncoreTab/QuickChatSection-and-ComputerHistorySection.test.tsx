// Source: src/__tests__/renderer/components/Settings/tabs/EncoreTab/QuickChatSection.test.tsx
// Source: src/__tests__/renderer/components/Settings/tabs/EncoreTab/ComputerHistorySection.test.tsx
// Source: src/__tests__/renderer/components/Settings/tabs/EncoreTab/DataviewSection.test.tsx
// Source: src/__tests__/renderer/components/Settings/tabs/EncoreTab/MaestroRunSection.test.tsx
// Source: src/__tests__/renderer/components/Settings/tabs/EncoreTab/PianolaSection.test.tsx
// Source: src/__tests__/renderer/components/Settings/tabs/EncoreTab/ThroughputGaugeSection.test.tsx
import { describe as describeSourceSuite } from 'vitest';
import { fireEvent } from '@testing-library/react';
import { render } from '@testing-library/react';
import { screen } from '@testing-library/react';
import { describe } from 'vitest';
import { expect } from 'vitest';
import { it } from 'vitest';
import { vi } from 'vitest';
import { QuickChatSection } from '../../../../../../renderer/components/Settings/tabs/EncoreTab/components';
import { DEFAULT_QUICK_CHAT_SETTINGS } from '../../../../../../shared/quickChat';
import { mockTheme } from '../../../../../helpers/mockTheme';
import React from 'react';
import { act } from '@testing-library/react';
import { waitFor } from '@testing-library/react';
import { afterEach } from 'vitest';
import { beforeEach } from 'vitest';
import { ComputerHistorySection } from '../../../../../../renderer/components/Settings/tabs/EncoreTab/components';
import { useSettingsStore } from '../../../../../../renderer/stores/settingsStore';
import { useModalStore } from '../../../../../../renderer/stores/modalStore';
import { defaultComputerHistoryConfig } from '../../../../../../shared/computer-history/config';
import { DataviewSection } from '../../../../../../renderer/components/Settings/tabs/EncoreTab/components';
import { useNotificationStore } from '../../../../../../renderer/stores/notificationStore';
import { MaestroRunSection } from '../../../../../../renderer/components/Settings/tabs/EncoreTab/components';
import type { MaestroRunStatus } from '../../../../../../shared/maestro-run/status';
import { PianolaSection } from '../../../../../../renderer/components/Settings/tabs/EncoreTab/components';
import { loadAllSettings } from '../../../../../../renderer/stores/settingsStore';
import { resetStores } from '../../../../../helpers/resetStores';
import { within } from '@testing-library/react';
import { ThroughputGaugeSection } from '../../../../../../renderer/components/Settings/tabs/EncoreTab/components';
import { useThroughputGaugeStore } from '../../../../../../renderer/stores/throughputGaugeStore';
import { DEFAULT_THROUGHPUT_GAUGE_SETTINGS } from '../../../../../../shared/throughputGauge';
import { THROUGHPUT_GAUGE_SETTING_CONTROLS } from '../../../../../../shared/throughputGauge';
import type { ThroughputGaugeSettings } from '../../../../../../shared/throughputGauge';
import { installLocalStorageMock } from '../../../../../helpers/mockLocalStorage';
describeSourceSuite('QuickChatSection', () => {
	function renderSection(persistent = false) {
		render(
			<QuickChatSection
				theme={mockTheme}
				quickChatSettings={{ ...DEFAULT_QUICK_CHAT_SETTINGS, persistent }}
				setQuickChatSettings={vi.fn()}
			/>
		);
	}

	describe('QuickChatSection', () => {
		it('puts the hotkey capture beside its heading, not centered below it', () => {
			renderSection();
			const row = document.querySelector('[data-setting-id="encore-quick-chat-hotkey"]')!;
			// A horizontal row: exactly `flex`, never stacked with `flex-col`.
			expect(row.classList.contains('flex')).toBe(true);
			expect(row.classList.contains('flex-col')).toBe(false);
			// Heading block first, then the capture button in its own trailing column.
			expect(row.children).toHaveLength(2);
			expect(row.children[0].textContent).toContain('Hotkey');
			expect(row.children[1].querySelector('button')).not.toBeNull();
		});

		it('names the bookmark, not the pin, as the control that keeps an ephemeral chat', () => {
			renderSection(false);
			expect(screen.getByText(/The bookmark in the window keeps one\./)).toBeInTheDocument();
			expect(screen.queryByText(/pin in the window/)).toBeNull();
		});

		it('defaults to Choose tab, explains both options, and saves New tab when picked', () => {
			const setQuickChatSettings = vi.fn();
			render(
				<QuickChatSection
					theme={mockTheme}
					quickChatSettings={{ ...DEFAULT_QUICK_CHAT_SETTINGS }}
					setQuickChatSettings={setQuickChatSettings}
				/>
			);
			const group = screen.getByRole('radiogroup', { name: 'Quick Chat default tab' });
			expect(group.closest('[data-setting-id="encore-quick-chat-default-tab"]')).not.toBeNull();
			expect(screen.getByRole('radio', { name: /Choose tab/ })).toBeChecked();
			expect(screen.getByText(/Maestro finds the tab for the first message/)).toBeInTheDocument();
			expect(screen.getByText(/Every chat starts in a new tab/)).toBeInTheDocument();

			fireEvent.click(screen.getByRole('radio', { name: /New tab/ }));
			expect(setQuickChatSettings).toHaveBeenCalledWith({
				...DEFAULT_QUICK_CHAT_SETTINGS,
				defaultTab: 'new',
			});
		});
	});
});
describeSourceSuite('ComputerHistorySection', () => {
	function makeApi(
		platform: 'macos' | 'linux' | 'windows',
		helperStatus: Record<string, unknown> | null,
		appAccessibility: 'granted' | 'denied' | null = platform === 'macos' ? 'denied' : null
	) {
		const config = defaultComputerHistoryConfig();
		return {
			status: vi.fn(async () => ({
				enabled: true,
				running: true,
				appAccessibility,
				state: 'blocked',
				storeDir: '/data/computer-history',
				platform,
				pausedUntil: null,
				helper: { state: 'running', restarts: 0, binaryPath: '/x', recentStderr: [] },
				helperStatus,
				eventsStored: 3,
				eventsDropped: 0,
				lastEventAt: null,
				currentSegment: null,
			})),
			getConfig: vi.fn(async () => config),
			setConfig: vi.fn(async (patch: Record<string, unknown>) => ({ ...config, ...patch })),
			pause: vi.fn(async () => ({})),
			resume: vi.fn(async () => ({})),
			listRules: vi.fn(async () => ({
				rules: [],
				builtIn: ['com.maestro.app'],
				builtInApps: [{ label: 'Maestro', category: 'maestro' }],
			})),
			addRule: vi.fn(async () => ({
				rule: { id: 'r', match: 'app', value: 'com.apple.mobilesms' },
				matches: [] as Array<{ id: string; name?: string }>,
			})),
			removeRule: vi.fn(async () => null),
			clear: vi.fn(async () => ({ deletedSegments: 0, freedBytes: 0 })),
			requestAccessibility: vi.fn(async () => ({ platform, outcome: 'enabled' })),
			query: vi.fn(),
			knownApps: vi.fn(async () => [] as unknown[]),
			onStatusChanged: vi.fn(() => () => {}),
		};
	}

	let original: unknown;

	beforeEach(() => {
		original = (window.maestro as unknown as Record<string, unknown>).computerHistory;
		useSettingsStore.setState({
			encoreFeatures: { ...useSettingsStore.getState().encoreFeatures, computerHistory: true },
		});
	});
	afterEach(() => {
		(window.maestro as unknown as Record<string, unknown>).computerHistory = original;
		useModalStore.getState().closeModal('confirm');
	});

	function install(api: ReturnType<typeof makeApi>) {
		(window.maestro as unknown as Record<string, unknown>).computerHistory = api;
	}

	describe('ComputerHistorySection', () => {
		it('shows the recorder state and saves the snapshots toggle through the service', async () => {
			const api = makeApi('macos', {
				version: '0.1.0',
				platform: 'macos',
				state: 'blocked',
				permission: 'denied',
			});
			install(api);
			render(<ComputerHistorySection theme={mockTheme} />);
			expect(await screen.findByText('Waiting for permission')).toBeTruthy();
			fireEvent.click(await screen.findByText('Record visible window text'));
			await waitFor(() => expect(api.setConfig).toHaveBeenCalledWith({ snapshots: false }));
		});

		it('the status banner leads the panel and explains a missing recorder', async () => {
			const api = makeApi('macos', null, 'granted');
			const base = await api.status();
			api.status.mockResolvedValue({ ...base, state: 'binary-missing' });
			install(api);
			render(<ComputerHistorySection theme={mockTheme} />);
			expect(await screen.findByText('Recorder not installed')).toBeTruthy();
			const banner = screen.getByTestId('computer-history-status-banner');
			expect(banner.getAttribute('data-state')).toBe('binary-missing');
			expect(banner.textContent).toContain('maestro-computer-history');
			const panel = banner.parentElement!;
			expect(panel.firstElementChild).toBe(banner);
		});

		it('macOS: the permission button asks the service to show the prompt', async () => {
			const api = makeApi('macos', {
				version: '0.1.0',
				platform: 'macos',
				state: 'blocked',
				permission: 'denied',
			});
			install(api);
			render(<ComputerHistorySection theme={mockTheme} />);
			fireEvent.click(await screen.findByText('Request Accessibility access'));
			await waitFor(() => expect(api.requestAccessibility).toHaveBeenCalled());
		});

		it("macOS without a helper: follows Maestro's own grant and re-reads it on focus", async () => {
			const api = makeApi('macos', null, 'denied');
			const denied = await api.status();
			api.status.mockClear();
			install(api);
			render(<ComputerHistorySection theme={mockTheme} />);
			expect(await screen.findByText('Request Accessibility access')).toBeTruthy();

			// The user grants access in System Settings; no helper event follows.
			api.status.mockResolvedValue({ ...denied, appAccessibility: 'granted' });
			const readsBefore = api.status.mock.calls.length;
			act(() => {
				window.dispatchEvent(new Event('focus'));
			});
			await waitFor(() => expect(api.status.mock.calls.length).toBeGreaterThan(readsBefore));
			expect(await screen.findByText('Accessibility access is granted.')).toBeTruthy();
			expect(screen.queryByText('Request Accessibility access')).toBeNull();
		});

		it('Linux: turning on accessibility asks for consent first', async () => {
			const api = makeApi('linux', {
				version: '0.1.0',
				platform: 'linux',
				state: 'blocked',
				permission: 'not_required',
				accessibilityBus: 'disabled',
			});
			install(api);
			render(<ComputerHistorySection theme={mockTheme} />);
			fireEvent.click(await screen.findByText('Turn on accessibility'));
			expect(api.requestAccessibility).not.toHaveBeenCalled();
			const modal = useModalStore.getState().getData('confirm') as {
				onConfirm: () => void;
				message: string;
			};
			expect(modal.message).toContain('org.a11y.Status.IsEnabled');
			await act(async () => modal.onConfirm());
			await waitFor(() => expect(api.requestAccessibility).toHaveBeenCalled());
		});

		it('hosts the shared capture editor: adding an app by id writes an ignore rule', async () => {
			const api = makeApi('windows', null);
			install(api);
			render(<ComputerHistorySection theme={mockTheme} />);
			expect(await screen.findByTestId('computer-history-capture-editor')).toBeTruthy();
			const input = await screen.findByPlaceholderText(/Exclude an app by id or name/);
			fireEvent.change(input, { target: { value: 'com.apple.MobileSMS' } });
			fireEvent.keyDown(input, { key: 'Enter' });
			await waitFor(() =>
				expect(api.addRule).toHaveBeenCalledWith('app', 'com.apple.MobileSMS', 'ignore')
			);
		});

		it('clearing all history goes through a destructive confirm', async () => {
			const api = makeApi('windows', null);
			install(api);
			render(<ComputerHistorySection theme={mockTheme} />);
			fireEvent.click(await screen.findByText('Clear all history'));
			expect(api.clear).not.toHaveBeenCalled();
			const modal = useModalStore.getState().getData('confirm') as {
				onConfirm: () => void;
				destructive: boolean;
			};
			expect(modal.destructive).toBe(true);
			await act(async () => modal.onConfirm());
			await waitFor(() => expect(api.clear).toHaveBeenCalledWith({ all: true }));
		});

		it('the 6-hour roll-up toggle saves through the service', async () => {
			const api = makeApi('windows', null);
			api.getConfig.mockResolvedValue({
				...defaultComputerHistoryConfig(),
				digests: { enabled: true, agentId: null, rollup: true },
			});
			install(api);
			render(<ComputerHistorySection theme={mockTheme} />);
			fireEvent.click(await screen.findByText('6-hour roll-up'));
			await waitFor(() =>
				expect(api.setConfig).toHaveBeenCalledWith({ digests: { rollup: false } })
			);
		});
	});
});
describeSourceSuite('DataviewSection', () => {
	describe('DataviewSection', () => {
		beforeEach(() => {
			useSettingsStore.setState({ dataviewJsEnabled: false, dataviewJsTrustedRoots: [] });
			window.maestro.settings.set = vi.fn();
		});

		it('anchors the tile and both DataviewJS settings for search', () => {
			render(<DataviewSection theme={mockTheme} />);
			const root = document.querySelector('[data-setting-id="encore-dataview"]');
			expect(root).not.toBeNull();
			expect(root!.querySelector('[data-setting-id="encore-dataview-js"]')).not.toBeNull();
			expect(
				root!.querySelector('[data-setting-id="encore-dataview-trusted-roots"]')
			).not.toBeNull();
		});

		it('warns that DataviewJS runs code from your notes', () => {
			render(<DataviewSection theme={mockTheme} />);
			expect(screen.getByText(/DataviewJS runs code from your notes/)).toBeInTheDocument();
		});

		it('turns DataviewJS on and persists it', () => {
			render(<DataviewSection theme={mockTheme} />);
			fireEvent.click(screen.getByText('Run DataviewJS'));
			expect(useSettingsStore.getState().dataviewJsEnabled).toBe(true);
			expect(window.maestro.settings.set).toHaveBeenCalledWith('dataviewJsEnabled', true);
		});

		it('says no vault is trusted when the list is empty', () => {
			render(<DataviewSection theme={mockTheme} />);
			expect(screen.getByText('No vault is trusted.')).toBeInTheDocument();
		});

		it('lists trusted vaults and stops trusting one through the trust service', async () => {
			vi.mocked(window.maestro.dataview.untrust).mockResolvedValueOnce({
				root: '/vault/a',
				trusted: false,
				changed: true,
				roots: ['/vault/b'],
			});
			useSettingsStore.setState({ dataviewJsTrustedRoots: ['/vault/a', '/vault/b'] });
			render(<DataviewSection theme={mockTheme} />);
			expect(screen.getByText('/vault/a')).toBeInTheDocument();
			expect(screen.getByText('/vault/b')).toBeInTheDocument();

			fireEvent.click(screen.getByRole('button', { name: 'Stop trusting /vault/a' }));
			expect(window.maestro.dataview.untrust).toHaveBeenCalledWith({ root: '/vault/a' });
			await waitFor(() => expect(screen.queryByText('/vault/a')).toBeNull());
			expect(useSettingsStore.getState().dataviewJsTrustedRoots).toEqual(['/vault/b']);
			// Main wrote the setting; the window never writes it back.
			expect(window.maestro.settings.set).not.toHaveBeenCalled();
		});

		it('keeps the vault and says why when main refuses to stop trusting it', async () => {
			vi.mocked(window.maestro.dataview.untrust).mockRejectedValueOnce(
				new Error('Dataview: root must be an absolute path')
			);
			useSettingsStore.setState({ dataviewJsTrustedRoots: ['/vault/a'] });
			render(<DataviewSection theme={mockTheme} />);

			fireEvent.click(screen.getByRole('button', { name: 'Stop trusting /vault/a' }));
			await waitFor(() =>
				expect(useNotificationStore.getState().toasts.at(-1)?.message).toMatch(
					/Could not stop trusting \/vault\/a/
				)
			);
			expect(useSettingsStore.getState().dataviewJsTrustedRoots).toEqual(['/vault/a']);
		});
	});
});
describeSourceSuite('MaestroRunSection', () => {
	const APP = '/Users/me/Applications/MaestroRun.app';

	function status(overrides: Partial<MaestroRunStatus> = {}): MaestroRunStatus {
		return {
			supported: true,
			enabled: true,
			phase: 'not-installed',
			appPath: APP,
			binaryPath: `${APP}/Contents/MacOS/maestro-run`,
			installedVersion: null,
			fullDiskAccess: 'unknown',
			latestVersion: null,
			updateAvailable: false,
			installing: false,
			watchingForAccess: false,
			detail: null,
			checkedAt: 1,
			...overrides,
		};
	}

	function makeApi(initial: MaestroRunStatus) {
		let push: ((next: MaestroRunStatus) => void) | null = null;
		return {
			status: vi.fn(async () => initial),
			refresh: vi.fn(async () => initial),
			install: vi.fn(async () => initial),
			requestAccess: vi.fn(async () => initial),
			readyPath: vi.fn(async () => null),
			onStatusChanged: vi.fn((handler: (next: MaestroRunStatus) => void) => {
				push = handler;
				return () => {
					push = null;
				};
			}),
			push: (next: MaestroRunStatus) => act(() => push?.(next)),
		};
	}

	let original: unknown;
	const setEnabled = (maestroRun: boolean) =>
		useSettingsStore.setState({
			encoreFeatures: { ...useSettingsStore.getState().encoreFeatures, maestroRun },
		});

	beforeEach(() => {
		original = (window.maestro as unknown as Record<string, unknown>).maestroRun;
		setEnabled(true);
	});
	afterEach(() => {
		(window.maestro as unknown as Record<string, unknown>).maestroRun = original;
		setEnabled(false);
	});

	function install(api: ReturnType<typeof makeApi>) {
		(window.maestro as unknown as Record<string, unknown>).maestroRun = api;
	}

	describe('MaestroRunSection', () => {
		it('offers the install and runs it through the service', async () => {
			const api = makeApi(status());
			install(api);
			render(<MaestroRunSection theme={mockTheme} />);

			fireEvent.click(await screen.findByRole('button', { name: 'Install MaestroRun' }));
			await waitFor(() => expect(api.install).toHaveBeenCalledTimes(1));
			// The release check runs on mount for a tile that is on.
			expect(api.refresh).toHaveBeenCalledWith({ checkLatest: true });
			// Nothing to grant until the launcher exists.
			expect(screen.queryByRole('button', { name: 'Open Full Disk Access' })).toBeNull();
			expect(
				screen.getByText(/Agents are told nothing about MaestroRun until it is installed/)
			).toBeTruthy();
		});

		it('walks the grant once installed, with a reveal fallback', async () => {
			const api = makeApi(
				status({ phase: 'needs-access', installedVersion: '0.2.0', fullDiskAccess: 'not-granted' })
			);
			install(api);
			render(<MaestroRunSection theme={mockTheme} />);

			expect(await screen.findByText(/MaestroRun 0\.2\.0 is installed/)).toBeTruthy();
			expect(screen.queryByRole('button', { name: 'Install MaestroRun' })).toBeNull();

			fireEvent.click(screen.getByRole('button', { name: 'Open Full Disk Access' }));
			await waitFor(() => expect(api.requestAccess).toHaveBeenCalledWith());

			fireEvent.click(screen.getByRole('button', { name: /Not in the list\? Reveal in/ }));
			await waitFor(() => expect(api.requestAccess).toHaveBeenLastCalledWith({ reveal: true }));
		});

		it('turns ready by itself when main reports the grant', async () => {
			const waiting = status({
				phase: 'needs-access',
				installedVersion: '0.2.0',
				fullDiskAccess: 'not-granted',
				watchingForAccess: true,
			});
			const api = makeApi(waiting);
			install(api);
			render(<MaestroRunSection theme={mockTheme} />);
			expect(await screen.findByText('Watching for the switch.')).toBeTruthy();

			await api.push({
				...waiting,
				phase: 'ready',
				fullDiskAccess: 'granted',
				watchingForAccess: false,
			});

			expect(screen.getByText('MaestroRun holds Full Disk Access.')).toBeTruthy();
			expect(screen.getByText(/Every local agent Maestro starts is now told/)).toBeTruthy();
			expect(screen.getByText(`${APP}/Contents/MacOS/maestro-run`)).toBeTruthy();
			expect(screen.queryByRole('button', { name: 'Open Full Disk Access' })).toBeNull();
		});

		it('offers the update when a newer release exists', async () => {
			const api = makeApi(
				status({
					phase: 'ready',
					installedVersion: '0.2.0',
					fullDiskAccess: 'granted',
					latestVersion: '0.3.0',
					updateAvailable: true,
				})
			);
			install(api);
			render(<MaestroRunSection theme={mockTheme} />);
			fireEvent.click(await screen.findByRole('button', { name: 'Update to 0.3.0' }));
			await waitFor(() => expect(api.install).toHaveBeenCalledTimes(1));
		});

		it('warns about a bundle that is not MaestroRun and offers to replace it', async () => {
			const api = makeApi(
				status({ phase: 'invalid', detail: 'code failed to satisfy requirement' })
			);
			install(api);
			render(<MaestroRunSection theme={mockTheme} />);
			expect(await screen.findByText('code failed to satisfy requirement')).toBeTruthy();
			expect(screen.getByRole('button', { name: 'Install MaestroRun' })).toBeTruthy();
		});

		it('shows no actions while the feature is off, and skips the release check', async () => {
			setEnabled(false);
			const api = makeApi(status({ enabled: false }));
			install(api);
			render(<MaestroRunSection theme={mockTheme} />);
			expect(await screen.findByText(/Turn MaestroRun on from the tile header/)).toBeTruthy();
			expect(screen.queryByRole('button')).toBeNull();
			expect(api.refresh).toHaveBeenCalledWith({ checkLatest: false });
		});

		it('offers Install again after an install fails', async () => {
			const api = makeApi(status());
			api.install.mockRejectedValue(
				new Error('MaestroRun has not published a release for this Mac yet.')
			);
			install(api);
			render(<MaestroRunSection theme={mockTheme} />);
			fireEvent.click(await screen.findByRole('button', { name: 'Install MaestroRun' }));
			await waitFor(() => expect(api.install).toHaveBeenCalledTimes(1));
			await waitFor(() =>
				expect(
					(screen.getByRole('button', { name: 'Install MaestroRun' }) as HTMLButtonElement).disabled
				).toBe(false)
			);
		});
	});
});
describeSourceSuite('PianolaSection', () => {
	describe('Pianola repair permission', () => {
		beforeEach(() => {
			vi.clearAllMocks();
			resetStores(useSettingsStore, useNotificationStore);
			useSettingsStore.setState({
				pianolaAutoFixEnabled: false,
				encoreFeatures: { ...useSettingsStore.getState().encoreFeatures, pianola: true },
			});
			vi.mocked(window.maestro.settings.set).mockReset().mockResolvedValue(true);
			vi.mocked(window.maestro.settings.getAll).mockReset().mockResolvedValue({});
		});

		it('shows supervision without granting repairs by mounting the settings UI', () => {
			render(<PianolaSection theme={mockTheme} />);
			expect(screen.getByText('Current mode: Supervision.')).toBeInTheDocument();
			expect(window.maestro.settings.set).not.toHaveBeenCalled();
			expect(screen.getByText(/Automatic merge is unavailable/)).toBeInTheDocument();
		});

		it('shows repairs as disabled when the feature is off without changing saved permission', () => {
			useSettingsStore.setState({
				pianolaAutoFixEnabled: true,
				encoreFeatures: { ...useSettingsStore.getState().encoreFeatures, pianola: false },
			});
			render(<PianolaSection theme={mockTheme} />);
			expect(screen.getByText('Current mode: Disabled.')).toBeInTheDocument();
			fireEvent.click(screen.getByRole('switch', { name: 'Allow automatic repairs' }));
			expect(window.maestro.settings.set).not.toHaveBeenCalled();
		});

		it('persists explicit repair permission before displaying the new mode', async () => {
			let confirm!: (value: boolean) => void;
			vi.mocked(window.maestro.settings.set).mockReturnValueOnce(
				new Promise((r) => {
					confirm = r;
				})
			);
			render(<PianolaSection theme={mockTheme} />);
			fireEvent.click(screen.getByRole('switch', { name: 'Allow automatic repairs' }));
			expect(window.maestro.settings.set).toHaveBeenCalledWith('pianolaAutoFixEnabled', true);
			expect(useSettingsStore.getState().pianolaAutoFixEnabled).toBe(false);
			// A second click cannot issue a contrary or duplicate write before acknowledgement.
			fireEvent.click(screen.getByRole('switch', { name: 'Allow automatic repairs' }));
			expect(window.maestro.settings.set).toHaveBeenCalledTimes(1);
			confirm(true);
			await waitFor(() =>
				expect(screen.getByText('Current mode: Automatic repairs.')).toBeInTheDocument()
			);
		});

		it('keeps repairs off when persistence refuses the permission', async () => {
			vi.mocked(window.maestro.settings.set).mockResolvedValueOnce(false);
			render(<PianolaSection theme={mockTheme} />);
			fireEvent.click(screen.getByRole('switch', { name: 'Allow automatic repairs' }));
			await waitFor(() =>
				expect(useNotificationStore.getState().toasts.at(-1)?.message).toMatch(
					/Could not save repair permission/
				)
			);
			expect(useSettingsStore.getState().pianolaAutoFixEnabled).toBe(false);
		});

		it.each([true, false])(
			'preserves newer hydration while a UI write from %s awaits acknowledgement',
			async (persisted) => {
				useSettingsStore.setState({ settingsLoaded: true, pianolaAutoFixEnabled: persisted });
				let confirm!: (value: boolean) => void;
				vi.mocked(window.maestro.settings.set).mockReturnValueOnce(
					new Promise((resolve) => {
						confirm = resolve;
					})
				);
				render(<PianolaSection theme={mockTheme} />);
				fireEvent.click(screen.getByRole('switch', { name: 'Allow automatic repairs' }));
				expect(window.maestro.settings.set).toHaveBeenCalledWith(
					'pianolaAutoFixEnabled',
					!persisted
				);
				// A CLI/peer write arrives while the UI's older save acknowledgement is delayed.
				// The value can equal the current checkbox, so comparing values cannot detect this race.
				vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
					encoreFeatures: { pianola: true },
					pianolaAutoFixEnabled: persisted,
				});
				await act(async () => {
					await loadAllSettings();
				});
				await act(async () => {
					confirm(true);
				});
				expect(useSettingsStore.getState().pianolaAutoFixEnabled).toBe(persisted);
				expect(
					screen.getByText(`Current mode: ${persisted ? 'Automatic repairs' : 'Supervision'}.`)
				).toBeInTheDocument();
			}
		);

		it('applies a newer hydration that finishes after the older acknowledgement', async () => {
			useSettingsStore.setState({ settingsLoaded: true, pianolaAutoFixEnabled: true });
			let confirmSave!: (value: boolean) => void;
			let confirmRead!: (value: Record<string, unknown>) => void;
			vi.mocked(window.maestro.settings.set).mockReturnValueOnce(
				new Promise((resolve) => {
					confirmSave = resolve;
				})
			);
			const olderSave = useSettingsStore.getState().setPianolaAutoFixEnabled(false);
			vi.mocked(window.maestro.settings.getAll).mockReturnValueOnce(
				new Promise((resolve) => {
					confirmRead = resolve;
				})
			);
			const newerLoad = loadAllSettings();
			confirmSave(true);
			await olderSave;
			confirmRead({ pianolaAutoFixEnabled: true });
			await newerLoad;
			expect(useSettingsStore.getState().pianolaAutoFixEnabled).toBe(true);
		});

		it('keeps the latest confirmed permission when store save acknowledgements arrive out of order', async () => {
			let confirmOlder!: (value: boolean) => void;
			let confirmNewer!: (value: boolean) => void;
			vi.mocked(window.maestro.settings.set)
				.mockReturnValueOnce(
					new Promise((resolve) => {
						confirmOlder = resolve;
					})
				)
				.mockReturnValueOnce(
					new Promise((resolve) => {
						confirmNewer = resolve;
					})
				);
			const olderSave = useSettingsStore.getState().setPianolaAutoFixEnabled(true);
			const newerSave = useSettingsStore.getState().setPianolaAutoFixEnabled(false);
			confirmNewer(true);
			await newerSave;
			confirmOlder(true);
			await olderSave;
			expect(useSettingsStore.getState().pianolaAutoFixEnabled).toBe(false);
		});

		it('keeps a newer confirmed permission over an older in-flight hydration', async () => {
			useSettingsStore.setState({ settingsLoaded: true, pianolaAutoFixEnabled: true });
			let readOlder!: (value: Record<string, unknown>) => void;
			vi.mocked(window.maestro.settings.getAll).mockReturnValueOnce(
				new Promise((resolve) => {
					readOlder = resolve;
				})
			);
			const olderLoad = loadAllSettings();
			await useSettingsStore.getState().setPianolaAutoFixEnabled(true);
			readOlder({ pianolaAutoFixEnabled: false });
			await olderLoad;
			expect(useSettingsStore.getState().pianolaAutoFixEnabled).toBe(true);
		});

		it('reconciles a failed save with the canonical permission written by another client', async () => {
			vi.mocked(window.maestro.settings.set).mockRejectedValueOnce(
				new Error('save acknowledgement lost')
			);
			vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
				encoreFeatures: { pianola: true },
				pianolaAutoFixEnabled: true,
			});
			await expect(useSettingsStore.getState().setPianolaAutoFixEnabled(true)).rejects.toThrow(
				'save acknowledgement lost'
			);
			expect(useSettingsStore.getState().pianolaAutoFixEnabled).toBe(true);
		});

		it('hydrates only explicit boolean permission and clears it when absent after recovery', async () => {
			vi.mocked(window.maestro.settings.getAll).mockResolvedValue({ pianolaAutoFixEnabled: true });
			await loadAllSettings();
			expect(useSettingsStore.getState().pianolaAutoFixEnabled).toBe(true);
			vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
				encoreFeatures: { pianola: true, autopilot: true },
			});
			await loadAllSettings();
			expect(useSettingsStore.getState().pianolaAutoFixEnabled).toBe(false);
		});
	});
});
describeSourceSuite('ThroughputGaugeSection', () => {
	function renderSection(
		settings: ThroughputGaugeSettings = { ...DEFAULT_THROUGHPUT_GAUGE_SETTINGS }
	) {
		const setThroughputGaugeSettings = vi.fn();
		render(
			<ThroughputGaugeSection
				theme={mockTheme}
				throughputGaugeSettings={settings}
				setThroughputGaugeSettings={setThroughputGaugeSettings}
			/>
		);
		return setThroughputGaugeSettings;
	}

	describe('ThroughputGaugeSection', () => {
		beforeEach(() => {
			installLocalStorageMock();
		});

		it('anchors the section and its gated display settings for search', () => {
			renderSection();
			const root = document.querySelector('[data-setting-id="encore-throughput-gauge"]');
			expect(root).not.toBeNull();
			expect(
				root!.querySelector('[data-setting-id="encore-throughput-gauge-display"]')
			).not.toBeNull();
		});

		it('renders every setting with the shared labels and choices', () => {
			renderSection();
			for (const control of THROUGHPUT_GAUGE_SETTING_CONTROLS) {
				const row = screen.getByTestId(`throughput-gauge-section-${control.field}`);
				expect(row.textContent).toContain(control.label);
				for (const option of control.options) {
					expect(within(row).getByRole('button', { name: option.label })).toBeInTheDocument();
				}
			}
		});

		it.each<[keyof ThroughputGaugeSettings, string, Partial<ThroughputGaugeSettings>]>([
			['scope', 'Active agent', { scope: 'active' }],
			['metric', 'Out', { metric: 'out' }],
			['layout', 'All three', { layout: 'all' }],
			['style', 'Sparkline', { style: 'sparkline' }],
			['windowMs', '30s', { windowMs: 30000 }],
		])('choosing %s "%s" writes the merged settings', (field, label, patch) => {
			const current: ThroughputGaugeSettings = {
				...DEFAULT_THROUGHPUT_GAUGE_SETTINGS,
				style: 'lcd',
			};
			const setThroughputGaugeSettings = renderSection(current);

			const row = screen.getByTestId(`throughput-gauge-section-${field}`);
			fireEvent.click(within(row).getByRole('button', { name: label }));

			expect(setThroughputGaugeSettings).toHaveBeenCalledWith({ ...current, ...patch });
		});

		it('Show gauge now brings a closed gauge back', () => {
			useThroughputGaugeStore.setState({ visible: false });
			renderSection();

			fireEvent.click(screen.getByRole('button', { name: /Show gauge now/ }));

			expect(useThroughputGaugeStore.getState().visible).toBe(true);
		});
	});
});

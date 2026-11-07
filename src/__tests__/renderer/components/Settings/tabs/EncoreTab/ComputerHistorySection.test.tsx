import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComputerHistorySection } from '../../../../../../renderer/components/Settings/tabs/EncoreTab/components';
import { useSettingsStore } from '../../../../../../renderer/stores/settingsStore';
import { useModalStore } from '../../../../../../renderer/stores/modalStore';
import {
	applyConfigPatch,
	defaultComputerHistoryConfig,
	type ComputerHistoryConfigPatch,
} from '../../../../../../shared/computer-history/config';
import { mockTheme } from '../../../../../helpers/mockTheme';

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
		// The service's own merge. A shallow spread would replace `digests` whole
		// and hand the section a config with no digest writer.
		setConfig: vi.fn(async (patch: ComputerHistoryConfigPatch) => applyConfigPatch(config, patch)),
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

	it('digests are written by the local model unless the config names an agent', async () => {
		const api = makeApi('windows', null);
		api.getConfig.mockResolvedValue({
			...defaultComputerHistoryConfig(),
			digests: { enabled: true, source: 'local', agentId: 'agent-1', rollup: true },
		});
		install(api);
		render(<ComputerHistorySection theme={mockTheme} />);
		expect(await screen.findByLabelText('Digest model')).toBeTruthy();
		expect(screen.queryByLabelText('Digest agent')).toBeNull();
		expect(screen.getByText(/written by the chosen local model after each window/)).toBeTruthy();
		fireEvent.click(screen.getByTestId('computer-history-digest-source-agent'));
		await waitFor(() =>
			expect(api.setConfig).toHaveBeenCalledWith({ digests: { source: 'agent' } })
		);
	});

	it('the 6-hour roll-up toggle saves through the service', async () => {
		const api = makeApi('windows', null);
		api.getConfig.mockResolvedValue({
			...defaultComputerHistoryConfig(),
			digests: { enabled: true, source: 'local', agentId: null, rollup: true },
		});
		install(api);
		render(<ComputerHistorySection theme={mockTheme} />);
		fireEvent.click(await screen.findByText('6-hour roll-up'));
		await waitFor(() => expect(api.setConfig).toHaveBeenCalledWith({ digests: { rollup: false } }));
	});
});

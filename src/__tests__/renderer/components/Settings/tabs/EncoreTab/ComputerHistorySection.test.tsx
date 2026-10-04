import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComputerHistorySection } from '../../../../../../renderer/components/Settings/tabs/EncoreTab/components';
import { useSettingsStore } from '../../../../../../renderer/stores/settingsStore';
import { useModalStore } from '../../../../../../renderer/stores/modalStore';
import { defaultComputerHistoryConfig } from '../../../../../../shared/computer-history/config';
import { mockTheme } from '../../../../../helpers/mockTheme';

function makeApi(
	platform: 'macos' | 'linux' | 'windows',
	helperStatus: Record<string, unknown> | null
) {
	const config = defaultComputerHistoryConfig();
	return {
		status: vi.fn(async () => ({
			enabled: true,
			running: true,
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
		listRules: vi.fn(async () => ({ rules: [], builtIn: ['com.maestro.app'] })),
		addRule: vi.fn(async () => ({ id: 'r', match: 'app', value: 'x' })),
		removeRule: vi.fn(async () => null),
		clear: vi.fn(async () => ({ deletedSegments: 0, freedBytes: 0 })),
		requestAccessibility: vi.fn(async () => ({ platform, outcome: 'enabled' })),
		query: vi.fn(),
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

	it('adds an exclusion rule', async () => {
		const api = makeApi('windows', null);
		install(api);
		render(<ComputerHistorySection theme={mockTheme} />);
		const input = await screen.findByPlaceholderText('com.apple.MobileSMS');
		fireEvent.change(input, { target: { value: 'com.apple.MobileSMS' } });
		fireEvent.click(screen.getByText('Exclude'));
		await waitFor(() => expect(api.addRule).toHaveBeenCalledWith('app', 'com.apple.MobileSMS'));
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
});

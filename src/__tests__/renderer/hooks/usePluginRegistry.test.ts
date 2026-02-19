/**
 * Tests for usePluginRegistry hook
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { usePluginRegistry } from '../../../renderer/hooks/usePluginRegistry';
import type { LoadedPlugin } from '../../../shared/plugin-types';

const mockPlugins: LoadedPlugin[] = [
	{
		manifest: {
			id: 'test-plugin',
			name: 'Test Plugin',
			version: '1.0.0',
			description: 'A test plugin',
			author: 'Test',
			main: 'index.js',
			permissions: ['stats:read'],
			ui: {
				rightPanelTabs: [{ id: 'test-tab', label: 'Test Tab', icon: 'chart' }],
			},
		},
		state: 'active',
		path: '/plugins/test-plugin',
	},
	{
		manifest: {
			id: 'disabled-plugin',
			name: 'Disabled Plugin',
			version: '0.1.0',
			description: 'A disabled plugin',
			author: 'Test',
			main: 'index.js',
			permissions: [],
		},
		state: 'disabled',
		path: '/plugins/disabled-plugin',
	},
];

describe('usePluginRegistry', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(window.maestro.plugins.getAll).mockResolvedValue(mockPlugins);
		vi.mocked(window.maestro.plugins.enable).mockResolvedValue(undefined);
		vi.mocked(window.maestro.plugins.disable).mockResolvedValue(undefined);
	});

	it('loads plugins on mount', async () => {
		const { result } = renderHook(() => usePluginRegistry());

		expect(result.current.loading).toBe(true);

		await waitFor(() => {
			expect(result.current.loading).toBe(false);
		});

		expect(result.current.plugins).toEqual(mockPlugins);
		expect(window.maestro.plugins.getAll).toHaveBeenCalledOnce();
	});

	it('getActivePlugins filters to active plugins', async () => {
		const { result } = renderHook(() => usePluginRegistry());

		await waitFor(() => {
			expect(result.current.loading).toBe(false);
		});

		const active = result.current.getActivePlugins();
		expect(active).toHaveLength(1);
		expect(active[0].manifest.id).toBe('test-plugin');
	});

	it('getPluginTabs collects tabs from active plugins', async () => {
		const { result } = renderHook(() => usePluginRegistry());

		await waitFor(() => {
			expect(result.current.loading).toBe(false);
		});

		const tabs = result.current.getPluginTabs();
		expect(tabs).toHaveLength(1);
		expect(tabs[0]).toEqual({
			pluginId: 'test-plugin',
			tabId: 'test-tab',
			label: 'Test Tab',
			icon: 'chart',
		});
	});

	it('enablePlugin calls IPC and refreshes', async () => {
		const { result } = renderHook(() => usePluginRegistry());

		await waitFor(() => {
			expect(result.current.loading).toBe(false);
		});

		await act(async () => {
			await result.current.enablePlugin('disabled-plugin');
		});

		expect(window.maestro.plugins.enable).toHaveBeenCalledWith('disabled-plugin');
		// Should have called getAll twice: once on mount, once after enable
		expect(window.maestro.plugins.getAll).toHaveBeenCalledTimes(2);
	});

	it('disablePlugin calls IPC and refreshes', async () => {
		const { result } = renderHook(() => usePluginRegistry());

		await waitFor(() => {
			expect(result.current.loading).toBe(false);
		});

		await act(async () => {
			await result.current.disablePlugin('test-plugin');
		});

		expect(window.maestro.plugins.disable).toHaveBeenCalledWith('test-plugin');
		expect(window.maestro.plugins.getAll).toHaveBeenCalledTimes(2);
	});

	it('refreshPlugins re-fetches from main process', async () => {
		const { result } = renderHook(() => usePluginRegistry());

		await waitFor(() => {
			expect(result.current.loading).toBe(false);
		});

		await act(async () => {
			await result.current.refreshPlugins();
		});

		expect(window.maestro.plugins.getAll).toHaveBeenCalledTimes(2);
	});

	it('returns empty tabs when no plugins have UI', async () => {
		vi.mocked(window.maestro.plugins.getAll).mockResolvedValue([
			{
				manifest: {
					id: 'no-ui',
					name: 'No UI Plugin',
					version: '1.0.0',
					description: 'No UI',
					author: 'Test',
					main: 'index.js',
					permissions: [],
				},
				state: 'active',
				path: '/plugins/no-ui',
			},
		]);

		const { result } = renderHook(() => usePluginRegistry());

		await waitFor(() => {
			expect(result.current.loading).toBe(false);
		});

		expect(result.current.getPluginTabs()).toHaveLength(0);
	});
});

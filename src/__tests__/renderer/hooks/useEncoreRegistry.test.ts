/**
 * Tests for useEncoreRegistry hook
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useEncoreRegistry } from '../../../renderer/hooks/useEncoreRegistry';
import type { LoadedEncore } from '../../../shared/encore-types';

const mockEncores: LoadedEncore[] = [
	{
		manifest: {
			id: 'test-encore',
			name: 'Test Encore',
			version: '1.0.0',
			description: 'A test encore',
			author: 'Test',
			main: 'index.js',
			permissions: ['stats:read'],
			ui: {
				rightPanelTabs: [{ id: 'test-tab', label: 'Test Tab', icon: 'chart' }],
			},
		},
		state: 'active',
		path: '/encores/test-encore',
	},
	{
		manifest: {
			id: 'disabled-encore',
			name: 'Disabled Encore',
			version: '0.1.0',
			description: 'A disabled encore',
			author: 'Test',
			main: 'index.js',
			permissions: [],
		},
		state: 'disabled',
		path: '/encores/disabled-encore',
	},
];

describe('useEncoreRegistry', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(window.maestro.encores.getAll).mockResolvedValue({ success: true, encores: mockEncores });
		vi.mocked(window.maestro.encores.enable).mockResolvedValue({ success: true, enabled: true });
		vi.mocked(window.maestro.encores.disable).mockResolvedValue({ success: true, disabled: true });
	});

	it('loads encores on mount', async () => {
		const { result } = renderHook(() => useEncoreRegistry());

		expect(result.current.loading).toBe(true);

		await waitFor(() => {
			expect(result.current.loading).toBe(false);
		});

		expect(result.current.encores).toEqual(mockEncores);
		expect(window.maestro.encores.getAll).toHaveBeenCalledOnce();
	});

	it('getActiveEncores filters to active encores', async () => {
		const { result } = renderHook(() => useEncoreRegistry());

		await waitFor(() => {
			expect(result.current.loading).toBe(false);
		});

		const active = result.current.getActiveEncores();
		expect(active).toHaveLength(1);
		expect(active[0].manifest.id).toBe('test-encore');
	});

	it('getEncoreTabs collects tabs from active encores', async () => {
		const { result } = renderHook(() => useEncoreRegistry());

		await waitFor(() => {
			expect(result.current.loading).toBe(false);
		});

		const tabs = result.current.getEncoreTabs();
		expect(tabs).toHaveLength(1);
		expect(tabs[0]).toEqual({
			encoreId: 'test-encore',
			tabId: 'test-tab',
			label: 'Test Tab',
			icon: 'chart',
		});
	});

	it('enableEncore calls IPC and refreshes', async () => {
		const { result } = renderHook(() => useEncoreRegistry());

		await waitFor(() => {
			expect(result.current.loading).toBe(false);
		});

		await act(async () => {
			await result.current.enableEncore('disabled-encore');
		});

		expect(window.maestro.encores.enable).toHaveBeenCalledWith('disabled-encore');
		// Should have called getAll twice: once on mount, once after enable
		expect(window.maestro.encores.getAll).toHaveBeenCalledTimes(2);
	});

	it('disableEncore calls IPC and refreshes', async () => {
		const { result } = renderHook(() => useEncoreRegistry());

		await waitFor(() => {
			expect(result.current.loading).toBe(false);
		});

		await act(async () => {
			await result.current.disableEncore('test-encore');
		});

		expect(window.maestro.encores.disable).toHaveBeenCalledWith('test-encore');
		expect(window.maestro.encores.getAll).toHaveBeenCalledTimes(2);
	});

	it('refreshEncores re-fetches from main process', async () => {
		const { result } = renderHook(() => useEncoreRegistry());

		await waitFor(() => {
			expect(result.current.loading).toBe(false);
		});

		await act(async () => {
			await result.current.refreshEncores();
		});

		expect(window.maestro.encores.getAll).toHaveBeenCalledTimes(2);
	});

	it('returns empty tabs when no encores have UI', async () => {
		vi.mocked(window.maestro.encores.getAll).mockResolvedValue({
			success: true,
			encores: [
				{
					manifest: {
						id: 'no-ui',
						name: 'No UI Encore',
						version: '1.0.0',
						description: 'No UI',
						author: 'Test',
						main: 'index.js',
						permissions: [],
					},
					state: 'active',
					path: '/encores/no-ui',
				},
			],
		});

		const { result } = renderHook(() => useEncoreRegistry());

		await waitFor(() => {
			expect(result.current.loading).toBe(false);
		});

		expect(result.current.getEncoreTabs()).toHaveLength(0);
	});
});

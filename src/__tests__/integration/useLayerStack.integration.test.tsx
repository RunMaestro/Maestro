import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useLayerStack } from '../../renderer/hooks/ui/useLayerStack';
import type { ModalLayerInput, OverlayLayerInput } from '../../renderer/types/layer';
import { logger } from '../../renderer/utils/logger';

const originalNodeEnv = process.env.NODE_ENV;

const modalLayer = (overrides: Partial<ModalLayerInput> = {}): ModalLayerInput => ({
	type: 'modal',
	priority: 100,
	blocksLowerLayers: true,
	capturesFocus: true,
	focusTrap: 'strict',
	onEscape: vi.fn(),
	...overrides,
});

const overlayLayer = (overrides: Partial<OverlayLayerInput> = {}): OverlayLayerInput => ({
	type: 'overlay',
	priority: 50,
	blocksLowerLayers: false,
	capturesFocus: false,
	focusTrap: 'none',
	onEscape: vi.fn(),
	allowClickOutside: true,
	...overrides,
});

describe('useLayerStack integration', () => {
	beforeEach(() => {
		process.env.NODE_ENV = 'production';
		delete window.__MAESTRO_DEBUG__;
	});

	afterEach(() => {
		process.env.NODE_ENV = originalNodeEnv;
		delete window.__MAESTRO_DEBUG__;
		vi.restoreAllMocks();
	});

	it('reports stack state through getters and protects the internal layers array', async () => {
		const { result } = renderHook(() => useLayerStack());

		await expect(result.current.closeTopLayer()).resolves.toBe(false);
		expect(result.current.hasOpenLayers()).toBe(false);
		expect(result.current.hasOpenModal()).toBe(false);

		act(() => {
			result.current.registerLayer(overlayLayer({ priority: 20, ariaLabel: 'Preview' }));
			result.current.registerLayer(modalLayer({ priority: 80, ariaLabel: 'Settings' }));
		});

		expect(result.current.hasOpenLayers()).toBe(true);
		expect(result.current.hasOpenModal()).toBe(true);
		expect(result.current.getTopLayer()?.ariaLabel).toBe('Settings');

		const layers = result.current.getLayers();
		layers.pop();

		expect(result.current.getLayers()).toHaveLength(2);
	});

	it('honors modal close guards and uses the latest registered handler', async () => {
		const { result } = renderHook(() => useLayerStack());
		const blockedEscape = vi.fn();
		const allowedInitialEscape = vi.fn();
		const allowedUpdatedEscape = vi.fn();

		act(() => {
			result.current.registerLayer(
				modalLayer({
					priority: 10,
					onBeforeClose: vi.fn().mockResolvedValue(false),
					onEscape: blockedEscape,
				})
			);
		});

		await expect(result.current.closeTopLayer()).resolves.toBe(false);
		expect(blockedEscape).not.toHaveBeenCalled();

		act(() => {
			result.current.unregisterLayer(result.current.getTopLayer()!.id);
		});

		let allowedId = '';
		act(() => {
			allowedId = result.current.registerLayer(
				modalLayer({
					priority: 20,
					onBeforeClose: vi.fn().mockResolvedValue(true),
					onEscape: allowedInitialEscape,
				})
			);
			result.current.updateLayerHandler(allowedId, allowedUpdatedEscape);
		});

		await expect(result.current.closeTopLayer()).resolves.toBe(true);
		expect(allowedInitialEscape).not.toHaveBeenCalled();
		expect(allowedUpdatedEscape).toHaveBeenCalledTimes(1);
	});

	it('installs development debug helpers that inspect and clear the layer stack', () => {
		process.env.NODE_ENV = 'development';
		const tableSpy = vi.spyOn(console, 'table').mockImplementation(() => undefined);
		const logSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
		const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
		const { result, unmount } = renderHook(() => useLayerStack());

		expect(window.__MAESTRO_DEBUG__?.layers).toBeDefined();

		act(() => {
			window.__MAESTRO_DEBUG__!.layers!.top();
		});
		expect(logSpy).toHaveBeenCalledWith('No layers in stack');

		act(() => {
			result.current.registerLayer(modalLayer({ ariaLabel: 'Debug Modal' }));
		});

		act(() => {
			window.__MAESTRO_DEBUG__!.layers!.list();
			window.__MAESTRO_DEBUG__!.layers!.top();
			window.__MAESTRO_DEBUG__!.layers!.simulate.escape();
		});

		expect(tableSpy).toHaveBeenCalledWith([
			expect.objectContaining({
				type: 'modal',
				priority: 100,
				blocksLower: true,
				focusTrap: 'strict',
				ariaLabel: 'Debug Modal',
			}),
		]);
		expect(logSpy).toHaveBeenCalledWith(
			'Top Layer:',
			undefined,
			expect.objectContaining({ ariaLabel: 'Debug Modal' })
		);
		expect(dispatchSpy).toHaveBeenCalledWith(expect.objectContaining({ key: 'Escape' }));
		expect(logSpy).toHaveBeenCalledWith('Escape key event dispatched');

		act(() => {
			window.__MAESTRO_DEBUG__!.layers!.simulate.closeAll();
		});

		expect(result.current.layerCount).toBe(0);
		expect(logSpy).toHaveBeenCalledWith('Cleared 1 layers from stack');

		unmount();

		expect(window.__MAESTRO_DEBUG__?.layers).toBeUndefined();
	});
});

import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import StandingOvationOverlay from '../../renderer/components/StandingOvationOverlay';
import { CONDUCTOR_BADGES } from '../../renderer/constants/conductorBadges';
import type { Theme } from '../../renderer/types';

const layerMocks = vi.hoisted(() => ({
	registeredLayer: undefined as { onEscape?: () => void } | undefined,
	registerLayer: vi.fn(),
	unregisterLayer: vi.fn(),
	updateLayerHandler: vi.fn(),
}));

vi.mock('../../renderer/contexts/LayerStackContext', () => ({
	useLayerStack: () => ({
		registerLayer: layerMocks.registerLayer,
		unregisterLayer: layerMocks.unregisterLayer,
		updateLayerHandler: layerMocks.updateLayerHandler,
	}),
}));

vi.mock('canvas-confetti', () => ({
	default: vi.fn(),
}));

const theme: Theme = {
	id: 'test-dark',
	name: 'Test Dark',
	mode: 'dark',
	colors: {
		bgMain: '#111111',
		bgSidebar: '#1f1f1f',
		bgActivity: '#2b2b2b',
		textMain: '#f5f5f5',
		textDim: '#a3a3a3',
		accent: '#38bdf8',
		border: '#404040',
		error: '#ef4444',
		warning: '#f59e0b',
		success: '#22c55e',
		syntaxComment: '#737373',
		syntaxKeyword: '#c084fc',
	},
};

describe('StandingOvationOverlay layer integration', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		layerMocks.registeredLayer = undefined;
		layerMocks.registerLayer.mockImplementation((layer) => {
			layerMocks.registeredLayer = layer;
			return 'standing-ovation-layer';
		});
		layerMocks.unregisterLayer.mockClear();
		layerMocks.updateLayerHandler.mockClear();
	});

	afterEach(() => {
		act(() => {
			vi.runOnlyPendingTimers();
		});
		cleanup();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('closes through the originally registered Escape callback', () => {
		const onClose = vi.fn();
		render(
			<StandingOvationOverlay
				theme={theme}
				themeMode="dark"
				badge={CONDUCTOR_BADGES[1]}
				cumulativeTimeMs={2 * 60 * 60 * 1000}
				onClose={onClose}
				disableConfetti
			/>
		);

		expect(layerMocks.registerLayer).toHaveBeenCalled();
		expect(layerMocks.updateLayerHandler).toHaveBeenCalledWith(
			'standing-ovation-layer',
			expect.any(Function)
		);

		act(() => {
			layerMocks.registeredLayer?.onEscape?.();
			vi.advanceTimersByTime(1500);
		});

		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('tolerates a missing layer id during update and cleanup', () => {
		layerMocks.registerLayer.mockImplementation((layer) => {
			layerMocks.registeredLayer = layer;
			return undefined;
		});

		const { unmount } = render(
			<StandingOvationOverlay
				theme={theme}
				themeMode="dark"
				badge={CONDUCTOR_BADGES[1]}
				cumulativeTimeMs={2 * 60 * 60 * 1000}
				onClose={vi.fn()}
				disableConfetti
			/>
		);

		expect(layerMocks.updateLayerHandler).not.toHaveBeenCalled();

		unmount();

		expect(layerMocks.unregisterLayer).not.toHaveBeenCalled();
	});
});

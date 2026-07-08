import React from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const layerState = vi.hoisted(() => ({
	registeredLayer: null as { onEscape: () => void } | null,
	unregisterLayer: vi.fn(),
	updateLayerHandler: vi.fn(),
}));

vi.mock('../../renderer/contexts/LayerStackContext', () => ({
	useLayerStack: () => ({
		registerLayer: (layer: { onEscape: () => void }) => {
			layerState.registeredLayer = layer;
			return 'tab-switcher-layer';
		},
		unregisterLayer: layerState.unregisterLayer,
		updateLayerHandler: layerState.updateLayerHandler,
	}),
}));

import { TabSwitcherModal } from '../../renderer/components/TabSwitcherModal';
import type { AITab, Theme } from '../../renderer/types';

const theme: Theme = {
	id: 'layer-test',
	name: 'Layer Test',
	mode: 'dark',
	colors: {
		bgMain: '#111827',
		bgSidebar: '#1f2937',
		bgActivity: '#0f172a',
		border: '#374151',
		textMain: '#f9fafb',
		textDim: '#9ca3af',
		accent: '#2563eb',
		accentDim: '#1d4ed8',
		accentText: '#93c5fd',
		accentForeground: '#ffffff',
		success: '#16a34a',
		warning: '#f59e0b',
		error: '#dc2626',
	},
};

const tab: AITab = {
	id: 'tab-1',
	agentSessionId: 'layer11-2222-3333-4444-555555555555',
	name: 'Layer Tab',
	starred: false,
	logs: [],
	inputValue: '',
	stagedImages: [],
	createdAt: 1700000000000,
	state: 'idle',
};

describe('TabSwitcherModal layer integration', () => {
	beforeEach(() => {
		layerState.registeredLayer = null;
		layerState.unregisterLayer.mockClear();
		layerState.updateLayerHandler.mockClear();
		vi.clearAllMocks();
		vi.mocked(window.maestro.agentSessions.getAllNamedSessions).mockResolvedValue([]);
		vi.mocked(window.maestro.claude.updateSessionName).mockResolvedValue(undefined);
	});

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	it('wires the initial registered Escape handler to onClose', async () => {
		const onClose = vi.fn();

		render(
			<TabSwitcherModal
				theme={theme}
				tabs={[tab]}
				activeTabId="tab-1"
				projectRoot="/workspace/project"
				agentId="claude-code"
				onTabSelect={vi.fn()}
				onNamedSessionSelect={vi.fn()}
				onClose={onClose}
			/>
		);

		await waitFor(() => {
			expect(window.maestro.agentSessions.getAllNamedSessions).toHaveBeenCalled();
		});

		act(() => {
			layerState.registeredLayer?.onEscape();
		});

		expect(onClose).toHaveBeenCalledTimes(1);
		expect(layerState.updateLayerHandler).toHaveBeenCalledWith(
			'tab-switcher-layer',
			expect.any(Function)
		);
	});
});

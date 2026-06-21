import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const layerState = vi.hoisted(() => ({
	registeredEscape: null as (() => void) | null,
	updatedEscape: null as (() => void) | null,
	unregisterLayer: vi.fn(),
	updateLayerHandler: vi.fn((_: string, handler: () => void) => {
		layerState.updatedEscape = handler;
	}),
}));

vi.mock('../../renderer/contexts/LayerStackContext', () => ({
	useLayerStack: () => ({
		registerLayer: (layer: { onEscape: () => void }) => {
			layerState.registeredEscape = layer.onEscape;
			return 'agent-sessions-layer';
		},
		unregisterLayer: layerState.unregisterLayer,
		updateLayerHandler: layerState.updateLayerHandler,
	}),
}));

import { AgentSessionsModal } from '../../renderer/components/AgentSessionsModal';
import type { Session, Theme } from '../../renderer/types';

const theme: Theme = {
	id: 'layer-dark',
	name: 'Layer Dark',
	mode: 'dark',
	colors: {
		bgMain: '#111111',
		bgSidebar: '#20242b',
		bgActivity: '#181b20',
		border: '#3f3f46',
		textMain: '#f4f4f5',
		textDim: '#a1a1aa',
		accent: '#4f8cff',
		accentDim: '#1d4ed8',
		accentText: '#22d3ee',
		accentForeground: '#ffffff',
		success: '#22c55e',
		warning: '#f59e0b',
		error: '#ef4444',
	},
};

function activeSession(overrides: Partial<Session> = {}): Session {
	return {
		id: 'session-1',
		name: 'Integration Agent',
		toolType: 'claude-code',
		state: 'idle',
		inputMode: 'ai',
		cwd: '/repo',
		projectRoot: '/repo',
		aiPid: 1,
		terminalPid: 2,
		aiLogs: [],
		shellLogs: [],
		isGitRepo: true,
		fileTree: [],
		fileExplorerExpanded: [],
		messageQueue: [],
		...overrides,
	} as Session;
}

describe('AgentSessionsModal layer integration', () => {
	beforeEach(() => {
		layerState.registeredEscape = null;
		layerState.updatedEscape = null;
		layerState.unregisterLayer.mockClear();
		layerState.updateLayerHandler.mockClear();
		vi.clearAllMocks();
		vi.spyOn(globalThis.console, 'log').mockImplementation(() => {});
		vi.spyOn(globalThis.console, 'error').mockImplementation(() => {});
		vi.mocked(window.maestro.claude.getSessionOrigins).mockResolvedValue({});
		vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
			sessions: [
				{
					sessionId: 'layer-session',
					projectPath: '/repo',
					timestamp: '2026-05-01T12:00:00.000Z',
					modifiedAt: '2026-05-02T12:00:00.000Z',
					firstMessage: 'Layer task',
					messageCount: 1,
					sizeBytes: 1024,
					sessionName: 'Layer Session',
				},
			],
			hasMore: false,
			totalCount: 1,
			nextCursor: null,
		});
		vi.mocked(window.maestro.agentSessions.read).mockResolvedValue({
			messages: [
				{
					type: 'user',
					role: 'user',
					content: 'Layer prompt',
					timestamp: '2026-05-02T12:00:00.000Z',
					uuid: 'message-1',
				},
			],
			total: 1,
			hasMore: false,
		});
	});

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	it('routes registered Escape through close and back-out behavior', async () => {
		const onClose = vi.fn();
		const { unmount } = render(
			<AgentSessionsModal
				theme={theme}
				activeSession={activeSession()}
				onClose={onClose}
				onResumeSession={vi.fn()}
			/>
		);

		await screen.findByText('Layer Session');
		act(() => {
			layerState.registeredEscape?.();
		});
		expect(onClose).toHaveBeenCalledTimes(1);

		fireEvent.click(screen.getByText('Layer Session'));
		await screen.findByText('Layer prompt');
		act(() => {
			layerState.updatedEscape?.();
		});
		await screen.findByPlaceholderText('Search Integration Agent sessions...');

		act(() => {
			layerState.updatedEscape?.();
		});
		expect(onClose).toHaveBeenCalledTimes(2);

		unmount();
		expect(layerState.unregisterLayer).toHaveBeenCalledWith('agent-sessions-layer');
		await waitFor(() =>
			expect(layerState.updateLayerHandler).toHaveBeenCalledWith(
				'agent-sessions-layer',
				expect.any(Function)
			)
		);
	});
});

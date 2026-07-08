import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { SendToAgentModal } from '../../../renderer/components/SendToAgentModal';
import type { Session, Theme } from '../../../renderer/types';

const layerMocks = vi.hoisted(() => ({
	registerLayer: vi.fn(() => 'send-layer'),
	unregisterLayer: vi.fn(),
	updateLayerHandler: vi.fn(),
}));

vi.mock('../../../renderer/contexts/LayerStackContext', () => ({
	useLayerStack: () => ({
		registerLayer: layerMocks.registerLayer,
		unregisterLayer: layerMocks.unregisterLayer,
		updateLayerHandler: layerMocks.updateLayerHandler,
	}),
}));

const theme: Theme = {
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#1e1e1e',
		bgSidebar: '#252526',
		bgActivity: '#333333',
		textMain: '#d4d4d4',
		textDim: '#808080',
		accent: '#007acc',
		accentForeground: '#ffffff',
		border: '#404040',
		error: '#f14c4c',
		warning: '#cca700',
		success: '#89d185',
	},
};

const createSession = (overrides: Partial<Session> = {}): Session =>
	({
		id: 'source-session',
		name: 'Source Session',
		toolType: 'claude-code',
		state: 'idle',
		cwd: '/test/source',
		fullPath: '/test/source',
		projectRoot: '/test/source',
		aiLogs: [],
		shellLogs: [],
		workLog: [],
		contextUsage: 0,
		inputMode: 'ai',
		aiPid: 0,
		terminalPid: 0,
		port: 0,
		isLive: false,
		changedFiles: [],
		isGitRepo: true,
		fileTree: [],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		activeTimeMs: 0,
		executionQueue: [],
		aiTabs: [
			{
				id: 'tab-1',
				agentSessionId: 'session-abc-123',
				name: 'Source Tab',
				starred: false,
				logs: [],
				inputValue: '',
				stagedImages: [],
				createdAt: Date.now(),
				state: 'idle',
			},
		],
		activeTabId: 'tab-1',
		closedTabHistory: [],
		...overrides,
	}) as Session;

describe('SendToAgentModal layer registration seam', () => {
	it('uses the registered escape handler and unregisters on unmount', () => {
		const onClose = vi.fn();

		const { unmount } = render(
			<SendToAgentModal
				theme={theme}
				isOpen
				sourceSession={createSession()}
				sourceTabId="tab-1"
				allSessions={[
					createSession({
						id: 'target-session',
						name: 'Target Session',
						toolType: 'codex',
						projectRoot: '/test/target',
					}),
				]}
				onClose={onClose}
				onSend={vi.fn()}
			/>
		);

		const registeredLayer = layerMocks.registerLayer.mock.calls[0][0];
		registeredLayer.onEscape();
		unmount();

		expect(onClose).toHaveBeenCalledTimes(1);
		expect(layerMocks.unregisterLayer).toHaveBeenCalledWith('send-layer');
	});
});

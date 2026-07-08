import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useRemoteIntegration } from '../../renderer/hooks/remote/useRemoteIntegration';
import type { UseRemoteIntegrationDeps } from '../../renderer/hooks/remote/useRemoteIntegration';
import type { AITab, Session } from '../../renderer/types';

const tabHelperMocks = vi.hoisted(() => ({
	createTab: vi.fn(),
}));

vi.mock('../../renderer/utils/tabHelpers', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../renderer/utils/tabHelpers')>();
	return {
		...actual,
		createTab: tabHelperMocks.createTab,
	};
});

const listeners = vi.hoisted(() => ({
	newTab: undefined as ((sessionId: string, responseChannel: string) => void) | undefined,
}));

const createTab = (overrides: Partial<AITab> = {}): AITab => ({
	id: 'tab-1',
	agentSessionId: 'agent-session-1',
	name: null,
	starred: false,
	logs: [],
	inputValue: '',
	stagedImages: [],
	createdAt: 1700000000000,
	state: 'idle',
	saveToHistory: true,
	showThinking: 'off',
	...overrides,
});

const createSession = (overrides: Partial<Session> = {}): Session => {
	const tab = createTab();
	return {
		id: 'session-1',
		name: 'Remote Session',
		toolType: 'claude-code',
		state: 'idle',
		cwd: '/workspace/project',
		fullPath: '/workspace/project',
		projectRoot: '/workspace/project',
		createdAt: 1700000000000,
		aiLogs: [],
		shellLogs: [],
		workLog: [],
		contextUsage: 0,
		inputMode: 'ai',
		aiPid: 0,
		terminalPid: 0,
		port: 0,
		isLive: true,
		changedFiles: [],
		isGitRepo: true,
		fileTree: [],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		aiTabs: [tab],
		activeTabId: tab.id,
		closedTabHistory: [],
		executionQueue: [],
		activeTimeMs: 0,
		filePreviewTabs: [],
		activeFileTabId: null,
		unifiedTabOrder: [],
		unifiedClosedTabHistory: [],
		...overrides,
	} as Session;
};

function createHarness(session = createSession()): UseRemoteIntegrationDeps {
	const sessionsRef = { current: [session] };
	const activeSessionIdRef = { current: session.id };
	return {
		activeSessionId: session.id,
		isLiveMode: false,
		sessionsRef,
		activeSessionIdRef,
		setSessions: vi.fn((updater: React.SetStateAction<Session[]>) => {
			sessionsRef.current = typeof updater === 'function' ? updater(sessionsRef.current) : updater;
		}),
		setActiveSessionId: vi.fn((id: string) => {
			activeSessionIdRef.current = id;
		}),
		defaultSaveToHistory: true,
		defaultShowThinking: 'off',
	};
}

describe('useRemoteIntegration createTab fallback integration', () => {
	const originalMaestro = window.maestro;

	beforeEach(() => {
		listeners.newTab = undefined;
		tabHelperMocks.createTab.mockReturnValue(null);
		vi.spyOn(console, 'log').mockImplementation(() => {});
		window.maestro = {
			...originalMaestro,
			live: {
				...originalMaestro.live,
				broadcastActiveSession: vi.fn(),
			},
			web: {
				...originalMaestro.web,
				broadcastSessionState: vi.fn(),
				broadcastTabsChange: vi.fn(),
			},
			process: {
				...originalMaestro.process,
				interrupt: vi.fn(),
				sendRemoteNewTabResponse: vi.fn(),
				onRemoteCommand: vi.fn(() => vi.fn()),
				onRemoteSwitchMode: vi.fn(() => vi.fn()),
				onRemoteInterrupt: vi.fn(() => vi.fn()),
				onRemoteSelectSession: vi.fn(() => vi.fn()),
				onRemoteSelectTab: vi.fn(() => vi.fn()),
				onRemoteNewTab: vi.fn((handler) => {
					listeners.newTab = handler;
					return vi.fn();
				}),
				onRemoteCloseTab: vi.fn(() => vi.fn()),
				onRemoteRenameTab: vi.fn(() => vi.fn()),
				onRemoteStarTab: vi.fn(() => vi.fn()),
				onRemoteReorderTab: vi.fn(() => vi.fn()),
				onRemoteToggleBookmark: vi.fn(() => vi.fn()),
			},
		};
	});

	afterEach(() => {
		window.maestro = originalMaestro;
		vi.restoreAllMocks();
	});

	it('responds with null when the tab helper declines to create a remote tab', () => {
		const deps = createHarness();

		renderHook(() => useRemoteIntegration(deps));

		act(() => {
			listeners.newTab?.('session-1', 'new-tab-channel');
		});

		expect(tabHelperMocks.createTab).toHaveBeenCalledWith(
			expect.objectContaining({ id: 'session-1' }),
			{ saveToHistory: true, showThinking: 'off' }
		);
		expect(window.maestro.process.sendRemoteNewTabResponse).toHaveBeenCalledWith(
			'new-tab-channel',
			null
		);
		expect(deps.sessionsRef.current[0].aiTabs).toHaveLength(1);
	});
});

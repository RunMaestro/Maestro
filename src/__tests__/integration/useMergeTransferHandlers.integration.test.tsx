import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mergeHookMock = vi.hoisted(() => ({
	options: undefined as any,
	executeMerge: vi.fn(),
	cancelTab: vi.fn(),
	cancelMerge: vi.fn(),
	clearTabState: vi.fn(),
	reset: vi.fn(),
}));

const transferHookMock = vi.hoisted(() => ({
	options: undefined as any,
	cancelTransfer: vi.fn(),
	reset: vi.fn(),
}));

vi.mock('../../renderer/hooks/agent/useMergeSession', () => ({
	useMergeSessionWithSessions: vi.fn((options) => {
		mergeHookMock.options = options;
		return {
			mergeState: 'idle',
			progress: null,
			error: null,
			startTime: 0,
			sourceName: undefined,
			targetName: undefined,
			executeMerge: mergeHookMock.executeMerge,
			cancelTab: mergeHookMock.cancelTab,
			cancelMerge: mergeHookMock.cancelMerge,
			clearTabState: mergeHookMock.clearTabState,
			reset: mergeHookMock.reset,
		};
	}),
}));

vi.mock('../../renderer/hooks/agent/useSendToAgent', () => ({
	useSendToAgentWithSessions: vi.fn((options) => {
		transferHookMock.options = options;
		return {
			transferState: 'idle',
			progress: null,
			error: null,
			executeTransfer: vi.fn(),
			cancelTransfer: transferHookMock.cancelTransfer,
			reset: transferHookMock.reset,
		};
	}),
}));

vi.mock('../../renderer/utils/sentry', () => ({
	captureException: vi.fn(),
}));

import { useMergeTransferHandlers } from '../../renderer/hooks/agent/useMergeTransferHandlers';
import { useModalStore, getModalActions } from '../../renderer/stores/modalStore';
import { useNotificationStore } from '../../renderer/stores/notificationStore';
import { useSessionStore } from '../../renderer/stores/sessionStore';
import type { AITab, LogEntry, Session } from '../../renderer/types';
import { captureException } from '../../renderer/utils/sentry';

function log(id: string, source: LogEntry['source'], text: string): LogEntry {
	return { id, source, text, timestamp: 1000 };
}

function aiTab(overrides: Partial<AITab> = {}): AITab {
	return {
		id: 'source-tab',
		agentSessionId: null,
		name: 'Working Tab',
		starred: false,
		logs: [
			log('system-log', 'system', 'System prompt should not transfer'),
			log('empty-user', 'user', '   '),
			log('user-log', 'user', 'Build the transfer flow.'),
			log('ai-log', 'ai', 'The transfer flow is implemented.'),
			log('stdout-log', 'stdout', 'Integration output'),
		],
		inputValue: '',
		stagedImages: [],
		createdAt: 1000,
		state: 'idle',
		hasUnread: false,
		isAtBottom: true,
		saveToHistory: true,
		showThinking: 'off',
		...overrides,
	};
}

function session(overrides: Partial<Session> = {}): Session {
	const aiTabs = overrides.aiTabs ?? [aiTab()];
	const activeTabId = overrides.activeTabId ?? aiTabs[0]?.id ?? '';
	return {
		id: 'source',
		name: 'Source Session',
		toolType: 'claude-code',
		state: 'idle',
		cwd: '/repo/source',
		fullPath: '/repo/source',
		projectRoot: '/repo/source',
		createdAt: 1000,
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
		isGitRepo: false,
		fileTree: [],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		executionQueue: [],
		activeTimeMs: 0,
		aiTabs,
		activeTabId,
		closedTabHistory: [],
		filePreviewTabs: [],
		activeFileTabId: null,
		unifiedTabOrder: aiTabs.map((tab) => ({ type: 'ai' as const, id: tab.id })),
		unifiedClosedTabHistory: [],
		shellCommandHistory: [],
		aiCommandHistory: [],
		shellCwd: '/repo/source',
		...overrides,
	};
}

function targetSession(overrides: Partial<Session> = {}): Session {
	return session({
		id: 'target',
		name: 'Target Session',
		toolType: 'codex',
		cwd: '/repo/target',
		fullPath: '/repo/target',
		projectRoot: '/repo/target',
		aiTabs: [aiTab({ id: 'target-tab', logs: [], name: 'Target Tab' })],
		activeTabId: 'target-tab',
		unifiedTabOrder: [{ type: 'ai', id: 'target-tab' }],
		...overrides,
	});
}

function setStoreSessions(sessions: Session[], activeSessionId = sessions[0]?.id ?? '') {
	useSessionStore.setState({
		sessions,
		activeSessionId,
		groups: [],
	});
}

function renderHandlers(sessions: Session[], activeSessionId = sessions[0]?.id ?? '') {
	const sessionsRef = { current: sessions };
	const activeSessionIdRef = { current: activeSessionId };
	const setActiveSessionId = vi.fn((id: string) => {
		activeSessionIdRef.current = id;
		useSessionStore.setState({ activeSessionId: id });
	});

	act(() => setStoreSessions(sessions, activeSessionId));

	const rendered = renderHook(() =>
		useMergeTransferHandlers({
			sessionsRef,
			activeSessionIdRef,
			setActiveSessionId,
		})
	);

	return { ...rendered, sessionsRef, activeSessionIdRef, setActiveSessionId };
}

function activeSession(): Session | undefined {
	const state = useSessionStore.getState();
	return state.sessions.find((item) => item.id === state.activeSessionId);
}

function sessionById(id: string): Session | undefined {
	return useSessionStore.getState().sessions.find((item) => item.id === id);
}

async function flushAsyncTurns(turns = 3) {
	for (let index = 0; index < turns; index += 1) {
		await Promise.resolve();
	}
}

describe('useMergeTransferHandlers integration', () => {
	let originalMaestro: typeof window.maestro;

	beforeEach(() => {
		vi.useFakeTimers({ now: Date.parse('2026-05-26T12:00:00.000Z') });
		vi.clearAllMocks();
		mergeHookMock.options = undefined;
		mergeHookMock.executeMerge.mockResolvedValue({ success: true });
		transferHookMock.options = undefined;
		vi.mocked(captureException).mockClear();
		useModalStore.setState({ modals: new Map() });
		useNotificationStore.setState({
			toasts: [],
			config: {
				defaultDuration: 0,
				audioFeedbackEnabled: false,
				audioFeedbackCommand: '',
				osNotificationsEnabled: false,
			},
		});
		originalMaestro = window.maestro;
		window.maestro = {
			...window.maestro,
			agents: {
				...window.maestro.agents,
				get: vi.fn().mockResolvedValue({
					id: 'codex',
					command: 'codex',
					path: '/usr/local/bin/codex',
					args: ['--json'],
				}),
			},
			process: {
				...window.maestro.process,
				spawn: vi.fn().mockResolvedValue(undefined),
			},
			notification: {
				...window.maestro.notification,
				show: vi.fn().mockResolvedValue(undefined),
			},
			logger: {
				...window.maestro.logger,
				toast: vi.fn().mockResolvedValue(undefined),
			},
		} as typeof window.maestro;
	});

	afterEach(() => {
		cleanup();
		vi.useRealTimers();
		window.maestro = originalMaestro;
		setStoreSessions([], '');
		useModalStore.setState({ modals: new Map() });
		useNotificationStore.getState().clearToasts();
	});

	it('handles merge creation and merge-complete callbacks through real stores', () => {
		const source = session();
		const target = targetSession();
		const { setActiveSessionId } = renderHandlers([source, target], source.id);

		act(() => getModalActions().setMergeSessionModalOpen(true));
		expect(useModalStore.getState().isOpen('mergeSession')).toBe(true);

		act(() => {
			mergeHookMock.options.onSessionCreated({
				sessionId: 'merged-session',
				sessionName: 'Merged Session',
				estimatedTokens: 12_345,
				tokensSaved: 678,
				sourceSessionName: source.name,
				targetSessionName: target.name,
			});
		});

		expect(setActiveSessionId).toHaveBeenCalledWith('merged-session');
		expect(useModalStore.getState().isOpen('mergeSession')).toBe(false);
		expect(useNotificationStore.getState().toasts.at(-1)).toMatchObject({
			type: 'success',
			title: 'Session Merged',
			sessionId: 'merged-session',
		});
		expect(window.maestro.notification.show).toHaveBeenCalledWith(
			'Session Merged',
			'Created "Merged Session" with merged context'
		);

		act(() => vi.advanceTimersByTime(1000));
		expect(mergeHookMock.clearTabState).toHaveBeenCalledWith(source.activeTabId);

		act(() => {
			mergeHookMock.options.onMergeComplete(source.activeTabId, {
				success: true,
				targetSessionId: target.id,
				targetTabId: 'target-merged-tab',
				estimatedTokens: 900,
				tokensSaved: 100,
				sourceSessionName: source.name,
				targetSessionName: target.name,
			});
		});

		expect(setActiveSessionId).toHaveBeenCalledWith(target.id);
		expect(sessionById(target.id)?.activeTabId).toBe('target-merged-tab');
		expect(useNotificationStore.getState().toasts.at(-1)).toMatchObject({
			type: 'success',
			title: 'Context Merged',
		});

		act(() => vi.advanceTimersByTime(1000));
		expect(mergeHookMock.clearTabState).toHaveBeenCalledWith(source.activeTabId);
	});

	it('covers merge callback fallback text and ignored incomplete merge results', () => {
		const source = session();
		const target = targetSession();
		const { setActiveSessionId } = renderHandlers([source, target], source.id);

		act(() => {
			mergeHookMock.options.onSessionCreated({
				sessionId: 'merged-minimal',
				sessionName: 'Minimal Merge',
			});
		});

		expect(setActiveSessionId).toHaveBeenCalledWith('merged-minimal');
		expect(useNotificationStore.getState().toasts.at(-1)?.message).toContain(
			'Created "Minimal Merge" from Minimal Merge.'
		);

		act(() => {
			mergeHookMock.options.onMergeComplete(source.activeTabId, {
				success: true,
				targetSessionId: target.id,
			});
		});

		expect(sessionById(target.id)?.activeTabId).toBe('target-tab');
		expect(useNotificationStore.getState().toasts.at(-1)?.message).toContain(
			'"Current Session" → "Selected Session".'
		);

		const toastCount = useNotificationStore.getState().toasts.length;
		act(() => {
			mergeHookMock.options.onMergeComplete(source.activeTabId, {
				success: false,
				targetSessionId: target.id,
			});
		});
		expect(useNotificationStore.getState().toasts).toHaveLength(toastCount);
	});

	it('closes merge state and reports merge validation and execution failures', async () => {
		const source = session();
		const target = targetSession();
		const { result } = renderHandlers([source, target], source.id);

		act(() => getModalActions().setMergeSessionModalOpen(true));
		act(() => result.current.handleCloseMergeSession());
		expect(useModalStore.getState().isOpen('mergeSession')).toBe(false);
		expect(mergeHookMock.reset).toHaveBeenCalledOnce();

		mergeHookMock.executeMerge.mockResolvedValueOnce({
			success: false,
			error: 'Merge service failed',
		});
		let mergeResult: Awaited<ReturnType<typeof result.current.handleMerge>>;
		await act(async () => {
			mergeResult = await result.current.handleMerge(target.id, 'target-tab', {
				createNewSession: false,
				groomContext: true,
				preserveTimestamps: false,
			});
		});

		expect(mergeHookMock.executeMerge).toHaveBeenCalledWith(
			source,
			source.activeTabId,
			target.id,
			'target-tab',
			{
				createNewSession: false,
				groomContext: true,
				preserveTimestamps: false,
			}
		);
		expect(mergeResult!).toEqual({ success: false, error: 'Merge service failed' });
		expect(useNotificationStore.getState().toasts.at(-1)).toMatchObject({
			type: 'error',
			title: 'Merge Failed',
			message: 'Merge service failed',
		});

		mergeHookMock.executeMerge.mockResolvedValueOnce({ success: false });
		await act(async () => {
			await result.current.handleMerge(target.id, undefined, {
				createNewSession: false,
				groomContext: false,
				preserveTimestamps: true,
			});
		});
		expect(useNotificationStore.getState().toasts.at(-1)).toMatchObject({
			type: 'error',
			title: 'Merge Failed',
			message: 'Failed to merge contexts',
		});

		mergeHookMock.executeMerge.mockResolvedValueOnce({ success: true });
		await act(async () => {
			await result.current.handleMerge(target.id, undefined, {
				createNewSession: true,
				groomContext: false,
				preserveTimestamps: false,
			});
		});

		const empty = renderHandlers([], '');
		let inactiveResult: Awaited<ReturnType<typeof empty.result.current.handleMerge>>;
		await act(async () => {
			inactiveResult = await empty.result.current.handleMerge(target.id, undefined, {
				createNewSession: true,
				groomContext: false,
				preserveTimestamps: true,
			});
		});
		expect(inactiveResult!).toEqual({ success: false, error: 'No active session' });
	});

	it('handles transfer controls and transfer-created callback cleanup', () => {
		const source = session();
		const target = targetSession();
		const { result, setActiveSessionId } = renderHandlers([source, target], source.id);

		act(() => result.current.handleCancelTransfer());
		expect(transferHookMock.cancelTransfer).toHaveBeenCalledOnce();
		expect(result.current.transferSourceAgent).toBeNull();
		expect(result.current.transferTargetAgent).toBeNull();

		act(() => result.current.handleCompleteTransfer());
		expect(transferHookMock.reset).toHaveBeenCalledOnce();

		act(() => getModalActions().setSendToAgentModalOpen(true));
		act(() => {
			transferHookMock.options.onSessionCreated('transfer-session', 'Transferred Context');
		});

		expect(setActiveSessionId).toHaveBeenCalledWith('transfer-session');
		expect(useModalStore.getState().isOpen('sendToAgent')).toBe(false);
		expect(useNotificationStore.getState().toasts.at(-1)).toMatchObject({
			type: 'success',
			title: 'Context Transferred',
		});
		expect(window.maestro.notification.show).toHaveBeenCalledWith(
			'Context Transferred',
			'Created "Transferred Context" with transferred context'
		);

		act(() => vi.advanceTimersByTime(1500));
		expect(transferHookMock.reset).toHaveBeenCalledTimes(2);
		expect(result.current.transferSourceAgent).toBeNull();
		expect(result.current.transferTargetAgent).toBeNull();
	});

	it('validates send-to-agent prerequisites before mutating target tabs', async () => {
		const source = session();
		const target = targetSession();

		const empty = renderHandlers([], '');
		act(() => getModalActions().setSendToAgentModalOpen(true));
		let inactiveResult: Awaited<ReturnType<typeof empty.result.current.handleSendToAgent>>;
		await act(async () => {
			inactiveResult = await empty.result.current.handleSendToAgent(target.id, {
				targetSessionId: target.id,
				groomContext: false,
			});
		});
		expect(inactiveResult!).toEqual({ success: false, error: 'No active session' });
		expect(useModalStore.getState().isOpen('sendToAgent')).toBe(false);

		const missingTarget = renderHandlers([source], source.id);
		let missingTargetResult: Awaited<
			ReturnType<typeof missingTarget.result.current.handleSendToAgent>
		>;
		await act(async () => {
			missingTargetResult = await missingTarget.result.current.handleSendToAgent('missing', {
				targetSessionId: 'missing',
				groomContext: false,
			});
		});
		expect(missingTargetResult!).toEqual({ success: false, error: 'Target session not found' });

		const missingTabSource = session({ activeTabId: 'missing-tab' });
		const missingTab = renderHandlers([missingTabSource, target], missingTabSource.id);
		let missingTabResult: Awaited<ReturnType<typeof missingTab.result.current.handleSendToAgent>>;
		await act(async () => {
			missingTabResult = await missingTab.result.current.handleSendToAgent(target.id, {
				targetSessionId: target.id,
				groomContext: true,
			});
		});
		expect(missingTabResult!).toEqual({ success: false, error: 'Source tab not found' });
		expect(missingTab.result.current.transferSourceAgent).toBeNull();
		expect(missingTab.result.current.transferTargetAgent).toBeNull();
	});

	it('creates a target tab and sends filtered context to the target agent', async () => {
		const source = session();
		const target = targetSession({ isGitRepo: true });
		const { result, setActiveSessionId } = renderHandlers([source, target], source.id);

		let transferResult: Awaited<ReturnType<typeof result.current.handleSendToAgent>>;
		await act(async () => {
			transferResult = await result.current.handleSendToAgent(target.id, {
				targetSessionId: target.id,
				groomContext: true,
			});
			await flushAsyncTurns();
		});

		expect(transferResult!.success).toBe(true);
		expect(transferResult!.newSessionId).toBe(target.id);
		expect(transferResult!.newTabId).toMatch(/^tab-/);
		expect(setActiveSessionId).toHaveBeenCalledWith(target.id);

		const updatedTarget = sessionById(target.id)!;
		const createdTab = updatedTarget.aiTabs.find((tab) => tab.id === transferResult!.newTabId)!;
		expect(updatedTarget.state).toBe('busy');
		expect(updatedTarget.activeTabId).toBe(createdTab.id);
		expect(createdTab.state).toBe('busy');
		expect(createdTab.awaitingSessionId).toBe(true);
		expect(createdTab.logs[0].text).toContain('cleaned to reduce size');
		expect(createdTab.logs[1].text).toContain('User: Build the transfer flow.');
		expect(createdTab.logs[1].text).toContain('Assistant: The transfer flow is implemented.');
		expect(createdTab.logs[1].text).toContain('Assistant: Integration output');
		expect(createdTab.logs[1].text).not.toContain('System prompt should not transfer');
		expect(useNotificationStore.getState().toasts.at(-1)).toMatchObject({
			type: 'success',
			title: 'Context Sent',
			sessionId: target.id,
			tabId: createdTab.id,
		});
		expect(transferHookMock.reset).toHaveBeenCalled();
		expect(window.maestro.process.spawn).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: `${target.id}-ai-${createdTab.id}`,
				toolType: target.toolType,
				cwd: target.cwd,
				command: '/usr/local/bin/codex',
				args: ['--json'],
				prompt: expect.stringContaining('Build the transfer flow.'),
			})
		);
	});

	it('records a system error on the created tab when target agent spawn setup fails', async () => {
		const source = session();
		const target = targetSession();
		const { result } = renderHandlers([source, target], source.id);
		vi.mocked(window.maestro.agents.get).mockResolvedValueOnce(null as any);

		let transferResult: Awaited<ReturnType<typeof result.current.handleSendToAgent>>;
		await act(async () => {
			transferResult = await result.current.handleSendToAgent(target.id, {
				targetSessionId: target.id,
				groomContext: false,
			});
			await flushAsyncTurns();
		});

		expect(transferResult!.success).toBe(true);
		const updatedTarget = sessionById(target.id)!;
		const createdTab = updatedTarget.aiTabs.find((tab) => tab.id === transferResult!.newTabId)!;
		expect(updatedTarget.state).toBe('idle');
		expect(createdTab.state).toBe('idle');
		expect(createdTab.logs.at(-1)).toMatchObject({
			source: 'system',
			text: 'Error: Failed to spawn agent - codex agent not found',
		});
		expect(captureException).toHaveBeenCalledWith(
			expect.any(Error),
			expect.objectContaining({
				extra: expect.objectContaining({ operation: 'context-transfer-spawn' }),
			})
		);
	});

	it('transfers empty context through fallback names, tab order, and agent defaults', async () => {
		const source = session({
			name: '',
			projectRoot: '/repo/fallback-source',
			aiTabs: [
				aiTab({
					logs: [log('system-only', 'system', 'Only system content'), log('blank', 'user', ' ')],
				}),
			],
		});
		const target = targetSession({ unifiedTabOrder: undefined });
		const { result } = renderHandlers([source, target], source.id);
		vi.mocked(window.maestro.agents.get).mockResolvedValueOnce({
			id: 'codex',
			command: 'codex',
			path: '',
		} as any);

		let transferResult: Awaited<ReturnType<typeof result.current.handleSendToAgent>>;
		await act(async () => {
			transferResult = await result.current.handleSendToAgent(target.id, {
				targetSessionId: target.id,
				groomContext: false,
			});
			await flushAsyncTurns();
		});

		const updatedTarget = sessionById(target.id)!;
		const createdTab = updatedTarget.aiTabs.find((tab) => tab.id === transferResult!.newTabId)!;
		expect(createdTab.name).toBe('From: fallback-source');
		expect(createdTab.logs[1].text).toBe('No context available from the previous session.');
		expect(updatedTarget.unifiedTabOrder).toEqual([{ type: 'ai', id: createdTab.id }]);
		expect(window.maestro.process.spawn).toHaveBeenCalledWith(
			expect.objectContaining({
				command: 'codex',
				args: [],
			})
		);
	});

	it('handles merge creation without an active tab and unknown transfer source names', async () => {
		const empty = renderHandlers([], '');
		act(() => {
			mergeHookMock.options.onSessionCreated({
				sessionId: 'orphan-merge',
				sessionName: 'Orphan Merge',
			});
			vi.advanceTimersByTime(1000);
		});

		expect(empty.setActiveSessionId).toHaveBeenCalledWith('orphan-merge');
		expect(mergeHookMock.clearTabState).not.toHaveBeenCalled();

		const source = session({
			name: '',
			projectRoot: '',
			aiTabs: [aiTab({ logs: [] })],
		});
		const target = targetSession();
		const { result } = renderHandlers([source, target], source.id);

		let transferResult: Awaited<ReturnType<typeof result.current.handleSendToAgent>>;
		await act(async () => {
			transferResult = await result.current.handleSendToAgent(target.id, {
				targetSessionId: target.id,
				groomContext: false,
			});
			await flushAsyncTurns();
		});

		const createdTab = sessionById(target.id)!.aiTabs.find(
			(tab) => tab.id === transferResult!.newTabId
		)!;
		expect(createdTab.name).toBe('From: Unknown');
	});

	it('switches tab context before opening merge and send-to-agent modals', () => {
		const source = session({
			aiTabs: [aiTab({ id: 'tab-a' }), aiTab({ id: 'tab-b' })],
			activeTabId: 'tab-a',
			unifiedTabOrder: [
				{ type: 'ai', id: 'tab-a' },
				{ type: 'ai', id: 'tab-b' },
			],
		});
		const target = targetSession();
		const { result, activeSessionIdRef } = renderHandlers([source, target], source.id);

		act(() => result.current.handleMergeWith('tab-b'));
		expect(activeSession()?.activeTabId).toBe('tab-b');
		expect(useModalStore.getState().isOpen('mergeSession')).toBe(true);

		act(() => result.current.handleOpenSendToAgentModal('tab-a'));
		expect(activeSession()?.activeTabId).toBe('tab-a');
		expect(useModalStore.getState().isOpen('sendToAgent')).toBe(true);

		activeSessionIdRef.current = 'missing-session';
		act(() => result.current.handleMergeWith('tab-b'));
		act(() => result.current.handleOpenSendToAgentModal('tab-b'));
		expect(activeSession()?.activeTabId).toBe('tab-a');
	});
});

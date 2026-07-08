import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const idMock = vi.hoisted(() => ({
	counter: 0,
	generateId: vi.fn(() => `interrupt-id-${++idMock.counter}`),
}));

vi.mock('../../renderer/utils/ids', () => ({
	generateId: idMock.generateId,
}));

import { useInterruptHandler } from '../../renderer/hooks/agent/useInterruptHandler';
import type { UseInterruptHandlerDeps } from '../../renderer/hooks/agent/useInterruptHandler';
import { useSessionStore } from '../../renderer/stores/sessionStore';
import type { AITab, LogEntry, QueuedItem, Session } from '../../renderer/types';

const originalConfirm = window.confirm;
const maestroMock = {
	process: {
		interrupt: vi.fn().mockResolvedValue(undefined),
		kill: vi.fn().mockResolvedValue(undefined),
	},
	logger: {
		log: vi.fn(),
	},
};

function aiTab(overrides: Partial<AITab> = {}): AITab {
	return {
		id: 'tab-a',
		agentSessionId: null,
		name: 'Tab A',
		starred: false,
		logs: [],
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
		id: 'session-a',
		name: 'Interrupt Session',
		toolType: 'claude-code',
		state: 'busy',
		cwd: '/repo',
		fullPath: '/repo',
		projectRoot: '/repo',
		createdAt: 1000,
		aiLogs: [],
		shellLogs: [],
		workLog: [],
		contextUsage: 0,
		inputMode: 'ai',
		aiPid: 1,
		terminalPid: 2,
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
		shellCwd: '/repo',
		...overrides,
	};
}

function log(source: LogEntry['source'], text: string, id = `${source}-${text}`): LogEntry {
	return { id, timestamp: 1, source, text };
}

function deps(
	sessions: Session[],
	overrides: Partial<UseInterruptHandlerDeps> = {}
): UseInterruptHandlerDeps {
	return {
		sessionsRef: { current: sessions },
		cancelPendingSynopsis: vi.fn().mockResolvedValue(undefined),
		processQueuedItem: vi.fn().mockResolvedValue(undefined),
		...overrides,
	};
}

function renderInterruptHook(
	sessions: Session[],
	activeSessionId = sessions[0]?.id ?? '',
	overrides: Partial<UseInterruptHandlerDeps> = {}
) {
	act(() => {
		useSessionStore.setState({ sessions, activeSessionId, groups: [] });
	});
	const hookDeps = deps(sessions, overrides);
	const rendered = renderHook(() => useInterruptHandler(hookDeps));
	return { ...rendered, deps: hookDeps };
}

function currentSession(id = useSessionStore.getState().activeSessionId): Session {
	return useSessionStore.getState().sessions.find((item) => item.id === id)!;
}

async function interrupt(result: ReturnType<typeof renderInterruptHook>['result']) {
	await act(async () => {
		await result.current.handleInterrupt();
	});
}

describe('useInterruptHandler integration', () => {
	beforeEach(() => {
		idMock.counter = 0;
		vi.clearAllMocks();
		(window as any).maestro = maestroMock;
		window.confirm = originalConfirm;
		useSessionStore.setState({ sessions: [], activeSessionId: '', groups: [] });
	});

	afterEach(() => {
		cleanup();
		vi.useRealTimers();
		window.confirm = originalConfirm;
		useSessionStore.setState({ sessions: [], activeSessionId: '', groups: [] });
	});

	it('does nothing without an active session', async () => {
		const rendered = renderInterruptHook([], '');

		await interrupt(rendered.result);

		expect(maestroMock.process.interrupt).not.toHaveBeenCalled();
		expect(rendered.deps.cancelPendingSynopsis).not.toHaveBeenCalled();
	});

	it('interrupts an AI tab, tolerates synopsis cancellation failure, and cleans only active/busy tabs', async () => {
		const activeTab = aiTab({
			id: 'active-tab',
			state: 'busy',
			logs: [
				log('user', 'keep user'),
				log('thinking', 'remove thinking'),
				log('tool', 'remove tool'),
			],
		});
		const otherBusyTab = aiTab({
			id: 'other-busy',
			state: 'busy',
			logs: [log('thinking', 'remove other'), log('ai', 'keep other ai')],
		});
		const idleTab = aiTab({ id: 'idle-tab', state: 'idle', logs: [log('ai', 'idle stays')] });
		const active = session({
			id: 'ai-session',
			aiTabs: [activeTab, otherBusyTab, idleTab],
			activeTabId: activeTab.id,
		});
		const other = session({
			id: 'other-session',
			aiTabs: [aiTab({ id: 'other-tab', state: 'busy' })],
		});
		const synopsisError = new Error('synopsis failed');
		const rendered = renderInterruptHook([active, other], active.id, {
			cancelPendingSynopsis: vi.fn().mockRejectedValue(synopsisError),
		});

		await interrupt(rendered.result);

		expect(maestroMock.process.interrupt).toHaveBeenCalledWith('ai-session-ai-active-tab');
		expect(maestroMock.logger.log).toHaveBeenCalledWith(
			'warn',
			'[useInterruptHandler] Failed to cancel pending synopsis:',
			undefined,
			synopsisError
		);
		const updated = currentSession(active.id);
		expect(updated.state).toBe('idle');
		expect(updated.busySource).toBeUndefined();
		expect(updated.thinkingStartTime).toBeUndefined();
		expect(
			updated.aiTabs.find((tab) => tab.id === activeTab.id)?.logs.map((item) => item.source)
		).toEqual(['user', 'system']);
		expect(updated.aiTabs.find((tab) => tab.id === otherBusyTab.id)?.logs).toEqual([
			log('ai', 'keep other ai'),
		]);
		expect(updated.aiTabs.find((tab) => tab.id === idleTab.id)).toEqual(idleTab);
		expect(currentSession(other.id)).toEqual(other);
	});

	it('uses the default AI target when there is no active tab', async () => {
		const active = session({ id: 'default-target', aiTabs: [], activeTabId: 'missing' });
		const rendered = renderInterruptHook([active], active.id);

		await interrupt(rendered.result);

		expect(maestroMock.process.interrupt).toHaveBeenCalledWith('default-target-ai-default');
		expect(currentSession(active.id).state).toBe('idle');
	});

	it('interrupts terminal mode without adding AI cancel logs', async () => {
		const active = session({
			id: 'terminal-session',
			inputMode: 'terminal',
			aiTabs: [aiTab({ id: 'terminal-tab', logs: [log('ai', 'keep')] })],
			activeTabId: 'terminal-tab',
		});
		const rendered = renderInterruptHook([active], active.id);

		await interrupt(rendered.result);

		expect(maestroMock.process.interrupt).toHaveBeenCalledWith('terminal-session-terminal');
		expect(currentSession(active.id).state).toBe('idle');
		expect(currentSession(active.id).aiTabs[0].logs).toEqual([log('ai', 'keep')]);
	});

	it('starts the next queued message, appends a user log, and reports processing failures', async () => {
		vi.useFakeTimers();
		const queueError = new Error('queue failed');
		const queuedItem: QueuedItem = {
			id: 'queued-message',
			type: 'message',
			text: 'Run the queued prompt',
			tabId: 'target-tab',
			images: ['image-a'],
		};
		const interruptedTab = aiTab({
			id: 'interrupted-tab',
			state: 'busy',
			logs: [log('thinking', 'remove'), log('ai', 'keep')],
		});
		const targetTab = aiTab({ id: 'target-tab', state: 'idle' });
		const idleTab = aiTab({ id: 'queue-idle-tab', state: 'idle', logs: [log('ai', 'idle stays')] });
		const active = session({
			id: 'queue-session',
			aiTabs: [interruptedTab, targetTab, idleTab],
			activeTabId: interruptedTab.id,
			executionQueue: [queuedItem],
		});
		const rendered = renderInterruptHook([active], active.id, {
			processQueuedItem: vi.fn().mockRejectedValue(queueError),
		});

		await interrupt(rendered.result);

		const updated = currentSession(active.id);
		expect(updated.state).toBe('busy');
		expect(updated.executionQueue).toEqual([]);
		expect(updated.currentCycleTokens).toBe(0);
		expect(updated.currentCycleBytes).toBe(0);
		expect(updated.aiTabs.find((tab) => tab.id === targetTab.id)?.state).toBe('busy');
		expect(
			updated.aiTabs
				.find((tab) => tab.id === targetTab.id)
				?.logs.some((item) => item.source === 'user' && item.text === queuedItem.text)
		).toBe(true);
		expect(updated.aiTabs.find((tab) => tab.id === interruptedTab.id)?.logs).toEqual([
			log('ai', 'keep'),
			expect.objectContaining({ source: 'system', text: 'Canceled by user' }),
		]);
		expect(updated.aiTabs.find((tab) => tab.id === idleTab.id)).toEqual(idleTab);

		await act(async () => {
			vi.runOnlyPendingTimers();
			await Promise.resolve();
		});
		expect(rendered.deps.processQueuedItem).toHaveBeenCalledWith(active.id, queuedItem);
		expect(maestroMock.logger.log).toHaveBeenCalledWith(
			'error',
			'[useInterruptHandler] Failed to process queued item:',
			undefined,
			queueError
		);
	});

	it('falls back to the active tab for queued items without a matching tab', async () => {
		const queuedItem: QueuedItem = {
			id: 'queued-fallback',
			type: 'command',
			command: '/status',
			commandDescription: 'Status',
			tabId: 'missing-tab',
		};
		const activeTab = aiTab({ id: 'fallback-tab', state: 'busy' });
		const active = session({
			id: 'queue-fallback-session',
			aiTabs: [activeTab],
			activeTabId: activeTab.id,
			executionQueue: [queuedItem],
		});
		const rendered = renderInterruptHook([active], active.id);

		await interrupt(rendered.result);

		expect(currentSession(active.id).state).toBe('busy');
		expect(currentSession(active.id).aiTabs[0].state).toBe('busy');
		expect(
			currentSession(active.id).aiTabs[0].logs.filter((item) => item.source === 'user')
		).toEqual([]);
	});

	it('keeps the session busy when a queued item has no target or active tab', async () => {
		vi.useFakeTimers();
		const queuedItem: QueuedItem = {
			id: 'queued-missing',
			type: 'message',
			text: 'No tab available',
			tabId: 'missing-tab',
		};
		const active = session({
			id: 'queue-missing-session',
			aiTabs: [],
			activeTabId: 'missing-active',
			executionQueue: [queuedItem],
		});
		const rendered = renderInterruptHook([active], active.id);

		await interrupt(rendered.result);

		expect(currentSession(active.id)).toEqual(
			expect.objectContaining({
				state: 'busy',
				busySource: 'ai',
				executionQueue: [],
				currentCycleTokens: 0,
				currentCycleBytes: 0,
			})
		);

		act(() => vi.runOnlyPendingTimers());
		expect(rendered.deps.processQueuedItem).toHaveBeenCalledWith(active.id, queuedItem);
	});

	it('asks before force killing when graceful interrupt fails and honors decline', async () => {
		maestroMock.process.interrupt.mockRejectedValueOnce(new Error('SIGINT failed'));
		window.confirm = vi.fn().mockReturnValue(false);
		const active = session({
			id: 'decline-kill-session',
			aiTabs: [aiTab({ id: 'decline-tab', state: 'busy' })],
			activeTabId: 'decline-tab',
		});
		const rendered = renderInterruptHook([active], active.id);

		await interrupt(rendered.result);

		expect(window.confirm).toHaveBeenCalledOnce();
		expect(maestroMock.process.kill).not.toHaveBeenCalled();
		expect(maestroMock.logger.log).toHaveBeenCalledWith(
			'error',
			'Failed to interrupt process:',
			undefined,
			expect.any(Error)
		);
	});

	it('force kills AI mode, appends a kill log, and clears interrupted busy tabs', async () => {
		maestroMock.process.interrupt.mockRejectedValueOnce(new Error('SIGINT failed'));
		window.confirm = vi.fn().mockReturnValue(true);
		const activeTab = aiTab({
			id: 'kill-tab',
			state: 'busy',
			logs: [log('thinking', 'remove'), log('ai', 'keep')],
		});
		const busyTab = aiTab({
			id: 'busy-kill-tab',
			state: 'busy',
			logs: [log('thinking', 'remove busy')],
		});
		const idleTab = aiTab({ id: 'idle-kill-tab', state: 'idle', logs: [log('ai', 'idle')] });
		const active = session({
			id: 'kill-session',
			aiTabs: [activeTab, busyTab, idleTab],
			activeTabId: activeTab.id,
		});
		const other = session({ id: 'other-kill-session' });
		const rendered = renderInterruptHook([active, other], active.id);

		await interrupt(rendered.result);

		expect(maestroMock.process.kill).toHaveBeenCalledWith('kill-session-ai-kill-tab');
		expect(currentSession(active.id).state).toBe('idle');
		expect(currentSession(active.id).aiTabs.find((tab) => tab.id === activeTab.id)?.logs).toEqual([
			log('ai', 'keep'),
			expect.objectContaining({ source: 'system', text: 'Process forcefully terminated' }),
		]);
		expect(currentSession(active.id).aiTabs.find((tab) => tab.id === busyTab.id)?.logs).toEqual([]);
		expect(currentSession(active.id).aiTabs.find((tab) => tab.id === idleTab.id)).toEqual(idleTab);
		expect(currentSession(other.id)).toEqual(other);
		expect(maestroMock.logger.log).toHaveBeenCalledWith(
			'error',
			'Failed to interrupt process:',
			undefined,
			expect.any(Error)
		);
	});

	it('force kills terminal mode by appending to shell logs', async () => {
		maestroMock.process.interrupt.mockRejectedValueOnce(new Error('SIGINT failed'));
		window.confirm = vi.fn().mockReturnValue(true);
		const active = session({
			id: 'terminal-kill-session',
			inputMode: 'terminal',
			shellLogs: [log('system', 'Ready')],
		});
		const rendered = renderInterruptHook([active], active.id);

		await interrupt(rendered.result);

		expect(maestroMock.process.kill).toHaveBeenCalledWith('terminal-kill-session-terminal');
		expect(currentSession(active.id).shellLogs.at(-1)).toEqual(
			expect.objectContaining({ source: 'system', text: 'Process forcefully terminated' })
		);
		expect(maestroMock.logger.log).toHaveBeenCalledWith(
			'error',
			'Failed to interrupt process:',
			undefined,
			expect.any(Error)
		);
	});

	it('processes queued items after force kill and logs processing failures', async () => {
		vi.useFakeTimers();
		const queueError = new Error('after kill failed');
		maestroMock.process.interrupt.mockRejectedValueOnce(new Error('SIGINT failed'));
		window.confirm = vi.fn().mockReturnValue(true);
		const queuedItem: QueuedItem = {
			id: 'kill-queued-message',
			type: 'message',
			text: 'Continue after kill',
			tabId: 'kill-target',
		};
		const active = session({
			id: 'kill-queue-session',
			aiTabs: [
				aiTab({ id: 'kill-source', state: 'busy' }),
				aiTab({ id: 'kill-target' }),
				aiTab({ id: 'kill-queue-idle', state: 'idle', logs: [log('ai', 'idle')] }),
			],
			activeTabId: 'kill-source',
			executionQueue: [queuedItem],
		});
		const rendered = renderInterruptHook([active], active.id, {
			processQueuedItem: vi.fn().mockRejectedValue(queueError),
		});

		await interrupt(rendered.result);

		expect(currentSession(active.id).state).toBe('busy');
		expect(currentSession(active.id).executionQueue).toEqual([]);
		expect(
			currentSession(active.id)
				.aiTabs.find((tab) => tab.id === 'kill-target')
				?.logs.some((item) => item.source === 'user' && item.text === queuedItem.text)
		).toBe(true);
		expect(
			currentSession(active.id).aiTabs.find((tab) => tab.id === 'kill-queue-idle')?.logs
		).toEqual([log('ai', 'idle')]);

		await act(async () => {
			vi.runOnlyPendingTimers();
			await Promise.resolve();
		});
		expect(rendered.deps.processQueuedItem).toHaveBeenCalledWith(active.id, queuedItem);
		expect(maestroMock.logger.log).toHaveBeenCalledWith(
			'error',
			'[useInterruptHandler] Failed to process queued item after kill:',
			undefined,
			queueError
		);
	});

	it('keeps force-killed sessions busy when the queued item has no target tab', async () => {
		maestroMock.process.interrupt.mockRejectedValueOnce(new Error('SIGINT failed'));
		window.confirm = vi.fn().mockReturnValue(true);
		const queuedItem: QueuedItem = {
			id: 'kill-queued-missing',
			type: 'command',
			command: '/status',
			commandDescription: 'Status',
			tabId: 'missing',
		};
		const active = session({
			id: 'kill-queue-missing-session',
			aiTabs: [],
			activeTabId: 'missing-active',
			executionQueue: [queuedItem],
		});
		const rendered = renderInterruptHook([active], active.id);

		await interrupt(rendered.result);

		expect(currentSession(active.id)).toEqual(
			expect.objectContaining({
				state: 'busy',
				busySource: 'ai',
				executionQueue: [],
				currentCycleTokens: 0,
				currentCycleBytes: 0,
			})
		);
		expect(maestroMock.logger.log).toHaveBeenCalledWith(
			'error',
			'Failed to interrupt process:',
			undefined,
			expect.any(Error)
		);
	});

	it('records AI kill errors with non-Error failures and preserves unrelated sessions', async () => {
		maestroMock.process.interrupt.mockRejectedValueOnce(new Error('SIGINT failed'));
		maestroMock.process.kill.mockRejectedValueOnce('string failure');
		window.confirm = vi.fn().mockReturnValue(true);
		const activeTab = aiTab({ id: 'kill-error-active', state: 'busy' });
		const busyTab = aiTab({
			id: 'kill-error-busy',
			state: 'busy',
			logs: [log('thinking', 'remove'), log('ai', 'keep')],
		});
		const idleTab = aiTab({ id: 'kill-error-idle', state: 'idle', logs: [log('ai', 'idle')] });
		const active = session({
			id: 'kill-error-session',
			aiTabs: [activeTab, busyTab, idleTab],
			activeTabId: activeTab.id,
		});
		const other = session({ id: 'kill-error-other', aiTabs: [aiTab({ id: 'other-tab' })] });
		const rendered = renderInterruptHook([active, other], active.id);

		await interrupt(rendered.result);

		const updated = currentSession(active.id);
		expect(updated.state).toBe('idle');
		expect(updated.aiTabs.find((tab) => tab.id === activeTab.id)?.logs.at(-1)?.text).toContain(
			'string failure'
		);
		expect(updated.aiTabs.find((tab) => tab.id === busyTab.id)?.logs).toEqual([log('ai', 'keep')]);
		expect(updated.aiTabs.find((tab) => tab.id === idleTab.id)).toEqual(idleTab);
		expect(currentSession(other.id)).toEqual(other);
		expect(maestroMock.logger.log).toHaveBeenCalledWith(
			'error',
			'Failed to kill process:',
			undefined,
			'string failure'
		);
	});

	it('records terminal kill errors in shell logs', async () => {
		maestroMock.process.interrupt.mockRejectedValueOnce(new Error('SIGINT failed'));
		maestroMock.process.kill.mockRejectedValueOnce(new Error('kill failed'));
		window.confirm = vi.fn().mockReturnValue(true);
		const active = session({
			id: 'terminal-kill-error',
			inputMode: 'terminal',
			shellLogs: [],
		});
		const rendered = renderInterruptHook([active], active.id);

		await interrupt(rendered.result);

		expect(currentSession(active.id).state).toBe('idle');
		expect(currentSession(active.id).shellLogs.at(-1)?.text).toContain(
			'Failed to terminate process - kill failed'
		);
		expect(maestroMock.logger.log).toHaveBeenCalledWith(
			'error',
			'Failed to kill process:',
			undefined,
			expect.any(Error)
		);
	});
});

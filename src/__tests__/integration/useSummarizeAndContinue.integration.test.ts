import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	createSummarizeSystemLogEntry,
	useSummarizeAndContinue,
} from '../../renderer/hooks/agent/useSummarizeAndContinue';
import { useNotificationStore, resetToastIdCounter } from '../../renderer/stores/notificationStore';
import { useOperationStore } from '../../renderer/stores/operationStore';
import { useSessionStore } from '../../renderer/stores/sessionStore';
import type { AITab, Session } from '../../renderer/types';

const contextSummarizationServiceMock = vi.hoisted(() => ({
	summarizeContext: vi.fn(),
	formatCompactedTabName: vi.fn(),
	canSummarize: vi.fn(),
	getMinContextUsagePercent: vi.fn(),
	cancelSummarization: vi.fn(),
}));

vi.mock('../../renderer/services/contextSummarizer', () => ({
	contextSummarizationService: contextSummarizationServiceMock,
}));

let originalMaestro: typeof window.maestro;

function createTab(overrides: Partial<AITab> = {}): AITab {
	return {
		id: 'tab-1',
		agentSessionId: 'provider-session',
		name: 'Research',
		starred: false,
		logs: [
			{ id: 'user-1', timestamp: 1, source: 'user', text: 'Summarize this session' },
			{ id: 'ai-1', timestamp: 2, source: 'ai', text: 'Here is a detailed answer.' },
		],
		inputValue: '',
		stagedImages: [],
		createdAt: 1700000000000,
		state: 'idle',
		saveToHistory: true,
		...overrides,
	};
}

function createSession(overrides: Partial<Session> = {}): Session {
	const tab = createTab();
	return {
		id: 'session-1',
		name: 'Integration Project',
		toolType: 'claude-code',
		state: 'idle',
		cwd: '/repo/integration-project',
		fullPath: '/repo/integration-project',
		projectRoot: '/repo/integration-project',
		aiLogs: [],
		shellLogs: [],
		workLog: [],
		contextUsage: 90,
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
		aiTabs: [tab],
		activeTabId: tab.id,
		closedTabHistory: [],
		executionQueue: [],
		activeTimeMs: 0,
		filePreviewTabs: [],
		activeFileTabId: null,
		unifiedTabOrder: [{ type: 'ai', id: tab.id }],
		unifiedClosedTabHistory: [],
		...overrides,
	} as Session;
}

function mockSuccessfulSummary() {
	contextSummarizationServiceMock.canSummarize.mockReturnValue(true);
	contextSummarizationServiceMock.formatCompactedTabName.mockReturnValue('Research Compacted');
	contextSummarizationServiceMock.summarizeContext.mockImplementation(
		async (_config, _logs, onProgress) => {
			onProgress({ stage: 'summarizing', progress: 45, message: 'Compacting context' });
			return {
				summarizedLogs: [{ id: 'summary-1', timestamp: 3, source: 'ai', text: 'Compact summary.' }],
				originalTokens: 12000,
				compactedTokens: 3000,
			};
		}
	);
}

describe('useSummarizeAndContinue integration', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		originalMaestro = window.maestro;
		useOperationStore.getState().resetAll();
		useNotificationStore.getState().clearToasts();
		resetToastIdCounter();
		useSessionStore.setState({
			sessions: [],
			activeSessionId: '',
			initialLoadComplete: true,
			removedWorktreePaths: new Set(),
		});
		contextSummarizationServiceMock.getMinContextUsagePercent.mockReturnValue(25);
		contextSummarizationServiceMock.cancelSummarization.mockResolvedValue(undefined);
		(window as any).maestro = {
			...originalMaestro,
			logger: { toast: vi.fn() },
			notification: {
				show: vi.fn().mockResolvedValue(undefined),
				speak: vi.fn().mockResolvedValue(undefined),
			},
		};
	});

	afterEach(() => {
		act(() => {
			useOperationStore.getState().resetAll();
			useNotificationStore.getState().clearToasts();
		});
		(window as any).maestro = originalMaestro;
		vi.restoreAllMocks();
	});

	it('creates system log entries with optional token reduction details', () => {
		const plain = createSummarizeSystemLogEntry('Compaction started');
		const summarized = createSummarizeSystemLogEntry('Compaction complete', {
			success: true,
			newTabId: 'tab-2',
			originalTokens: 12000,
			compactedTokens: 3000,
			reductionPercent: 75,
		});

		expect(plain).toMatchObject({ source: 'system', text: 'Compaction started' });
		expect(summarized.text).toContain('Compaction complete');
		expect(summarized.text).toContain('Token reduction: 75%');
		expect(summarized.text).toContain('12,000');
	});

	it('summarizes a tab, tracks operation state, and supports cancellation helpers', async () => {
		mockSuccessfulSummary();
		const session = createSession();
		const { result } = renderHook(() => useSummarizeAndContinue(session));

		let summarizeResult: Awaited<ReturnType<typeof result.current.startSummarize>>;
		await act(async () => {
			summarizeResult = await result.current.startSummarize('tab-1');
		});

		expect(summarizeResult).toEqual(
			expect.objectContaining({
				newTabId: expect.any(String),
				systemLogEntry: expect.objectContaining({
					source: 'system',
					text: expect.stringContaining('Token reduction: 75%'),
				}),
			})
		);
		expect(summarizeResult!.updatedSession.activeTabId).toBe(summarizeResult!.newTabId);
		expect(summarizeResult!.updatedSession.aiTabs.map((tab) => tab.name)).toEqual([
			'Research',
			'Research Compacted',
		]);
		expect(result.current.getTabSummarizeState('tab-1')).toMatchObject({
			state: 'complete',
			progress: { stage: 'complete', progress: 100, message: 'Complete!' },
		});

		act(() => result.current.clearTabState('tab-1'));
		expect(result.current.getTabSummarizeState('tab-1')).toBeNull();

		act(() => {
			useOperationStore.getState().setSummarizeTabState('tab-2', {
				state: 'summarizing',
				progress: null,
				result: null,
				error: null,
				startTime: 1,
			});
			result.current.cancelTab('tab-2');
		});
		expect(contextSummarizationServiceMock.cancelSummarization).toHaveBeenCalledTimes(1);
		expect(result.current.getTabSummarizeState('tab-2')).toBeNull();

		act(() => {
			useOperationStore.getState().setSummarizeTabState('tab-3', {
				state: 'summarizing',
				progress: null,
				result: null,
				error: null,
				startTime: 1,
			});
			result.current.cancel();
		});
		expect(useOperationStore.getState().summarizeStates.size).toBe(0);
	});

	it('handles summarize-and-continue success, validation warnings, and failures', async () => {
		mockSuccessfulSummary();
		const session = createSession();
		useSessionStore.setState({ sessions: [session], activeSessionId: session.id });
		const { result, rerender } = renderHook(
			({ currentSession }) => useSummarizeAndContinue(currentSession),
			{ initialProps: { currentSession: session } }
		);

		act(() => result.current.handleSummarizeAndContinue('tab-1'));

		await waitFor(() => {
			const updated = useSessionStore.getState().sessions[0];
			expect(updated.activeTabId).not.toBe('tab-1');
			expect(updated.aiTabs).toHaveLength(2);
		});
		expect(useNotificationStore.getState().toasts.at(-1)).toMatchObject({
			type: 'success',
			title: 'Context Compacted',
			sessionId: 'session-1',
		});

		contextSummarizationServiceMock.canSummarize.mockReturnValue(false);
		const smallSession = createSession({ id: 'session-small', contextUsage: 5 });
		rerender({ currentSession: smallSession });
		act(() => result.current.handleSummarizeAndContinue('tab-1'));
		expect(useNotificationStore.getState().toasts.at(-1)).toMatchObject({
			type: 'warning',
			title: 'Cannot Compact',
		});

		contextSummarizationServiceMock.canSummarize.mockReturnValue(true);
		contextSummarizationServiceMock.summarizeContext.mockResolvedValueOnce(null);
		await act(async () => {
			const failed = await result.current.startSummarize('tab-1');
			expect(failed).toBeNull();
		});
		expect(result.current.getTabSummarizeState('tab-1')).toMatchObject({
			state: 'error',
			error: 'Summarization returned no result',
		});

		const shellSession = createSession({ id: 'session-shell', inputMode: 'shell' });
		rerender({ currentSession: shellSession });
		act(() => result.current.handleSummarizeAndContinue('tab-1'));
		expect(useNotificationStore.getState().toasts.at(-1)?.title).not.toBe('Compaction Failed');
	});
});

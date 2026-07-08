import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SendToAgentOptions } from '../../renderer/components/SendToAgentModal';
import type { MergeResult } from '../../renderer/types/contextMerge';
import type { AITab, LogEntry, Session, ToolType } from '../../renderer/types';
import type { CreateMergedSessionResult } from '../../renderer/utils/tabHelpers';
import {
	useSendToAgent,
	useSendToAgentWithSessions,
} from '../../renderer/hooks/agent/useSendToAgent';
import { useOperationStore } from '../../renderer/stores/operationStore';
import { logger } from '../../renderer/utils/logger';

const mocks = vi.hoisted(() => ({
	groomContexts: vi.fn(),
	cancelGrooming: vi.fn(),
	agentsGet: vi.fn(),
	historyAdd: vi.fn(),
	transformExtractedLogs: undefined as undefined | ((logs: LogEntry[]) => LogEntry[]),
	transformMergedSession: undefined as
		undefined | ((result: CreateMergedSessionResult) => CreateMergedSessionResult),
}));

vi.mock('../../renderer/services/contextGroomer', async () => {
	const actual = await vi.importActual<typeof import('../../renderer/services/contextGroomer')>(
		'../../renderer/services/contextGroomer'
	);

	return {
		...actual,
		contextGroomingService: {
			groomContexts: mocks.groomContexts,
			cancelGrooming: mocks.cancelGrooming,
		},
	};
});

vi.mock('../../renderer/utils/contextExtractor', async () => {
	const actual = await vi.importActual<typeof import('../../renderer/utils/contextExtractor')>(
		'../../renderer/utils/contextExtractor'
	);

	return {
		...actual,
		extractTabContext: (...args: Parameters<typeof actual.extractTabContext>) => {
			const context = actual.extractTabContext(...args);
			return {
				...context,
				logs: mocks.transformExtractedLogs
					? mocks.transformExtractedLogs(context.logs)
					: context.logs,
			};
		},
	};
});

vi.mock('../../renderer/utils/tabHelpers', async () => {
	const actual = await vi.importActual<typeof import('../../renderer/utils/tabHelpers')>(
		'../../renderer/utils/tabHelpers'
	);

	return {
		...actual,
		createMergedSession: (...args: Parameters<typeof actual.createMergedSession>) => {
			const result = actual.createMergedSession(...args);
			return mocks.transformMergedSession ? mocks.transformMergedSession(result) : result;
		},
	};
});

vi.mock('../../renderer/utils/logger', () => ({
	logger: {
		warn: vi.fn(),
	},
}));

function createLog(
	source: LogEntry['source'],
	text: string,
	id = `${source}-${text.length}`
): LogEntry {
	return {
		id,
		timestamp: 1779786000000,
		source,
		text,
	};
}

function createTab(overrides: Partial<AITab> = {}): AITab {
	return {
		id: 'tab-source',
		agentSessionId: 'agent-source',
		name: 'Implementation',
		starred: false,
		logs: [
			createLog('system', 'System setup'),
			createLog('user', 'Please implement the feature.'),
			createLog('ai', 'Implemented the feature.'),
		],
		inputValue: '',
		stagedImages: [],
		createdAt: 1779786000000,
		state: 'idle',
		saveToHistory: true,
		showThinking: 'off',
		...overrides,
	};
}

function createSession(overrides: Partial<Session> = {}): Session {
	const tabs = overrides.aiTabs ?? [createTab()];
	const projectRoot = overrides.projectRoot ?? '/Users/test/project-alpha';

	return {
		id: 'session-source',
		name: 'Source Session',
		toolType: 'claude-code',
		state: 'idle',
		cwd: projectRoot,
		fullPath: projectRoot,
		projectRoot,
		createdAt: 1779786000000,
		aiLogs: [],
		shellLogs: [],
		workLog: [],
		contextUsage: 0,
		inputMode: 'ai',
		aiPid: 0,
		terminalPid: 0,
		port: 3030,
		isLive: false,
		changedFiles: [],
		isGitRepo: true,
		fileTree: [],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		fileTreeAutoRefreshInterval: 180,
		shellCwd: projectRoot,
		aiCommandHistory: [],
		shellCommandHistory: [],
		executionQueue: [],
		activeTimeMs: 0,
		aiTabs: tabs,
		activeTabId: tabs[0]?.id ?? 'missing-tab',
		closedTabHistory: [],
		filePreviewTabs: [],
		activeFileTabId: null,
		unifiedTabOrder: tabs.map((tab) => ({ type: 'ai' as const, id: tab.id })),
		unifiedClosedTabHistory: [],
		...overrides,
	};
}

function options(overrides: Partial<SendToAgentOptions> = {}): SendToAgentOptions {
	return {
		groomContext: true,
		targetSessionId: 'target-session',
		...overrides,
	};
}

function installMaestroBridge() {
	const maestroWindow = window as typeof window & {
		maestro: {
			agents?: { get: typeof mocks.agentsGet };
			history?: { add: typeof mocks.historyAdd };
		};
	};
	maestroWindow.maestro = maestroWindow.maestro ?? {};
	maestroWindow.maestro.agents = { get: mocks.agentsGet };
	maestroWindow.maestro.history = { add: mocks.historyAdd };
}

function mockGroomingSuccess(groomedLogs: LogEntry[] = [createLog('ai', 'Groomed summary')]) {
	mocks.groomContexts.mockImplementation(async (_request, onProgress) => {
		onProgress({
			stage: 'collecting',
			progress: 25,
			message: 'Collecting source logs',
		});
		onProgress({
			stage: 'grooming',
			progress: 42,
			message: 'Removing tool-specific artifacts',
		});

		return {
			success: true,
			groomedLogs,
			tokensSaved: 128,
		};
	});
}

async function runTransfer(
	startTransfer: ReturnType<typeof useSendToAgent>['startTransfer'],
	sourceSession: Session,
	targetAgent: ToolType,
	transferOptions: SendToAgentOptions
): Promise<MergeResult> {
	let result!: MergeResult;
	await act(async () => {
		result = await startTransfer({
			sourceSession,
			sourceTabId: sourceSession.activeTabId,
			targetAgent,
			options: transferOptions,
		});
	});
	return result;
}

describe('useSendToAgent integration', () => {
	beforeEach(() => {
		cleanup();
		vi.clearAllMocks();
		mocks.groomContexts.mockReset();
		mocks.cancelGrooming.mockReset();
		mocks.agentsGet.mockReset();
		mocks.historyAdd.mockReset();
		mocks.transformExtractedLogs = undefined;
		mocks.transformMergedSession = undefined;
		mocks.agentsGet.mockResolvedValue({ available: true });
		mocks.historyAdd.mockResolvedValue(undefined);
		mockGroomingSuccess();
		installMaestroBridge();
		useOperationStore.getState().resetAll();
	});

	afterEach(() => {
		cleanup();
		useOperationStore.getState().resetAll();
		vi.restoreAllMocks();
	});

	it('runs groomed transfers, retry paths, reset, and cancellation against the operation store', async () => {
		const sourceSession = createSession();
		const hook = renderHook(() => useSendToAgent());

		const transferResult = await runTransfer(
			hook.result.current.startTransfer,
			sourceSession,
			'codex',
			options({ groomContext: true })
		);

		expect(transferResult).toMatchObject({
			success: true,
			tokensSaved: 128,
		});
		expect(mocks.groomContexts).toHaveBeenCalledTimes(1);
		expect(mocks.groomContexts.mock.calls[0][0]).toMatchObject({
			targetAgent: 'codex',
			targetProjectRoot: sourceSession.projectRoot,
		});
		expect(useOperationStore.getState()).toMatchObject({
			transferState: 'complete',
			globalTransferInProgress: false,
		});
		expect(useOperationStore.getState().transferProgress?.message).toContain('Saved ~128 tokens');

		mocks.groomContexts.mockClear();
		let retryResult!: MergeResult;
		await act(async () => {
			retryResult = await hook.result.current.retryTransfer();
		});
		expect(retryResult.success).toBe(true);
		expect(mocks.groomContexts).toHaveBeenCalledTimes(1);

		mocks.groomContexts.mockClear();
		let rawRetryResult!: MergeResult;
		await act(async () => {
			rawRetryResult = await hook.result.current.retryWithoutGrooming();
		});
		expect(rawRetryResult).toMatchObject({ success: true, tokensSaved: 0 });
		expect(mocks.groomContexts).not.toHaveBeenCalled();

		act(() => hook.result.current.reset());
		expect(useOperationStore.getState()).toMatchObject({
			transferState: 'idle',
			transferError: null,
		});

		act(() => hook.result.current.cancelTransfer());
		expect(mocks.cancelGrooming).toHaveBeenCalledTimes(1);
		expect(useOperationStore.getState()).toMatchObject({
			transferState: 'idle',
			transferError: 'Transfer cancelled by user',
		});
	});

	it('classifies guard failures and agent availability warnings without leaking transfer flags', async () => {
		const hook = renderHook(() => useSendToAgent());
		const sourceSession = createSession();

		let retryResult!: MergeResult;
		await act(async () => {
			retryResult = await hook.result.current.retryTransfer();
		});
		expect(retryResult).toEqual({
			success: false,
			error: 'No previous transfer to retry',
		});

		let retryRawResult!: MergeResult;
		await act(async () => {
			retryRawResult = await hook.result.current.retryWithoutGrooming();
		});
		expect(retryRawResult).toEqual({
			success: false,
			error: 'No previous transfer to retry',
		});

		act(() => useOperationStore.getState().setGlobalTransferInProgress(true));
		const busyResult = await runTransfer(
			hook.result.current.startTransfer,
			sourceSession,
			'codex',
			options()
		);
		expect(busyResult).toEqual({
			success: false,
			error: 'A transfer operation is already in progress. Please wait for it to complete.',
		});
		act(() => useOperationStore.getState().resetAll());

		const missingTabResult = await runTransfer(
			hook.result.current.startTransfer,
			createSession({ activeTabId: 'missing-tab' }),
			'codex',
			options()
		);
		expect(missingTabResult).toEqual({ success: false, error: 'Source tab not found' });
		expect(useOperationStore.getState().globalTransferInProgress).toBe(false);
		expect(useOperationStore.getState().transferStructuredError).toBeTruthy();

		const emptyResult = await runTransfer(
			hook.result.current.startTransfer,
			createSession({ aiTabs: [createTab({ logs: [] })], activeTabId: 'tab-source' }),
			'codex',
			options()
		);
		expect(emptyResult).toEqual({
			success: false,
			error: 'Cannot transfer empty context - source tab has no conversation history',
		});

		mocks.agentsGet.mockResolvedValueOnce({ available: false });
		const unavailableResult = await runTransfer(
			hook.result.current.startTransfer,
			createSession({
				name: '',
				projectRoot: '/Users/test/fallback-name',
				cwd: '/Users/test/fallback-name',
				fullPath: '/Users/test/fallback-name',
			}),
			'codex',
			options({ groomContext: false })
		);
		expect(unavailableResult.success).toBe(true);
		expect(logger.warn).toHaveBeenCalledWith(
			'Could not verify agent availability:',
			undefined,
			expect.any(Error)
		);

		mocks.agentsGet.mockRejectedValueOnce(new Error('agent registry unavailable'));
		const rejectedCheckResult = await runTransfer(
			hook.result.current.startTransfer,
			sourceSession,
			'codex',
			options({ groomContext: false })
		);
		expect(rejectedCheckResult.success).toBe(true);
		expect(logger.warn).toHaveBeenCalledWith(
			'Could not verify agent availability:',
			undefined,
			expect.any(Error)
		);

		mocks.transformExtractedLogs = () => {
			throw 'extract failed as string';
		};
		const unknownErrorResult = await runTransfer(
			hook.result.current.startTransfer,
			sourceSession,
			'codex',
			options({ groomContext: false })
		);
		expect(unknownErrorResult).toEqual({
			success: false,
			error: 'Unknown error during transfer',
		});
		mocks.transformExtractedLogs = undefined;
	});

	it('handles grooming failures, large contexts, and cancellation during async stages', async () => {
		const hook = renderHook(() => useSendToAgent());
		const sourceSession = createSession();

		mocks.groomContexts.mockResolvedValueOnce({
			success: false,
			groomedLogs: [],
			tokensSaved: 0,
			error: 'Grooming model failed',
		});
		const groomingFailure = await runTransfer(
			hook.result.current.startTransfer,
			sourceSession,
			'codex',
			options({ groomContext: true })
		);
		expect(groomingFailure).toEqual({ success: false, error: 'Grooming model failed' });
		expect(useOperationStore.getState().transferState).toBe('error');

		mocks.groomContexts.mockResolvedValueOnce({
			success: false,
			groomedLogs: [],
			tokensSaved: 0,
		});
		const genericGroomingFailure = await runTransfer(
			hook.result.current.startTransfer,
			sourceSession,
			'codex',
			options({ groomContext: true })
		);
		expect(genericGroomingFailure).toEqual({
			success: false,
			error: 'Context grooming failed',
		});

		let hookForAgentCancel = renderHook(() => useSendToAgent());
		mocks.agentsGet.mockImplementationOnce(async () => {
			hookForAgentCancel.result.current.cancelTransfer();
			return { available: true };
		});
		const cancelledBeforeExtract = await runTransfer(
			hookForAgentCancel.result.current.startTransfer,
			sourceSession,
			'codex',
			options({ groomContext: false })
		);
		expect(cancelledBeforeExtract).toEqual({ success: false, error: 'Transfer cancelled' });

		const hookForExtractCancel = renderHook(() => useSendToAgent());
		mocks.transformExtractedLogs = (logs) => {
			hookForExtractCancel.result.current.cancelTransfer();
			return logs;
		};
		const cancelledAfterExtract = await runTransfer(
			hookForExtractCancel.result.current.startTransfer,
			sourceSession,
			'codex',
			options({ groomContext: true })
		);
		expect(cancelledAfterExtract).toEqual({ success: false, error: 'Transfer cancelled' });
		mocks.transformExtractedLogs = undefined;

		const hookForGroomingCancel = renderHook(() => useSendToAgent());
		mocks.groomContexts.mockImplementationOnce(async () => {
			hookForGroomingCancel.result.current.cancelTransfer();
			return {
				success: true,
				groomedLogs: [createLog('ai', 'Cancelled groomed output')],
				tokensSaved: 12,
			};
		});
		const cancelledAfterGrooming = await runTransfer(
			hookForGroomingCancel.result.current.startTransfer,
			sourceSession,
			'codex',
			options({ groomContext: true })
		);
		expect(cancelledAfterGrooming).toEqual({ success: false, error: 'Transfer cancelled' });

		const hookForRawCancel = renderHook(() => useSendToAgent());
		mocks.transformExtractedLogs = (logs) => {
			const wrapped = [...logs];
			Object.defineProperty(wrapped, Symbol.iterator, {
				value: function* () {
					hookForRawCancel.result.current.cancelTransfer();
					yield* logs;
				},
			});
			return wrapped;
		};
		const cancelledAfterRawPreparation = await runTransfer(
			hookForRawCancel.result.current.startTransfer,
			sourceSession,
			'codex',
			options({ groomContext: false })
		);
		expect(cancelledAfterRawPreparation).toEqual({
			success: false,
			error: 'Transfer cancelled',
		});
		mocks.transformExtractedLogs = undefined;

		const largeContext = createSession({
			aiTabs: [createTab({ logs: [createLog('user', 'x'.repeat(400_004), 'large-log')] })],
			activeTabId: 'tab-source',
		});
		const largeContextResult = await runTransfer(
			hook.result.current.startTransfer,
			largeContext,
			'codex',
			options({ groomContext: false })
		);
		expect(largeContextResult.success).toBe(true);
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Large context transfer'));

		const blankTextHook = renderHook(() => useSendToAgent());
		const blankTextResult = await runTransfer(
			blankTextHook.result.current.startTransfer,
			createSession({ aiTabs: [createTab({ logs: [createLog('user', '', 'blank-log')] })] }),
			'codex',
			options({ groomContext: false })
		);
		expect(blankTextResult.success).toBe(true);
	});

	it('adds created sessions, pending context, history entries, and optional callbacks', async () => {
		const sourceSession = createSession();
		let sessions = [sourceSession];
		const setSessions = vi.fn((updater: (prev: Session[]) => Session[]) => {
			sessions = updater(sessions);
		});
		const onSessionCreated = vi.fn();
		const onNavigateToSession = vi.fn();
		const hook = renderHook(() =>
			useSendToAgentWithSessions({
				sessions,
				setSessions,
				onSessionCreated,
				onNavigateToSession,
			})
		);

		let result!: MergeResult;
		await act(async () => {
			result = await hook.result.current.executeTransfer(
				sourceSession,
				sourceSession.activeTabId,
				'codex',
				options({ groomContext: true })
			);
		});

		expect(result.success).toBe(true);
		expect(setSessions).toHaveBeenCalledTimes(1);
		expect(sessions).toHaveLength(2);
		const created = sessions[1];
		expect(created.name).toContain('Source Session');
		expect(created.toolType).toBe('codex');
		expect(created.aiTabs[0].logs).toEqual([expect.objectContaining({ source: 'system' })]);
		expect(created.aiTabs[0].pendingMergedContext).toContain('User: Please implement the feature.');
		expect(created.aiTabs[0].pendingMergedContext).toContain('Assistant: Implemented the feature.');
		expect(created.aiTabs[0].pendingMergedContext).not.toContain('System setup');
		expect(created.aiTabs[0].inputValue).toContain("I'm transferring context");
		expect(created.aiTabs[0].autoSendOnActivate).toBe(true);
		expect(mocks.historyAdd).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'AUTO',
				sessionId: created.id,
				projectPath: sourceSession.projectRoot,
			})
		);
		expect(onSessionCreated).toHaveBeenCalledWith(created.id, created.name);
		expect(onNavigateToSession).toHaveBeenCalledWith(created.id);

		let missingTab!: MergeResult;
		await act(async () => {
			missingTab = await hook.result.current.executeTransfer(
				sourceSession,
				'missing-tab',
				'codex',
				options()
			);
		});
		expect(missingTab).toEqual({ success: false, error: 'Source tab not found' });

		let noCreate!: MergeResult;
		await act(async () => {
			noCreate = await hook.result.current.executeTransfer(
				sourceSession,
				sourceSession.activeTabId,
				'codex',
				options({ createNewSession: false, groomContext: false })
			);
		});
		expect(noCreate.success).toBe(true);
		expect(setSessions).toHaveBeenCalledTimes(1);
	});

	it('keeps transfer success when optional session callbacks or history logging are absent', async () => {
		const sourceSession = createSession({
			name: '',
			projectRoot: '',
			cwd: '',
			fullPath: '',
		});
		let sessions = [sourceSession];
		const setSessions = vi.fn((updater: (prev: Session[]) => Session[]) => {
			sessions = updater(sessions);
		});
		mocks.historyAdd.mockRejectedValueOnce(new Error('history unavailable'));
		const hook = renderHook(() =>
			useSendToAgentWithSessions({
				sessions,
				setSessions,
			})
		);

		let result!: MergeResult;
		await act(async () => {
			result = await hook.result.current.executeTransfer(
				sourceSession,
				sourceSession.activeTabId,
				'codex',
				options({ groomContext: false })
			);
		});

		expect(result.success).toBe(true);
		expect(sessions[1].name).toContain('Unnamed Session');
		expect(sessions[1].aiTabs[0].logs[0].text).toContain(
			'Context transferred from "Unnamed Session"'
		);
		expect(sessions[1].aiTabs[0].logs[0].text).not.toContain('Groomed');
		expect(logger.warn).toHaveBeenCalledWith(
			'Failed to log transfer operation to history:',
			undefined,
			expect.any(Error)
		);

		const systemOnlySession = createSession({
			aiTabs: [createTab({ logs: [createLog('system', 'Only setup context')] })],
			activeTabId: 'tab-source',
		});
		let systemOnlySessions = [systemOnlySession];
		const setSystemOnlySessions = vi.fn((updater: (prev: Session[]) => Session[]) => {
			systemOnlySessions = updater(systemOnlySessions);
		});
		const systemOnlyHook = renderHook(() =>
			useSendToAgentWithSessions({
				sessions: systemOnlySessions,
				setSessions: setSystemOnlySessions,
			})
		);
		let systemOnlyResult!: MergeResult;
		await act(async () => {
			systemOnlyResult = await systemOnlyHook.result.current.executeTransfer(
				systemOnlySession,
				systemOnlySession.activeTabId,
				'codex',
				options({ groomContext: false })
			);
		});
		expect(systemOnlyResult.success).toBe(true);
		expect(systemOnlySessions[1].aiTabs[0].pendingMergedContext).toBeUndefined();

		mocks.transformMergedSession = (created) => ({
			...created,
			session: {
				...created.session,
				aiTabs: [],
			},
		});
		const noActiveTabSession = createSession();
		let noActiveTabSessions = [noActiveTabSession];
		const setNoActiveTabSessions = vi.fn((updater: (prev: Session[]) => Session[]) => {
			noActiveTabSessions = updater(noActiveTabSessions);
		});
		const noActiveTabHook = renderHook(() =>
			useSendToAgentWithSessions({
				sessions: noActiveTabSessions,
				setSessions: setNoActiveTabSessions,
			})
		);
		let noActiveTabResult!: MergeResult;
		await act(async () => {
			noActiveTabResult = await noActiveTabHook.result.current.executeTransfer(
				noActiveTabSession,
				noActiveTabSession.activeTabId,
				'codex',
				options({ groomContext: false })
			);
		});
		expect(noActiveTabResult.success).toBe(true);
		expect(noActiveTabSessions[1].aiTabs).toEqual([]);
	});
});

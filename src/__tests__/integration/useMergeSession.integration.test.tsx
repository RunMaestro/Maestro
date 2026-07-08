import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SetStateAction } from 'react';

import {
	__resetMergeInProgress,
	useMergeSession,
	useMergeSessionWithSessions,
} from '../../renderer/hooks/agent/useMergeSession';
import type { MergeOptions } from '../../renderer/components/MergeSessionModal';
import { useOperationStore } from '../../renderer/stores/operationStore';
import * as contextGroomer from '../../renderer/services/contextGroomer';
import type { AITab, LogEntry, Session, ToolType } from '../../renderer/types';

const rawMergeOptions: MergeOptions = {
	createNewSession: true,
	groomContext: false,
	preserveTimestamps: true,
};

const injectMergeOptions: MergeOptions = {
	createNewSession: false,
	groomContext: false,
	preserveTimestamps: true,
};

function createLog(
	id: string,
	timestamp: number,
	source: LogEntry['source'],
	text: string
): LogEntry {
	return { id, timestamp, source, text };
}

function createTab(id: string, logs: LogEntry[], overrides: Partial<AITab> = {}): AITab {
	return {
		id,
		agentSessionId: `agent-${id}`,
		name: id,
		starred: false,
		logs,
		inputValue: '',
		stagedImages: [],
		createdAt: 1700000000000,
		state: 'idle',
		saveToHistory: true,
		showThinking: 'off',
		...overrides,
	};
}

function createSession(
	id: string,
	overrides: Partial<Session> & { aiTabs?: AITab[] } = {}
): Session {
	const aiTabs = overrides.aiTabs ?? [
		createTab(`${id}-tab`, [createLog(`${id}-log`, 1700000000000, 'user', `${id} context`)]),
	];

	return {
		id,
		name: `${id} Session`,
		toolType: 'claude-code' as ToolType,
		state: 'idle',
		cwd: `/workspace/${id}`,
		fullPath: `/workspace/${id}`,
		projectRoot: `/workspace/${id}`,
		createdAt: 1700000000000,
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
		closedTabHistory: [],
		filePreviewTabs: [],
		activeFileTabId: null,
		unifiedTabOrder: aiTabs.map((tab) => ({ type: 'ai' as const, id: tab.id })),
		unifiedClosedTabHistory: [],
		executionQueue: [],
		activeTimeMs: 0,
		...overrides,
		aiTabs,
		activeTabId: overrides.activeTabId ?? aiTabs[0]?.id,
	};
}

describe('useMergeSession integration', () => {
	const originalMaestro = window.maestro;

	beforeEach(() => {
		useOperationStore.getState().resetAll();

		vi.spyOn(console, 'info').mockImplementation(() => {});
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(contextGroomer.contextGroomingService, 'cancelGrooming').mockImplementation(() => {});
		vi.spyOn(contextGroomer.contextGroomingService, 'groomContexts').mockResolvedValue({
			success: true,
			groomedLogs: [createLog('groomed', 1700000000200, 'ai', 'Groomed context')],
			tokensSaved: 42,
		});

		window.maestro = {
			...originalMaestro,
			history: {
				...originalMaestro.history,
				add: vi.fn().mockResolvedValue(undefined),
			},
		};
	});

	afterEach(() => {
		cleanup();
		useOperationStore.getState().resetAll();
		vi.restoreAllMocks();
		window.maestro = originalMaestro;
	});

	it('merges raw logs through the real extractor, tab helper, and operation store', async () => {
		const sourceTab = createTab('source-tab', [
			createLog('source-newer', 3000, 'ai', 'Source answer'),
			createLog('source-older', 1000, 'user', 'Source question'),
		]);
		const targetTab = createTab('target-tab', [
			createLog('target-middle', 2000, 'user', 'Target question'),
		]);
		const sourceSession = createSession('source', {
			name: 'Source Project',
			groupId: 'group-1',
			aiTabs: [sourceTab],
			activeTabId: sourceTab.id,
		});
		const targetSession = createSession('target', {
			name: 'Target Project',
			aiTabs: [targetTab],
			activeTabId: targetTab.id,
		});
		const { result } = renderHook(() => useMergeSession(sourceTab.id));

		let mergeResult: Awaited<ReturnType<typeof result.current.startMerge>>;
		await act(async () => {
			mergeResult = await result.current.startMerge({
				sourceSession,
				sourceTabId: sourceTab.id,
				targetSession,
				targetTabId: targetTab.id,
				options: rawMergeOptions,
			});
		});

		expect(mergeResult!).toMatchObject({
			success: true,
			sourceSessionName: 'Source Project',
			targetSessionName: 'Target Project',
			tokensSaved: 0,
		});
		expect(mergeResult!.newSessionId).toEqual(expect.any(String));
		expect(mergeResult!.newTabId).toEqual(expect.any(String));
		expect(result.current.mergeState).toBe('complete');
		expect(result.current.getTabMergeState(sourceTab.id)).toMatchObject({
			state: 'complete',
			progress: { stage: 'complete', progress: 100 },
			sourceName: 'Source Project',
			targetName: 'Target Project',
		});
		expect(contextGroomer.contextGroomingService.groomContexts).not.toHaveBeenCalled();
	});

	it('uses the grooming service boundary and returns groomed logs for existing-tab merges', async () => {
		const sourceTab = createTab('source-tab', [
			createLog('source', 1000, 'user', 'Duplicate implementation notes'),
		]);
		const targetTab = createTab('target-tab', [
			createLog('target', 2000, 'ai', 'Prior target answer'),
		]);
		const sourceSession = createSession('source', {
			toolType: 'codex',
			aiTabs: [sourceTab],
			activeTabId: sourceTab.id,
		});
		const targetSession = createSession('target', {
			toolType: 'codex',
			aiTabs: [targetTab],
			activeTabId: targetTab.id,
		});
		const groomedLog = createLog('groomed-log', 2500, 'ai', 'Condensed context');
		vi.mocked(contextGroomer.contextGroomingService.groomContexts).mockImplementationOnce(
			async (request, onProgress) => {
				onProgress({ stage: 'grooming', progress: 55, message: 'Halfway' });
				expect(request).toMatchObject({
					targetAgent: 'codex',
					targetProjectRoot: '/workspace/source',
				});
				expect(request.sources.map((source) => source.tabId)).toEqual(['source-tab', 'target-tab']);
				return { success: true, groomedLogs: [groomedLog], tokensSaved: 77 };
			}
		);
		const { result } = renderHook(() => useMergeSession(sourceTab.id));

		let mergeResult: Awaited<ReturnType<typeof result.current.startMerge>>;
		await act(async () => {
			mergeResult = await result.current.startMerge({
				sourceSession,
				sourceTabId: sourceTab.id,
				targetSession,
				targetTabId: targetTab.id,
				options: { ...injectMergeOptions, groomContext: true },
			});
		});

		expect(mergeResult!).toMatchObject({
			success: true,
			tokensSaved: 77,
			targetSessionId: 'target',
			targetTabId: 'target-tab',
			mergedLogs: [groomedLog],
		});
		expect(result.current.getTabMergeState(sourceTab.id)?.result).toMatchObject({
			tokensSaved: 77,
			mergedLogs: [groomedLog],
		});
	});

	it('guards invalid and concurrent merge requests while exposing cancellation controls', async () => {
		const sourceTab = createTab('source-tab', [
			createLog('source', 1000, 'user', 'Source context'),
		]);
		const targetTab = createTab('target-tab', [createLog('target', 2000, 'ai', 'Target context')]);
		const sourceSession = createSession('source', {
			aiTabs: [sourceTab],
			activeTabId: sourceTab.id,
		});
		const targetSession = createSession('target', {
			aiTabs: [targetTab],
			activeTabId: targetTab.id,
		});
		const { result } = renderHook(() => useMergeSession(sourceTab.id));

		await act(async () => {
			const missingSource = await result.current.startMerge({
				sourceSession,
				sourceTabId: 'missing-source',
				targetSession,
				targetTabId: targetTab.id,
				options: rawMergeOptions,
			});
			expect(missingSource).toMatchObject({ success: false, error: 'Source tab not found' });
		});

		act(() => {
			result.current.reset();
		});

		await act(async () => {
			const missingTarget = await result.current.startMerge({
				sourceSession,
				sourceTabId: sourceTab.id,
				targetSession,
				targetTabId: 'missing-target',
				options: rawMergeOptions,
			});
			expect(missingTarget).toMatchObject({ success: false, error: 'Target tab not found' });
		});

		act(() => {
			result.current.reset();
			useOperationStore.getState().setMergeTabState(sourceTab.id, {
				state: 'merging',
				progress: null,
				result: null,
				error: null,
				startTime: 1700000000000,
			});
		});

		await act(async () => {
			const duplicateTabMerge = await result.current.startMerge({
				sourceSession,
				sourceTabId: sourceTab.id,
				targetSession,
				targetTabId: targetTab.id,
				options: rawMergeOptions,
			});
			expect(duplicateTabMerge.error).toBe('This tab is already being merged.');
		});

		act(() => {
			result.current.reset();
			useOperationStore.getState().setGlobalMergeInProgress(true);
		});

		await act(async () => {
			const concurrent = await result.current.startMerge({
				sourceSession,
				sourceTabId: sourceTab.id,
				targetSession,
				targetTabId: targetTab.id,
				options: rawMergeOptions,
			});
			expect(concurrent.error).toContain('already in progress');
		});

		act(() => {
			useOperationStore.getState().resetAll();
			useOperationStore.getState().setMergeTabState(sourceTab.id, {
				state: 'merging',
				progress: null,
				result: null,
				error: null,
				startTime: 1700000000000,
			});
			result.current.cancelTab(sourceTab.id);
		});

		expect(contextGroomer.contextGroomingService.cancelGrooming).toHaveBeenCalled();
		expect(result.current.getTabMergeState(sourceTab.id)).toBeNull();
		expect(useOperationStore.getState().globalMergeInProgress).toBe(false);
	});

	it('covers validation, warning, fallback naming, and reset helper branches', async () => {
		const sourceTab = createTab('source-tab', [
			createLog('source-large', 1000, 'user', 'A'.repeat(400_008)),
		]);
		const targetTab = createTab('target-tab', []);
		const sameSession = createSession('same', {
			name: '',
			projectRoot: '/workspace/fallback-name',
			aiTabs: [sourceTab, targetTab],
			activeTabId: sourceTab.id,
		});
		const { result } = renderHook(() => useMergeSession(sourceTab.id));

		await act(async () => {
			const sameSessionResult = await result.current.startMerge({
				sourceSession: sameSession,
				sourceTabId: sourceTab.id,
				targetSession: sameSession,
				targetTabId: targetTab.id,
				options: { ...rawMergeOptions, preserveTimestamps: false },
			});
			expect(sameSessionResult).toMatchObject({
				success: true,
				sourceSessionName: 'fallback-name',
				targetSessionName: 'fallback-name',
			});
		});

		expect(result.current.getTabMergeState(sourceTab.id)?.result?.newSessionId).toEqual(
			expect.any(String)
		);
		expect(console.info).toHaveBeenCalledWith(
			'Merging into empty target tab - will copy source context'
		);
		expect(window.maestro.logger.log).toHaveBeenCalledWith(
			'warn',
			expect.stringContaining('Large context merge'),
			undefined,
			undefined
		);

		act(() => {
			result.current.clearTabState(sourceTab.id);
		});
		expect(result.current.getTabMergeState(sourceTab.id)).toBeNull();

		await act(async () => {
			const selfMerge = await result.current.startMerge({
				sourceSession: sameSession,
				sourceTabId: sourceTab.id,
				targetSession: sameSession,
				targetTabId: sourceTab.id,
				options: rawMergeOptions,
			});
			expect(selfMerge.error).toBe('Cannot merge a tab with itself');
		});

		act(() => {
			result.current.reset();
		});

		await act(async () => {
			const emptySource = await result.current.startMerge({
				sourceSession: createSession('empty-source', {
					aiTabs: [createTab('empty-source-tab', [])],
					activeTabId: 'empty-source-tab',
				}),
				sourceTabId: 'empty-source-tab',
				targetSession: sameSession,
				targetTabId: targetTab.id,
				options: rawMergeOptions,
			});
			expect(emptySource.error).toContain('Cannot merge empty context');
		});

		act(() => {
			result.current.reset();
			useOperationStore.getState().setMergeTabState('one', {
				state: 'merging',
				progress: null,
				result: null,
				error: null,
				startTime: 1,
			});
			useOperationStore.getState().setMergeTabState('two', {
				state: 'merging',
				progress: null,
				result: null,
				error: null,
				startTime: 2,
			});
			result.current.cancelMerge();
			__resetMergeInProgress?.();
		});

		expect(contextGroomer.contextGroomingService.cancelGrooming).toHaveBeenCalled();
		expect(useOperationStore.getState().mergeStates.size).toBe(0);
		expect(useOperationStore.getState().globalMergeInProgress).toBe(false);
	});

	it('records grooming failures in per-tab state', async () => {
		const sourceTab = createTab('source-tab', [
			createLog('source', 1000, 'user', 'Source context'),
		]);
		const targetTab = createTab('target-tab', [createLog('target', 2000, 'ai', 'Target context')]);
		const sourceSession = createSession('source', {
			aiTabs: [sourceTab],
			activeTabId: sourceTab.id,
		});
		const targetSession = createSession('target', {
			aiTabs: [targetTab],
			activeTabId: targetTab.id,
		});
		vi.mocked(contextGroomer.contextGroomingService.groomContexts).mockResolvedValueOnce({
			success: false,
			groomedLogs: [],
			tokensSaved: 0,
			error: undefined,
		});
		const { result } = renderHook(() => useMergeSession(sourceTab.id));

		let mergeResult: Awaited<ReturnType<typeof result.current.startMerge>>;
		await act(async () => {
			mergeResult = await result.current.startMerge({
				sourceSession,
				sourceTabId: sourceTab.id,
				targetSession,
				targetTabId: targetTab.id,
				options: { ...rawMergeOptions, groomContext: true },
			});
		});

		expect(mergeResult!).toEqual({ success: false, error: 'Grooming failed' });
		expect(result.current.getTabMergeState(sourceTab.id)).toMatchObject({
			state: 'error',
			error: 'Grooming failed',
		});
	});

	it('adds newly created merged sessions to app state and records history', async () => {
		const sourceTab = createTab('source-tab', [
			createLog('source-late', 3000, 'ai', 'Source answer'),
			createLog('source-early', 1000, 'user', 'Source prompt'),
		]);
		const targetTab = createTab('target-tab', [
			createLog('target-middle', 2000, 'ai', 'Target answer'),
		]);
		const sourceSession = createSession('source', {
			name: 'Source Project',
			groupId: 'group-1',
			aiTabs: [sourceTab],
			activeTabId: sourceTab.id,
		});
		const targetSession = createSession('target', {
			name: 'Target Project',
			aiTabs: [targetTab],
			activeTabId: targetTab.id,
		});
		let sessions = [sourceSession, targetSession];
		const setSessions = vi.fn((updater: SetStateAction<Session[]>) => {
			sessions = typeof updater === 'function' ? updater(sessions) : updater;
		});
		const onSessionCreated = vi.fn();
		vi.mocked(window.maestro.history.add).mockRejectedValueOnce(new Error('history unavailable'));
		const { result } = renderHook(() =>
			useMergeSessionWithSessions({
				sessions,
				setSessions,
				activeTabId: sourceTab.id,
				onSessionCreated,
			})
		);

		let mergeResult: Awaited<ReturnType<typeof result.current.executeMerge>>;
		await act(async () => {
			mergeResult = await result.current.executeMerge(
				sourceSession,
				sourceTab.id,
				targetSession.id,
				targetTab.id,
				rawMergeOptions
			);
		});

		expect(mergeResult!).toMatchObject({ success: true, newSessionId: expect.any(String) });
		expect(sessions).toHaveLength(3);
		const mergedSession = sessions[2];
		expect(mergedSession).toMatchObject({
			name: 'Merged: Source Project + Target Project',
			groupId: 'group-1',
			projectRoot: '/workspace/source',
		});
		expect(mergedSession.aiTabs[0].logs.map((log) => log.id)).toEqual([
			'source-early',
			'target-middle',
			'source-late',
		]);
		expect(window.maestro.history.add).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'AUTO',
				summary: 'Merged contexts from Source Project, Target Project',
				sessionId: mergedSession.id,
				projectPath: '/workspace/source',
			})
		);
		expect(window.maestro.logger.log).toHaveBeenCalledWith(
			'warn',
			'Failed to log merge operation to history:',
			undefined,
			expect.any(Error)
		);
		expect(onSessionCreated).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: mergedSession.id,
				sessionName: mergedSession.name,
				sourceSessionName: 'Source Project',
				targetSessionName: 'Target Project',
			})
		);
	});

	it('injects source context into an existing target tab and tolerates history failures', async () => {
		const sourceTab = createTab('source-tab', [
			createLog('system-source', 900, 'system', 'System prompt should not transfer'),
			createLog('user-source', 1000, 'user', 'Implement the parser'),
			createLog('ai-source', 1100, 'ai', 'Parser plan'),
		]);
		const targetTab = createTab('target-tab', [createLog('target', 2000, 'ai', 'Target context')]);
		const sourceSession = createSession('source', {
			name: 'Source Project',
			aiTabs: [sourceTab],
			activeTabId: sourceTab.id,
		});
		const targetSession = createSession('target', {
			name: 'Target Project',
			aiTabs: [targetTab, createTab('other-target-tab', [createLog('other', 2100, 'ai', 'Other')])],
			activeTabId: targetTab.id,
		});
		let sessions = [sourceSession, targetSession];
		const setSessions = vi.fn((updater: SetStateAction<Session[]>) => {
			sessions = typeof updater === 'function' ? updater(sessions) : updater;
		});
		const onMergeComplete = vi.fn();
		vi.mocked(window.maestro.history.add).mockRejectedValueOnce(new Error('history unavailable'));
		const { result } = renderHook(() =>
			useMergeSessionWithSessions({
				sessions,
				setSessions,
				activeTabId: sourceTab.id,
				onMergeComplete,
			})
		);

		let mergeResult: Awaited<ReturnType<typeof result.current.executeMerge>>;
		await act(async () => {
			mergeResult = await result.current.executeMerge(
				sourceSession,
				sourceTab.id,
				targetSession.id,
				targetTab.id,
				injectMergeOptions
			);
		});

		expect(mergeResult!).toMatchObject({
			success: true,
			targetSessionId: 'target',
			targetTabId: 'target-tab',
		});
		const updatedTargetTab = sessions[1].aiTabs[0];
		expect(updatedTargetTab.logs.at(-1)).toMatchObject({
			source: 'system',
			text: 'Context merged from "Source Project".',
		});
		expect(updatedTargetTab.pendingMergedContext).toContain('User: Implement the parser');
		expect(updatedTargetTab.pendingMergedContext).toContain('Assistant: Parser plan');
		expect(updatedTargetTab.pendingMergedContext).not.toContain(
			'System prompt should not transfer'
		);
		expect(updatedTargetTab.inputValue).toContain('Source Project');
		expect(updatedTargetTab.autoSendOnActivate).toBe(true);
		expect(onMergeComplete).toHaveBeenCalledWith(
			sourceTab.id,
			expect.objectContaining({ success: true })
		);
		expect(window.maestro.logger.log).toHaveBeenCalledWith(
			'warn',
			'Failed to log merge operation to history:',
			undefined,
			expect.any(Error)
		);
		expect(window.maestro.logger.log).toHaveBeenCalledWith(
			'info',
			'[MergeSession] Injected context into target tab:',
			undefined,
			expect.objectContaining({ targetSessionId: 'target', targetTabId: 'target-tab' })
		);
	});

	it('returns wrapper errors without mutating sessions when the target session is missing', async () => {
		const sourceSession = createSession('source');
		let sessions = [sourceSession];
		const setSessions = vi.fn((updater: SetStateAction<Session[]>) => {
			sessions = typeof updater === 'function' ? updater(sessions) : updater;
		});
		const { result } = renderHook(() =>
			useMergeSessionWithSessions({
				sessions,
				setSessions,
				activeTabId: sourceSession.activeTabId,
			})
		);

		let mergeResult: Awaited<ReturnType<typeof result.current.executeMerge>>;
		await act(async () => {
			mergeResult = await result.current.executeMerge(
				sourceSession,
				sourceSession.activeTabId!,
				'missing-target',
				undefined,
				rawMergeOptions
			);
		});

		expect(mergeResult).toEqual({
			success: false,
			error: 'Target session not found: missing-target',
		});
		expect(setSessions).not.toHaveBeenCalled();
		expect(sessions).toEqual([sourceSession]);
	});
});

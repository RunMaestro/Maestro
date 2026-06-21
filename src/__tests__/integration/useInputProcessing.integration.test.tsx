import { act, renderHook } from '@testing-library/react';
import type React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../renderer/hooks/agent/useAgentCapabilities', async () => {
	const actual = await vi.importActual('../../renderer/hooks/agent/useAgentCapabilities');
	return {
		...actual,
		hasCapabilityCached: vi.fn((agentId: string, capability: string) => {
			if (capability === 'supportsBatchMode') {
				return ['claude-code', 'codex', 'opencode', 'factory-droid'].includes(agentId);
			}
			return false;
		}),
	};
});

import {
	DEFAULT_IMAGE_ONLY_PROMPT,
	loadInputProcessingPrompts,
	useInputProcessing,
} from '../../renderer/hooks/input/useInputProcessing';
import { gitService } from '../../renderer/services/git';
import type {
	AITab,
	BatchRunState,
	CustomAICommand,
	QueuedItem,
	Session,
} from '../../renderer/types';

function createTab(overrides: Partial<AITab> = {}): AITab {
	return {
		id: 'tab-1',
		agentSessionId: 'agent-session-1',
		name: null,
		starred: false,
		logs: [],
		inputValue: '',
		stagedImages: [],
		createdAt: 1_700_000_000_000,
		state: 'idle',
		saveToHistory: true,
		...overrides,
	};
}

function createSession(overrides: Partial<Session> = {}): Session {
	const tab = createTab();
	return {
		id: 'session-1',
		name: 'Integration Session',
		toolType: 'claude-code',
		state: 'idle',
		cwd: '/repo',
		fullPath: '/repo',
		projectRoot: '/repo',
		aiLogs: [],
		shellLogs: [],
		workLog: [],
		contextUsage: 0,
		inputMode: 'ai',
		aiPid: 1234,
		terminalPid: 5678,
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
		...overrides,
	} as Session;
}

const defaultBatchState: BatchRunState = {
	isRunning: false,
	isStopping: false,
	documents: [],
	lockedDocuments: [],
	currentDocumentIndex: 0,
	currentDocTasksTotal: 0,
	currentDocTasksCompleted: 0,
	totalTasksAcrossAllDocs: 0,
	completedTasksAcrossAllDocs: 0,
	loopEnabled: false,
	loopIteration: 0,
	folderPath: '',
	worktreeActive: false,
};

describe('useInputProcessing integration', () => {
	const setSessions = vi.fn();
	const setInputValue = vi.fn();
	const setStagedImages = vi.fn();
	const setSlashCommandOpen = vi.fn();
	const syncAiInputToSession = vi.fn();
	const syncTerminalInputToSession = vi.fn();
	const getBatchState = vi.fn(() => defaultBatchState);
	const processQueuedItemRef = { current: vi.fn() };
	const flushBatchedUpdates = vi.fn();
	const inputRef = { current: null } as React.RefObject<HTMLTextAreaElement | null>;
	let originalMaestro: typeof window.maestro;

	function createDeps(overrides: Partial<Parameters<typeof useInputProcessing>[0]> = {}) {
		const session = createSession();
		return {
			activeSession: session,
			activeSessionId: session.id,
			setSessions,
			inputValue: '',
			setInputValue,
			stagedImages: [],
			setStagedImages,
			inputRef,
			customAICommands: [] as CustomAICommand[],
			setSlashCommandOpen,
			syncAiInputToSession,
			syncTerminalInputToSession,
			isAiMode: true,
			sessionsRef: { current: [session] },
			getBatchState,
			activeBatchRunState: defaultBatchState,
			processQueuedItemRef,
			flushBatchedUpdates,
			...overrides,
		};
	}

	function applySetSessionCalls(initialSessions: Session[]) {
		return setSessions.mock.calls.reduce((sessions, [update]) => {
			return typeof update === 'function' ? update(sessions) : update;
		}, initialSessions);
	}

	const flushAsync = () => new Promise((resolve) => setTimeout(resolve, 0));
	const flushAsyncTurns = async (turns = 2) => {
		for (let index = 0; index < turns; index += 1) {
			await flushAsync();
		}
	};
	const expectQueueDecision = (data: Record<string, unknown>) => {
		expect(window.maestro.logger.log).toHaveBeenCalledWith(
			'info',
			'[processInput] Queue decision:',
			undefined,
			expect.objectContaining(data)
		);
	};

	beforeEach(() => {
		vi.clearAllMocks();
		getBatchState.mockReturnValue(defaultBatchState);
		originalMaestro = window.maestro;
		window.maestro = {
			...window.maestro,
			process: {
				...window.maestro.process,
				spawn: vi.fn().mockResolvedValue(undefined),
				write: vi.fn().mockResolvedValue(undefined),
				runCommand: vi.fn().mockResolvedValue(undefined),
			},
			agents: {
				...window.maestro.agents,
				get: vi.fn().mockResolvedValue({
					id: 'claude-code',
					command: 'claude',
					path: '/usr/local/bin/claude',
					args: ['--dangerously-skip-permissions', '--flag'],
					capabilities: { supportsStreamJsonInput: true },
				}),
			},
			web: {
				...window.maestro.web,
				broadcastUserInput: vi.fn().mockResolvedValue(undefined),
			},
			fs: {
				...window.maestro.fs,
				readDir: vi.fn().mockResolvedValue([]),
			},
			history: {
				...((window.maestro as any).history || {}),
				getFilePath: vi.fn().mockResolvedValue('/repo/.maestro/history.jsonl'),
			},
			logger: {
				...window.maestro.logger,
				log: vi.fn().mockResolvedValue(undefined),
			},
			tabNaming: {
				...((window.maestro as any).tabNaming || {}),
				generateTabName: vi.fn().mockResolvedValue('Generated Name'),
			},
		} as typeof window.maestro;
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		window.maestro = originalMaestro;
	});

	it('routes built-in commands and wizard-mode messages through their handlers', async () => {
		const onHistoryCommand = vi.fn().mockResolvedValue(undefined);
		const onWizardCommand = vi.fn();
		const onSkillsCommand = vi.fn().mockResolvedValue(undefined);
		const commandTextarea = document.createElement('textarea');
		commandTextarea.style.height = '72px';

		let rendered = renderHook(() =>
			useInputProcessing(createDeps({ inputValue: '/history', onHistoryCommand }))
		);
		await act(async () => rendered.result.current.processInput());
		expect(onHistoryCommand).toHaveBeenCalledOnce();
		expect(setSlashCommandOpen).toHaveBeenCalledWith(false);
		rendered.unmount();

		vi.clearAllMocks();
		rendered = renderHook(() =>
			useInputProcessing(
				createDeps({
					inputValue: '/wizard add auth',
					inputRef: { current: commandTextarea },
					onWizardCommand,
				})
			)
		);
		await act(async () => rendered.result.current.processInput());
		expect(onWizardCommand).toHaveBeenCalledWith('add auth');
		expect(commandTextarea.style.height).toBe('auto');
		rendered.unmount();

		vi.clearAllMocks();
		rendered = renderHook(() =>
			useInputProcessing(createDeps({ inputValue: '/skills', onSkillsCommand }))
		);
		await act(async () => rendered.result.current.processInput());
		expect(onSkillsCommand).toHaveBeenCalledOnce();
		rendered.unmount();

		vi.clearAllMocks();
		const onWizardSendMessage = vi.fn().mockResolvedValue(undefined);
		rendered = renderHook(() =>
			useInputProcessing(
				createDeps({
					inputValue: 'Refine the plan',
					stagedImages: ['image-1'],
					inputRef: { current: commandTextarea },
					isWizardActive: true,
					onWizardSendMessage,
				})
			)
		);
		await act(async () => rendered.result.current.processInput());
		expect(onWizardSendMessage).toHaveBeenCalledWith('Refine the plan', ['image-1']);
		expect(setStagedImages).toHaveBeenCalledWith([]);
		expect(commandTextarea.style.height).toBe('auto');
		expect(setSessions).not.toHaveBeenCalled();
	});

	it('handles guards and expected command handler failures without dispatching agent work', async () => {
		const textarea = document.createElement('textarea');
		textarea.style.height = '64px';

		let rendered = renderHook(() =>
			useInputProcessing(createDeps({ activeSession: null, inputValue: 'ignored' }))
		);
		await act(async () => rendered.result.current.processInput());
		expect(flushBatchedUpdates).toHaveBeenCalledOnce();
		expect(setSessions).not.toHaveBeenCalled();
		expect(window.maestro.process.spawn).not.toHaveBeenCalled();
		rendered.unmount();

		vi.clearAllMocks();
		const historyError = new Error('history failed');
		const onHistoryCommand = vi.fn().mockRejectedValue(historyError);
		rendered = renderHook(() =>
			useInputProcessing(
				createDeps({
					inputValue: '/history',
					inputRef: { current: textarea },
					onHistoryCommand,
				})
			)
		);
		await act(async () => rendered.result.current.processInput());
		await act(async () => flushAsyncTurns());
		expect(onHistoryCommand).toHaveBeenCalledOnce();
		expect(textarea.style.height).toBe('auto');
		expect(window.maestro.logger.log).toHaveBeenCalledWith(
			'error',
			'[processInput] /history command failed:',
			undefined,
			historyError
		);
		rendered.unmount();

		vi.clearAllMocks();
		const skillsError = new Error('skills failed');
		const onSkillsCommand = vi.fn().mockRejectedValue(skillsError);
		rendered = renderHook(() =>
			useInputProcessing(
				createDeps({
					inputValue: '/skills',
					inputRef: { current: textarea },
					onSkillsCommand,
				})
			)
		);
		await act(async () => rendered.result.current.processInput());
		await act(async () => flushAsyncTurns());
		expect(onSkillsCommand).toHaveBeenCalledOnce();
		expect(window.maestro.logger.log).toHaveBeenCalledWith(
			'error',
			'[processInput] /skills command failed:',
			undefined,
			skillsError
		);
		rendered.unmount();

		vi.clearAllMocks();
		const onWizardSendMessage = vi.fn().mockResolvedValue(undefined);
		rendered = renderHook(() =>
			useInputProcessing(
				createDeps({
					inputValue: '/commit',
					isWizardActive: true,
					onWizardSendMessage,
				})
			)
		);
		await act(async () => rendered.result.current.processInput());
		expect(onWizardSendMessage).not.toHaveBeenCalled();
		expect(window.maestro.logger.log).toHaveBeenCalledWith(
			'info',
			'[processInput] Ignoring slash command in wizard mode:',
			undefined,
			'/commit'
		);
		rendered.unmount();

		vi.clearAllMocks();
		const wizardError = new Error('wizard send failed');
		rendered = renderHook(() =>
			useInputProcessing(
				createDeps({
					inputValue: 'send to wizard',
					isWizardActive: true,
					onWizardSendMessage: vi.fn().mockRejectedValue(wizardError),
				})
			)
		);
		await act(async () => rendered.result.current.processInput());
		await act(async () => flushAsyncTurns());
		expect(window.maestro.logger.log).toHaveBeenCalledWith(
			'error',
			'[processInput] Wizard message failed:',
			undefined,
			wizardError
		);
	});

	it('executes idle custom commands immediately and queues them when the session is busy', async () => {
		vi.useFakeTimers();
		const textarea = document.createElement('textarea');
		textarea.style.height = '96px';
		const customCommands: CustomAICommand[] = [
			{
				id: 'commit',
				command: '/commit',
				description: 'Commit changes',
				prompt: 'Please commit all outstanding changes.',
			},
		];
		const activeTab = createTab({ id: 'tab-active', agentSessionId: 'claude-session-123' });
		const session = createSession({
			isGitRepo: true,
			aiTabs: [activeTab, createTab({ id: 'tab-sibling' })],
			activeTabId: activeTab.id,
			aiCommandHistory: ['/old'],
		});
		const inactive = createSession({ id: 'inactive-session', name: 'Inactive' });
		const getStatusSpy = vi
			.spyOn(gitService, 'getStatus')
			.mockResolvedValue({ branch: 'feature/integration' } as any);

		const { result } = renderHook(() =>
			useInputProcessing(
				createDeps({
					activeSession: session,
					activeSessionId: session.id,
					sessionsRef: { current: [session, inactive] },
					inputValue: '/commit',
					inputRef: { current: textarea },
					customAICommands: customCommands,
				})
			)
		);

		await act(async () => {
			await result.current.processInput();
			await Promise.resolve();
			await Promise.resolve();
		});

		const updated = applySetSessionCalls([inactive, session]);
		expect(updated[0]).toBe(inactive);
		expect(updated[1].state).toBe('busy');
		expect(updated[1].aiTabs.find((tab) => tab.id === 'tab-active')?.state).toBe('busy');
		expect(updated[1].aiTabs.find((tab) => tab.id === 'tab-sibling')?.state).toBe('idle');
		expect(updated[1].aiCommandHistory).toContain('/commit');
		expect(textarea.style.height).toBe('auto');
		expect(getStatusSpy).toHaveBeenCalledWith('/repo');

		await act(async () => vi.advanceTimersByTime(50));
		expect(processQueuedItemRef.current).toHaveBeenCalledWith(
			session.id,
			expect.objectContaining({ command: '/commit', tabName: 'CLAUDE' })
		);

		vi.clearAllMocks();
		const busySession = createSession({
			state: 'busy',
			aiTabs: [createTab({ state: 'busy' })],
		});
		const inactiveBusySession = createSession({ id: 'inactive-busy-session', name: 'Inactive' });
		const busyRender = renderHook(() =>
			useInputProcessing(
				createDeps({
					activeSession: busySession,
					inputValue: '/commit',
					customAICommands: customCommands,
				})
			)
		);
		await act(async () => busyRender.result.current.processInput());
		const queued = setSessions.mock.calls[0][0]([inactiveBusySession, busySession]);
		expect(queued[0]).toBe(inactiveBusySession);
		expect(queued[1].executionQueue[0]).toEqual(
			expect.objectContaining({ type: 'command', command: '/commit' })
		);
	});

	it('queues write messages while Auto Run is active', async () => {
		const runningBatchState: BatchRunState = {
			...defaultBatchState,
			isRunning: true,
			worktreeActive: false,
		};
		getBatchState.mockReturnValue(runningBatchState);
		const session = createSession({ state: 'idle' });
		const inactive = createSession({ id: 'inactive-session', name: 'Inactive' });
		const textarea = document.createElement('textarea');
		textarea.style.height = '88px';

		const { result } = renderHook(() =>
			useInputProcessing(
				createDeps({
					activeSession: session,
					sessionsRef: { current: [session] },
					inputValue: 'regular write request',
					inputRef: { current: textarea },
					activeBatchRunState: runningBatchState,
				})
			)
		);

		await act(async () => result.current.processInput());
		const updated = setSessions.mock.calls[0][0]([inactive, session]);
		expect(updated[0]).toBe(inactive);
		expect(updated[1].executionQueue[0]).toEqual(
			expect.objectContaining({ type: 'message', text: 'regular write request' })
		);
		expect(window.maestro.process.spawn).not.toHaveBeenCalled();
		expect(setInputValue).toHaveBeenCalledWith('');
		expect(textarea.style.height).toBe('auto');
		expectQueueDecision({ isAutoRunActive: true, shouldQueue: true });
	});

	it('bypasses the write queue only when busy and queued work is read-only', async () => {
		const writeTab = createTab({ id: 'write-tab', agentSessionId: 'claude-write-1' });
		const readOnlyBusyTab = createTab({
			id: 'read-only-tab',
			agentSessionId: 'claude-read-1',
			state: 'busy',
			readOnlyMode: true,
		});
		const readOnlyQueuedItem: QueuedItem = {
			id: 'queued-readonly',
			timestamp: 1,
			tabId: readOnlyBusyTab.id,
			type: 'message',
			text: 'inspect',
			readOnlyMode: true,
		};
		const bypassSession = createSession({
			state: 'busy',
			aiTabs: [writeTab, readOnlyBusyTab],
			activeTabId: writeTab.id,
			executionQueue: [readOnlyQueuedItem],
		});

		let rendered = renderHook(() =>
			useInputProcessing(
				createDeps({
					activeSession: bypassSession,
					sessionsRef: { current: [bypassSession] },
					inputValue: 'write while read-only work runs',
				})
			)
		);
		await act(async () => rendered.result.current.processInput());
		await act(async () => flushAsyncTurns());
		expectQueueDecision({ shouldQueue: false, queueLength: 1 });
		expect(window.maestro.process.spawn).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: 'session-1-ai-write-tab',
				prompt: 'write while read-only work runs',
			})
		);
		rendered.unmount();

		vi.clearAllMocks();
		const blockingQueuedItem: QueuedItem = {
			...readOnlyQueuedItem,
			id: 'queued-write',
			readOnlyMode: false,
		};
		const queuedSession = createSession({
			state: 'busy',
			aiTabs: [writeTab, readOnlyBusyTab],
			activeTabId: writeTab.id,
			executionQueue: [blockingQueuedItem],
		});
		rendered = renderHook(() =>
			useInputProcessing(
				createDeps({
					activeSession: queuedSession,
					inputValue: 'wait for write queue',
				})
			)
		);
		await act(async () => rendered.result.current.processInput());
		const updated = setSessions.mock.calls[0][0]([queuedSession]);
		expect(updated[0].executionQueue).toEqual([
			blockingQueuedItem,
			expect.objectContaining({
				type: 'message',
				text: 'wait for write queue',
				tabName: 'CLAUDE',
			}),
		]);
		expect(window.maestro.process.spawn).not.toHaveBeenCalled();
		expectQueueDecision({ shouldQueue: true, queueLength: 1 });

		vi.clearAllMocks();
		const writeBusySession = createSession({
			state: 'busy',
			aiTabs: [
				writeTab,
				createTab({
					id: 'write-busy-tab',
					agentSessionId: 'claude-write-2',
					state: 'busy',
					readOnlyMode: false,
				}),
			],
			activeTabId: writeTab.id,
			executionQueue: [readOnlyQueuedItem],
		});
		rendered = renderHook(() =>
			useInputProcessing(
				createDeps({
					activeSession: writeBusySession,
					inputValue: 'wait for write-mode tab',
				})
			)
		);
		await act(async () => rendered.result.current.processInput());
		const blockedByWriteTab = setSessions.mock.calls[0][0]([writeBusySession]);
		expect(blockedByWriteTab[0].executionQueue.at(-1)).toEqual(
			expect.objectContaining({ type: 'message', text: 'wait for write-mode tab' })
		);
		expectQueueDecision({ shouldQueue: true });
	});

	it('tracks local terminal cd variants only after directory verification succeeds', async () => {
		const isRepoSpy = vi.spyOn(gitService, 'isRepo').mockResolvedValue(true);
		const cases = [
			{ command: 'cd', shellCwd: '/repo/src', expectedShellCwd: '/repo', readDirPath: null },
			{ command: 'cd ~', shellCwd: '/tmp', expectedShellCwd: '/repo', readDirPath: '/repo' },
			{
				command: 'cd ~/docs',
				shellCwd: '/tmp',
				expectedShellCwd: '/repo/docs',
				readDirPath: '/repo/docs',
			},
			{
				command: 'cd "/repo/app"',
				shellCwd: '/repo',
				expectedShellCwd: '/repo/app',
				readDirPath: '/repo/app',
			},
			{
				command: 'cd ..',
				shellCwd: '/repo/src/components',
				expectedShellCwd: '/repo/src',
				readDirPath: '/repo/src',
			},
			{
				command: 'cd ../lib/utils',
				shellCwd: '/repo/src/components',
				expectedShellCwd: '/repo/src/lib/utils',
				readDirPath: '/repo/src/lib/utils',
			},
			{
				command: 'cd feature',
				shellCwd: '/repo/src',
				expectedShellCwd: '/repo/src/feature',
				readDirPath: '/repo/src/feature',
			},
		];

		for (const testCase of cases) {
			vi.clearAllMocks();
			isRepoSpy.mockResolvedValue(true);
			const session = createSession({
				inputMode: 'terminal',
				cwd: '/repo',
				shellCwd: testCase.shellCwd,
			});
			const rendered = renderHook(() =>
				useInputProcessing(
					createDeps({
						activeSession: session,
						inputValue: testCase.command,
						isAiMode: false,
					})
				)
			);
			await act(async () => rendered.result.current.processInput());
			await act(async () => flushAsyncTurns());

			if (testCase.readDirPath) {
				expect(window.maestro.fs.readDir).toHaveBeenCalledWith(testCase.readDirPath, undefined);
			} else {
				expect(window.maestro.fs.readDir).not.toHaveBeenCalled();
			}
			expect(isRepoSpy).toHaveBeenCalledWith(testCase.expectedShellCwd, undefined);
			expect(window.maestro.process.runCommand).toHaveBeenCalledWith(
				expect.objectContaining({
					command: testCase.command,
					cwd: testCase.shellCwd,
					sessionSshRemoteConfig: undefined,
				})
			);
			const inactive = createSession({ id: `inactive-${testCase.command}`, name: 'Inactive' });
			const updated = applySetSessionCalls([inactive, session]);
			expect(updated[0]).toBe(inactive);
			expect(updated[1].shellCwd).toBe(testCase.expectedShellCwd);
			expect(updated[1].isGitRepo).toBe(true);
			rendered.unmount();
		}

		vi.clearAllMocks();
		const remoteSession = createSession({
			inputMode: 'terminal',
			cwd: '/local/repo',
			sessionSshRemoteConfig: {
				enabled: true,
				remoteId: 'remote-1',
				workingDirOverride: '/remote/repo',
			},
		});
		let rendered = renderHook(() =>
			useInputProcessing(
				createDeps({
					activeSession: remoteSession,
					inputValue: 'cd',
					isAiMode: false,
				})
			)
		);
		await act(async () => rendered.result.current.processInput());
		await act(async () => flushAsyncTurns());
		expect(window.maestro.fs.readDir).not.toHaveBeenCalled();
		expect(isRepoSpy).toHaveBeenCalledWith('/remote/repo', 'remote-1');
		let updated = applySetSessionCalls([remoteSession]);
		expect(updated[0].remoteCwd).toBe('/remote/repo');
		rendered.unmount();

		vi.clearAllMocks();
		vi.mocked(window.maestro.fs.readDir).mockRejectedValueOnce(new Error('missing directory'));
		const missingSession = createSession({
			inputMode: 'terminal',
			cwd: '/repo',
			shellCwd: '/repo/src',
		});
		rendered = renderHook(() =>
			useInputProcessing(
				createDeps({
					activeSession: missingSession,
					inputValue: 'cd missing',
					isAiMode: false,
				})
			)
		);
		await act(async () => rendered.result.current.processInput());
		await act(async () => flushAsyncTurns());
		expect(window.maestro.fs.readDir).toHaveBeenCalledWith('/repo/src/missing', undefined);
		expect(isRepoSpy).not.toHaveBeenCalled();
		updated = applySetSessionCalls([missingSession]);
		expect(updated[0].shellCwd).toBe('/repo/src');
	});

	it('handles terminal clear and verified remote cd commands', async () => {
		const shellSession = createSession({
			inputMode: 'terminal',
			shellLogs: [
				{ id: 'shell-1', timestamp: 1, source: 'user', text: 'pwd' },
				{ id: 'shell-2', timestamp: 2, source: 'output', text: '/repo' },
			] as any,
		});
		let rendered = renderHook(() =>
			useInputProcessing(
				createDeps({
					activeSession: shellSession,
					inputValue: 'clear',
					isAiMode: false,
				})
			)
		);
		await act(async () => rendered.result.current.processInput());
		let updated = applySetSessionCalls([
			createSession({ id: 'inactive-session', name: 'Inactive' }),
			shellSession,
		]);
		expect(updated[1].shellLogs).toEqual([]);
		expect(updated[1].state).toBe('idle');
		expect(window.maestro.process.runCommand).not.toHaveBeenCalled();
		rendered.unmount();

		vi.clearAllMocks();
		const isRepoSpy = vi.spyOn(gitService, 'isRepo').mockResolvedValue(false);
		const remoteSession = createSession({
			inputMode: 'terminal',
			cwd: '/local/repo',
			sessionSshRemoteConfig: {
				enabled: true,
				remoteId: 'remote-1',
				workingDirOverride: '/remote/repo',
			},
		});
		rendered = renderHook(() =>
			useInputProcessing(
				createDeps({
					activeSession: remoteSession,
					sessionsRef: { current: [remoteSession] },
					inputValue: 'cd ~/src',
					isAiMode: false,
				})
			)
		);
		await act(async () => rendered.result.current.processInput());
		await act(async () => {
			await flushAsync();
		});

		expect(window.maestro.fs.readDir).toHaveBeenCalledWith('/remote/repo/src', 'remote-1');
		expect(isRepoSpy).toHaveBeenCalledWith('/remote/repo/src', 'remote-1');
		expect(window.maestro.process.runCommand).toHaveBeenCalledWith(
			expect.objectContaining({
				command: 'cd ~/src',
				cwd: '/remote/repo',
				sessionSshRemoteConfig: remoteSession.sessionSshRemoteConfig,
			})
		);
		updated = applySetSessionCalls([remoteSession]);
		expect(updated[0].remoteCwd).toBe('/remote/repo/src');
		expect(updated[0].isGitRepo).toBe(false);
		rendered.unmount();

		vi.clearAllMocks();
		rendered = renderHook(() =>
			useInputProcessing(
				createDeps({
					activeSession: remoteSession,
					sessionsRef: { current: [remoteSession] },
					inputValue: 'cd ~',
					isAiMode: false,
				})
			)
		);
		await act(async () => rendered.result.current.processInput());
		await act(async () => {
			await flushAsync();
		});
		expect(window.maestro.fs.readDir).toHaveBeenCalledWith('/remote/repo', 'remote-1');
		expect(isRepoSpy).toHaveBeenCalledWith('/remote/repo', 'remote-1');
		updated = applySetSessionCalls([remoteSession]);
		expect(updated[0].remoteCwd).toBe('/remote/repo');
	});

	it('spawns batch agents with read-only, nudge, image, and session override context', async () => {
		const textarea = document.createElement('textarea');
		textarea.style.height = '80px';
		const tab = createTab({ readOnlyMode: true, agentSessionId: 'claude-existing-1' });
		const session = createSession({
			aiTabs: [tab],
			activeTabId: tab.id,
			nudgeMessage: 'Stay inside the requested scope.',
			customPath: '/opt/claude',
			customArgs: '--fast',
			customEnvVars: { MODE: 'integration' },
			customModel: 'sonnet',
			customContextWindow: 200000,
		});
		const { result } = renderHook(() =>
			useInputProcessing(
				createDeps({
					activeSession: session,
					sessionsRef: { current: [session] },
					inputValue: 'fix this bug',
					stagedImages: ['image-1'],
					inputRef: { current: textarea },
				})
			)
		);

		await act(async () => result.current.processInput());
		await act(async () => {
			await flushAsync();
		});

		const spawnCall = vi.mocked(window.maestro.process.spawn).mock.calls[0][0];
		expect(spawnCall).toEqual(
			expect.objectContaining({
				sessionId: 'session-1-ai-tab-1',
				toolType: 'claude-code',
				command: '/usr/local/bin/claude',
				args: ['--flag'],
				images: ['image-1'],
				readOnlyMode: true,
				sessionCustomPath: '/opt/claude',
				sessionCustomArgs: '--fast',
				sessionCustomEnvVars: { MODE: 'integration' },
				sessionCustomModel: 'sonnet',
				sessionCustomContextWindow: 200000,
				sendPromptViaStdin: false,
				sendPromptViaStdinRaw: false,
			})
		);
		expect(spawnCall.prompt).toContain('fix this bug');
		expect(spawnCall.prompt).toContain('Stay inside the requested scope.');
		expect(spawnCall.prompt).toContain('IMPORTANT: You are in read-only/plan mode');
		expect(window.maestro.web.broadcastUserInput).toHaveBeenCalledWith(
			session.id,
			'fix this bug',
			'ai'
		);
		expect(textarea.style.height).toBe('auto');
		expect(setStagedImages).toHaveBeenCalledWith([]);
		expectQueueDecision({ isReadOnlyMode: true, shouldQueue: false });
	});

	it('builds new batch prompts with image-only, merged-context, and system-prompt context', async () => {
		const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		vi.mocked(window.maestro.prompts.get).mockResolvedValueOnce({
			success: true,
			content: '# User Request\nDescribe the attached image.',
		});
		await loadInputProcessingPrompts(true);
		const tab = createTab({
			agentSessionId: null,
			logs: [{ id: 'prior', timestamp: 1, source: 'assistant', text: 'Earlier context' }],
			pendingMergedContext: 'Merged source context',
		});
		const session = createSession({
			isGitRepo: true,
			aiTabs: [tab],
			activeTabId: tab.id,
		});

		const { result } = renderHook(() =>
			useInputProcessing(
				createDeps({
					activeSession: session,
					sessionsRef: { current: [session] },
					inputValue: '',
					stagedImages: ['image-only'],
					conductorProfile: 'Keeps responses terse.',
				})
			)
		);

		await act(async () => result.current.processInput());
		await act(async () => flushAsyncTurns(3));

		expect(consoleWarn).toHaveBeenCalledWith(
			'[InputProcessing] Spawning batch agent without agentSessionId for tab with existing logs',
			expect.objectContaining({ tabId: tab.id, logCount: 1, sessionId: session.id })
		);
		const spawnCall = vi.mocked(window.maestro.process.spawn).mock.calls[0][0];
		expect(spawnCall.agentSessionId).toBeUndefined();
		expect(spawnCall.images).toEqual(['image-only']);
		expect(spawnCall.prompt).toContain('Merged source context');
		expect(spawnCall.prompt).toContain(DEFAULT_IMAGE_ONLY_PROMPT);
		expect(spawnCall.prompt).toContain('# User Request');
		expect(window.maestro.logger.log).toHaveBeenCalledWith(
			'info',
			'[InputProcessing] Injected merged context into message:',
			undefined,
			expect.objectContaining({
				contextLength: 'Merged source context'.length,
			})
		);
		const updated = applySetSessionCalls([
			createSession({ id: 'inactive-session', name: 'Inactive' }),
			session,
		]);
		expect(updated[1].aiTabs[0].pendingMergedContext).toBeUndefined();
	});

	it('logs and skips the AI session update when no active tab exists', async () => {
		const session = createSession({
			toolType: 'gemini-cli',
			aiTabs: [],
			activeTabId: 'missing-tab',
		});

		const { result } = renderHook(() =>
			useInputProcessing(
				createDeps({
					activeSession: session,
					sessionsRef: { current: [session] },
					inputValue: 'send without tab',
				})
			)
		);

		await act(async () => result.current.processInput());
		const updated = applySetSessionCalls([
			createSession({ id: 'inactive-session', name: 'Inactive' }),
			session,
		]);
		expect(window.maestro.logger.log).toHaveBeenCalledWith(
			'error',
			'[processInput] No active tab found - session has no aiTabs, this should not happen',
			undefined,
			undefined
		);
		expect(window.maestro.process.write).toHaveBeenCalledWith(
			'session-1-ai-default',
			'send without tab'
		);
		expect(updated[1]).toBe(session);
	});

	it('updates automatic tab names from quick matches, generated names, null responses, and failures', async () => {
		let tab = createTab({ agentSessionId: null, name: null });
		let session = createSession({ aiTabs: [tab], activeTabId: tab.id });
		let rendered = renderHook(() =>
			useInputProcessing(
				createDeps({
					activeSession: session,
					sessionsRef: { current: [session] },
					inputValue: 'Review https://github.com/runmaestro/maestro/pull/321',
					automaticTabNamingEnabled: true,
				})
			)
		);
		await act(async () => rendered.result.current.processInput());
		await act(async () => flushAsyncTurns());
		let updated = applySetSessionCalls([
			createSession({ id: 'inactive-session', name: 'Inactive' }),
			session,
		]);
		expect(updated[1].aiTabs[0].name).toBe('PR #321');
		expect(window.maestro.tabNaming.generateTabName).not.toHaveBeenCalled();
		expect(window.maestro.logger.log).toHaveBeenCalledWith(
			'info',
			'Quick tab named: "PR #321"',
			'TabNaming',
			expect.objectContaining({ quickName: 'PR #321' })
		);
		rendered.unmount();

		vi.clearAllMocks();
		tab = createTab({ agentSessionId: null, name: null });
		session = createSession({ aiTabs: [tab], activeTabId: tab.id });
		rendered = renderHook(() =>
			useInputProcessing(
				createDeps({
					activeSession: session,
					sessionsRef: { current: [session] },
					inputValue: 'Give this new investigation a concise name',
					automaticTabNamingEnabled: true,
				})
			)
		);
		await act(async () => rendered.result.current.processInput());
		await act(async () => flushAsyncTurns(3));
		updated = applySetSessionCalls([
			createSession({ id: 'inactive-session', name: 'Inactive' }),
			session,
		]);
		expect(window.maestro.tabNaming.generateTabName).toHaveBeenCalledWith({
			userMessage: 'Give this new investigation a concise name',
			agentType: 'claude-code',
			cwd: '/repo',
			sessionSshRemoteConfig: undefined,
		});
		expect(updated[1].aiTabs[0]).toEqual(
			expect.objectContaining({ name: 'Generated Name', isGeneratingName: false })
		);
		const manuallyNamedSession = createSession({
			aiTabs: [createTab({ agentSessionId: null, name: 'Manual name' })],
			activeTabId: 'tab-1',
		});
		applySetSessionCalls([manuallyNamedSession]);
		expect(window.maestro.logger.log).toHaveBeenCalledWith(
			'info',
			'Auto tab naming skipped (tab already named)',
			'TabNaming',
			expect.objectContaining({
				existingName: 'Manual name',
				generatedName: 'Generated Name',
			})
		);
		rendered.unmount();

		vi.clearAllMocks();
		vi.mocked(window.maestro.tabNaming.generateTabName).mockResolvedValueOnce(null);
		tab = createTab({ agentSessionId: null, name: null });
		session = createSession({ aiTabs: [tab], activeTabId: tab.id });
		rendered = renderHook(() =>
			useInputProcessing(
				createDeps({
					activeSession: session,
					sessionsRef: { current: [session] },
					inputValue: 'Name may be unavailable',
					automaticTabNamingEnabled: true,
				})
			)
		);
		await act(async () => rendered.result.current.processInput());
		await act(async () => flushAsyncTurns(3));
		updated = applySetSessionCalls([
			createSession({ id: 'inactive-session', name: 'Inactive' }),
			session,
		]);
		expect(updated[1].aiTabs[0]).toEqual(
			expect.objectContaining({ name: null, isGeneratingName: false })
		);
		expect(window.maestro.logger.log).toHaveBeenCalledWith(
			'warn',
			'Auto tab naming returned null',
			'TabNaming',
			expect.objectContaining({ tabId: tab.id })
		);
		rendered.unmount();

		vi.clearAllMocks();
		const namingError = new Error('naming failed');
		vi.mocked(window.maestro.tabNaming.generateTabName).mockRejectedValueOnce(namingError);
		tab = createTab({ agentSessionId: null, name: null });
		session = createSession({ aiTabs: [tab], activeTabId: tab.id });
		rendered = renderHook(() =>
			useInputProcessing(
				createDeps({
					activeSession: session,
					sessionsRef: { current: [session] },
					inputValue: 'Name should fail cleanly',
					automaticTabNamingEnabled: true,
				})
			)
		);
		await act(async () => rendered.result.current.processInput());
		await act(async () => flushAsyncTurns(3));
		updated = applySetSessionCalls([
			createSession({ id: 'inactive-session', name: 'Inactive' }),
			session,
		]);
		expect(updated[1].aiTabs[0]).toEqual(
			expect.objectContaining({ name: null, isGeneratingName: false })
		);
		expect(window.maestro.logger.log).toHaveBeenCalledWith(
			'error',
			'Auto tab naming failed',
			'TabNaming',
			expect.objectContaining({ error: String(namingError) })
		);
		expectQueueDecision({ shouldQueue: false });
	});

	it('records process failures for batch spawns, terminal commands, and stdin writes', async () => {
		vi.mocked(window.maestro.process.spawn).mockRejectedValueOnce(new Error('spawn failed'));
		let session = createSession();
		let rendered = renderHook(() =>
			useInputProcessing(
				createDeps({
					activeSession: session,
					sessionsRef: { current: [session] },
					inputValue: 'spawn should fail',
				})
			)
		);
		await act(async () => rendered.result.current.processInput());
		await act(async () => flushAsyncTurns(3));
		let updated = applySetSessionCalls([
			createSession({ id: 'inactive-session', name: 'Inactive' }),
			session,
		]);
		expect(window.maestro.logger.log).toHaveBeenCalledWith(
			'error',
			'Failed to spawn agent batch process:',
			undefined,
			expect.any(Error)
		);
		expect(updated[1].state).toBe('idle');
		expect(updated[1].aiTabs[0].logs.at(-1)?.text).toContain('Failed to spawn agent process');
		rendered.unmount();

		vi.clearAllMocks();
		vi.mocked(window.maestro.agents.get).mockResolvedValueOnce(null as any);
		session = createSession();
		rendered = renderHook(() =>
			useInputProcessing(
				createDeps({
					activeSession: session,
					sessionsRef: { current: [session] },
					inputValue: 'missing agent config',
				})
			)
		);
		await act(async () => rendered.result.current.processInput());
		await act(async () => flushAsyncTurns(3));
		updated = applySetSessionCalls([
			createSession({ id: 'inactive-session', name: 'Inactive' }),
			session,
		]);
		expect(window.maestro.process.spawn).not.toHaveBeenCalled();
		expect(updated[1].state).toBe('idle');
		expect(updated[1].aiTabs[0].logs.at(-1)?.text).toContain('claude-code agent not found');
		rendered.unmount();

		vi.clearAllMocks();
		session = createSession();
		rendered = renderHook(() =>
			useInputProcessing(
				createDeps({
					activeSession: session,
					sessionsRef: { current: [] },
					inputValue: 'missing fresh session',
				})
			)
		);
		await act(async () => rendered.result.current.processInput());
		await act(async () => flushAsyncTurns(3));
		updated = applySetSessionCalls([
			createSession({ id: 'inactive-session', name: 'Inactive' }),
			session,
		]);
		expect(window.maestro.process.spawn).not.toHaveBeenCalled();
		expect(updated[1].state).toBe('idle');
		expect(updated[1].aiTabs[0].logs.at(-1)?.text).toContain('Session not found');
		rendered.unmount();

		vi.clearAllMocks();
		vi.mocked(window.maestro.process.runCommand).mockRejectedValueOnce(
			new Error('terminal failed')
		);
		session = createSession({ inputMode: 'terminal' });
		rendered = renderHook(() =>
			useInputProcessing(
				createDeps({
					activeSession: session,
					inputValue: 'pwd',
					isAiMode: false,
				})
			)
		);
		await act(async () => rendered.result.current.processInput());
		await act(async () => flushAsyncTurns(3));
		updated = applySetSessionCalls([
			createSession({ id: 'inactive-session', name: 'Inactive' }),
			session,
		]);
		expect(window.maestro.logger.log).toHaveBeenCalledWith(
			'error',
			'Failed to run command:',
			undefined,
			expect.any(Error)
		);
		expect(updated[1].state).toBe('idle');
		expect(updated[1].shellLogs.at(-1)?.text).toContain('Failed to run command');
		rendered.unmount();

		vi.clearAllMocks();
		vi.mocked(window.maestro.process.write).mockRejectedValueOnce(new Error('write failed'));
		session = createSession({ toolType: 'gemini-cli' });
		rendered = renderHook(() =>
			useInputProcessing(
				createDeps({
					activeSession: session,
					inputValue: 'write through stdin',
				})
			)
		);
		await act(async () => rendered.result.current.processInput());
		await act(async () => flushAsyncTurns(3));
		updated = applySetSessionCalls([
			createSession({ id: 'inactive-session', name: 'Inactive' }),
			session,
		]);
		expect(window.maestro.process.write).toHaveBeenCalledWith(
			'session-1-ai-tab-1',
			'write through stdin'
		);
		expect(window.maestro.logger.log).toHaveBeenCalledWith(
			'error',
			'Failed to write to process:',
			undefined,
			expect.any(Error)
		);
		expect(updated[1].state).toBe('idle');
		expect(updated[1].aiTabs[0].logs.at(-1)?.text).toContain('Failed to write to process');
	});
});

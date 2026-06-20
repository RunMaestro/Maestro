import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session, AITab } from '../../renderer/types';
import { useWizardHandlers, type UseWizardHandlersDeps } from '../../renderer/hooks/wizard';
import { useSessionStore } from '../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../renderer/stores/settingsStore';
import { useUIStore } from '../../renderer/stores/uiStore';
import { getModalActions, useModalStore } from '../../renderer/stores/modalStore';
import { useNotificationStore } from '../../renderer/stores/notificationStore';
import type { WizardState } from '../../renderer/components/Wizard';

type InlineWizardContext = UseWizardHandlersDeps['inlineWizardContext'];

const flushPromises = async () => {
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
	});
};

const createTab = (overrides: Partial<AITab> = {}): AITab =>
	({
		id: 'tab-1',
		agentSessionId: 'agent-session-1',
		name: 'Main',
		starred: false,
		logs: [],
		inputValue: '',
		stagedImages: [],
		createdAt: Date.now() - 60_000,
		state: 'idle',
		saveToHistory: true,
		showThinking: 'off',
		...overrides,
	}) as AITab;

const createSession = (overrides: Partial<Session> = {}): Session =>
	({
		id: 'session-1',
		name: 'Test Agent',
		toolType: 'claude-code',
		state: 'idle',
		cwd: '/repo/main',
		fullPath: '/repo/main',
		projectRoot: '/repo/main',
		createdAt: Date.now() - 120_000,
		isGitRepo: false,
		aiLogs: [],
		shellLogs: [],
		workLog: [],
		contextUsage: 0,
		inputMode: 'ai',
		aiPid: 0,
		terminalPid: 0,
		port: 3000,
		isLive: false,
		changedFiles: [],
		fileTree: [],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		fileTreeAutoRefreshInterval: 180,
		shellCwd: '/repo/main',
		aiCommandHistory: [],
		shellCommandHistory: [],
		executionQueue: [],
		activeTimeMs: 0,
		aiTabs: [createTab()],
		activeTabId: 'tab-1',
		closedTabHistory: [],
		filePreviewTabs: [],
		activeFileTabId: null,
		unifiedTabOrder: [{ type: 'ai' as const, id: 'tab-1' }],
		unifiedClosedTabHistory: [],
		...overrides,
	}) as Session;

const createWizardState = (overrides: Partial<WizardState> = {}): WizardState => ({
	currentStep: 'phase-review',
	isOpen: true,
	selectedAgent: 'claude-code',
	availableAgents: [],
	agentName: 'Wizard Agent',
	directoryPath: '/repo/wizard',
	isGitRepo: true,
	detectedAgentPath: null,
	directoryError: null,
	hasExistingAutoRunDocs: false,
	existingDocsCount: 0,
	existingDocsChoice: null,
	conversationHistory: [],
	confidenceLevel: 95,
	isReadyToProceed: true,
	isConversationLoading: false,
	conversationError: null,
	generatedDocuments: [],
	currentDocumentIndex: 0,
	isGeneratingDocuments: false,
	generationError: null,
	editedPhase1Content: null,
	wantsTour: false,
	isComplete: false,
	createdSessionId: null,
	...overrides,
});

const createInlineWizardContext = (
	overrides: Partial<InlineWizardContext> = {}
): InlineWizardContext =>
	({
		isWizardActive: false,
		isInitializing: false,
		isWaiting: false,
		wizardMode: 'new',
		wizardGoal: null,
		confidence: 0,
		ready: false,
		readyToGenerate: false,
		conversationHistory: [],
		isGeneratingDocs: false,
		generatedDocuments: [],
		existingDocuments: [],
		error: null,
		streamingContent: '',
		generationProgress: null,
		wizardTabId: null,
		agentSessionId: null,
		state: {} as never,
		getStateForTab: vi.fn(() => undefined),
		isWizardActiveForTab: vi.fn(() => false),
		startWizard: vi.fn(),
		endWizard: vi.fn().mockResolvedValue(null),
		sendMessage: vi.fn().mockResolvedValue(undefined),
		setConfidence: vi.fn(),
		setMode: vi.fn(),
		setGoal: vi.fn(),
		setGeneratingDocs: vi.fn(),
		setGeneratedDocuments: vi.fn(),
		setExistingDocuments: vi.fn(),
		setError: vi.fn(),
		clearError: vi.fn(),
		retryLastMessage: vi.fn().mockResolvedValue(undefined),
		addAssistantMessage: vi.fn(),
		clearConversation: vi.fn(),
		reset: vi.fn(),
		generateDocuments: vi.fn().mockResolvedValue(undefined),
		...overrides,
	}) as InlineWizardContext;

const createDeps = (overrides: Partial<UseWizardHandlersDeps> = {}): UseWizardHandlersDeps => ({
	inlineWizardContext: createInlineWizardContext(),
	wizardContext: {
		state: createWizardState(),
		completeWizard: vi.fn(),
		clearResumeState: vi.fn(),
		openWizard: vi.fn(),
		resetWizard: vi.fn(),
		restoreState: vi.fn(),
	},
	spawnBackgroundSynopsis: vi.fn().mockResolvedValue({
		success: true,
		response:
			'**Summary:** Implemented the dashboard shell.\n**Details:** Added navigation and persisted preferences.',
		usageStats: { inputTokens: 12, outputTokens: 34 },
	}),
	addHistoryEntry: vi.fn(),
	startBatchRun: vi.fn(),
	handleAutoRunRefreshRef: { current: vi.fn() },
	setInputValueRef: { current: vi.fn() },
	inputRef: { current: null },
	...overrides,
});

describe('useWizardHandlers integration', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-05-25T12:00:00Z'));
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});

		useSessionStore.setState({
			sessions: [],
			groups: [],
			activeSessionId: '',
			sessionsLoaded: false,
			initialLoadComplete: false,
			removedWorktreePaths: new Set(),
			cyclePosition: -1,
		});
		useSettingsStore.setState({
			defaultSaveToHistory: true,
			defaultShowThinking: 'off',
			conductorProfile: 'calm',
		} as Partial<ReturnType<typeof useSettingsStore.getState>>);
		useUIStore.setState({
			activeRightTab: 'files',
			activeFocus: 'main',
		});
		useModalStore.getState().closeAll();
		useNotificationStore.getState().clearToasts();

		window.maestro.claude.getCommands = vi.fn().mockResolvedValue([]);
		(
			window.maestro.claude as typeof window.maestro.claude & {
				getSkills: ReturnType<typeof vi.fn>;
			}
		).getSkills = vi.fn().mockResolvedValue([]);
		window.maestro.agents.discoverSlashCommands = vi.fn().mockResolvedValue([]);
		window.maestro.agents.get = vi.fn().mockResolvedValue({
			id: 'claude-code',
			name: 'Claude Code',
		});
		window.maestro.git.isRepo = vi.fn().mockResolvedValue(false);
		window.maestro.git.branches = vi.fn().mockResolvedValue({ branches: ['main'] });
		(window.maestro.git as typeof window.maestro.git & { tags: ReturnType<typeof vi.fn> }).tags = vi
			.fn()
			.mockResolvedValue({ tags: [] });
		window.maestro.stats.recordSessionCreated = vi.fn().mockResolvedValue('session-stat-id');
	});

	afterEach(() => {
		cleanup();
		act(() => {
			vi.runOnlyPendingTimers();
		});
		vi.useRealTimers();
		useModalStore.getState().closeAll();
		useNotificationStore.getState().clearToasts();
		vi.restoreAllMocks();
	});

	it('discovers slash commands and routes inline wizard thinking through the real session store', async () => {
		const session = createSession({ agentCommands: undefined });
		useSessionStore.setState({ sessions: [session], activeSessionId: session.id });
		window.maestro.claude.getCommands = vi
			.fn()
			.mockResolvedValue([{ command: '/ship', description: 'Ship workflow' }]);
		window.maestro.agents.discoverSlashCommands = vi.fn().mockResolvedValue([{ name: 'review' }]);

		const inlineWizardContext = createInlineWizardContext({
			isWizardActive: true,
			wizardTabId: 'tab-1',
			getStateForTab: vi.fn(() => ({
				isActive: true,
				isWaiting: false,
				mode: 'ask',
				goal: 'Plan release',
				confidence: 82,
				ready: true,
				conversationHistory: [
					{
						id: 'message-1',
						role: 'assistant',
						content: 'Ready to make docs',
						timestamp: Date.now(),
					},
				],
				previousUIState: {
					readOnlyMode: false,
					saveToHistory: true,
					showThinking: 'off',
				},
				error: null,
				isGeneratingDocs: false,
				generatedDocuments: [],
				streamingContent: '',
				currentDocumentIndex: 0,
				generationProgress: { current: 1, total: 2 },
				projectPath: '/repo/main',
				subfolderPath: '/repo/main/Auto Run Docs/Release',
				agentSessionId: 'wizard-agent-session',
				subfolderName: 'Release',
			})),
			sendMessage: vi.fn(async (_content, _images, callbacks) => {
				callbacks?.onThinkingChunk?.('thinking aloud');
				callbacks?.onThinkingChunk?.('{"confidence":95}');
				callbacks?.onToolExecution?.({ name: 'Read', status: 'completed' } as never);
			}),
		});
		const deps = createDeps({ inlineWizardContext });
		const { result } = renderHook(() => useWizardHandlers(deps));

		await flushPromises();

		let activeTab = useSessionStore.getState().sessions[0].aiTabs[0];
		expect(activeTab.wizardState).toMatchObject({
			isActive: true,
			mode: 'new',
			goal: 'Plan release',
			agentSessionId: 'wizard-agent-session',
			subfolderName: 'Release',
		});
		expect(useSessionStore.getState().sessions[0].agentCommands).toEqual(
			expect.arrayContaining([
				{ command: '/ship', description: 'Ship workflow' },
				expect.objectContaining({ command: '/review' }),
			])
		);

		act(() => {
			useSessionStore.getState().setSessions((sessions) =>
				sessions.map((current) => ({
					...current,
					aiTabs: current.aiTabs.map((tab) =>
						tab.id === 'tab-1'
							? {
									...tab,
									wizardState: {
										...tab.wizardState!,
										showWizardThinking: true,
										thinkingContent: 'stale',
										toolExecutions: [{ name: 'Old' }],
									},
								}
							: tab
					),
				}))
			);
		});

		await act(async () => {
			await result.current.sendWizardMessageWithThinking('What next?', ['diagram.png']);
		});

		activeTab = useSessionStore.getState().sessions[0].aiTabs[0];
		expect(inlineWizardContext.sendMessage).toHaveBeenCalledWith(
			'What next?',
			['diagram.png'],
			expect.objectContaining({
				onThinkingChunk: expect.any(Function),
				onToolExecution: expect.any(Function),
			}),
			'tab-1'
		);
		expect(activeTab.wizardState?.thinkingContent).toBe('thinking aloud');
		expect(activeTab.wizardState?.toolExecutions).toEqual([{ name: 'Read', status: 'completed' }]);

		act(() => {
			result.current.handleToggleWizardShowThinking();
			result.current.handleWizardCommand('build release notes');
		});

		activeTab = useSessionStore.getState().sessions[0].aiTabs[0];
		expect(activeTab.wizardState?.showWizardThinking).toBe(false);
		expect(activeTab.name).toBe('Wizard');
		expect(activeTab.logs.at(-1)?.text).toBe('Starting wizard with: "build release notes"');
		expect(inlineWizardContext.startWizard).toHaveBeenCalledWith(
			'build release notes',
			expect.objectContaining({ saveToHistory: true }),
			'/repo/main',
			'claude-code',
			'Test Agent',
			'tab-1',
			'session-1',
			undefined,
			undefined,
			'calm',
			expect.objectContaining({ customPath: undefined })
		);
	});

	it('launches and completes a wizard tab while preserving generated document context', async () => {
		const session = createSession();
		useSessionStore.setState({ sessions: [session], activeSessionId: session.id });
		const inlineWizardContext = createInlineWizardContext();
		const refreshAutoRun = vi.fn();
		const clearInput = vi.fn();
		const deps = createDeps({
			inlineWizardContext,
			handleAutoRunRefreshRef: { current: refreshAutoRun },
			setInputValueRef: { current: clearInput },
		});
		const { result } = renderHook(() => useWizardHandlers(deps));

		act(() => {
			result.current.handleLaunchWizardTab();
		});

		let updatedSession = useSessionStore.getState().sessions[0];
		const wizardTab = updatedSession.aiTabs.at(-1)!;
		expect(updatedSession.activeTabId).toBe(wizardTab.id);
		expect(wizardTab.name).toBe('Wizard');
		expect(inlineWizardContext.startWizard).not.toHaveBeenCalled();

		act(() => {
			vi.runOnlyPendingTimers();
		});

		expect(inlineWizardContext.startWizard).toHaveBeenCalledWith(
			undefined,
			expect.objectContaining({ readOnlyMode: false, saveToHistory: true }),
			'/repo/main',
			'claude-code',
			'Test Agent',
			wizardTab.id,
			'session-1',
			undefined,
			undefined,
			'calm',
			expect.objectContaining({ customModel: undefined })
		);

		act(() => {
			useSessionStore.getState().setSessions((sessions) =>
				sessions.map((current) => ({
					...current,
					aiTabs: current.aiTabs.map((tab) =>
						tab.id === wizardTab.id
							? {
									...tab,
									wizardState: {
										isActive: true,
										isWaiting: false,
										mode: 'new',
										confidence: 92,
										ready: true,
										conversationHistory: [
											{
												id: 'user-1',
												role: 'user',
												content: 'Plan this app',
												timestamp: Date.now() - 1000,
											},
											{
												id: 'assistant-1',
												role: 'assistant',
												content: 'Two phases are ready',
												timestamp: Date.now(),
											},
										],
										previousUIState: {
											readOnlyMode: false,
											saveToHistory: true,
											showThinking: 'off',
										},
										error: null,
										isGeneratingDocs: false,
										generatedDocuments: [
											{
												filename: 'Phase-01-Setup.md',
												content: '# Phase 1',
												taskCount: 3,
												savedPath: '/repo/main/Auto Run Docs/Phase-01-Setup.md',
											},
											{
												filename: 'Phase-02-Polish.md',
												content: '# Phase 2',
												taskCount: 2,
											},
										],
										streamingContent: '',
										currentDocumentIndex: 0,
										showWizardThinking: false,
										thinkingContent: '',
										toolExecutions: [],
										subfolderName: 'Launch Plan',
										agentSessionId: 'wizard-agent-2',
									},
								}
							: tab
					),
				}))
			);
		});

		act(() => {
			result.current.handleWizardComplete();
			result.current.handleWizardLetsGo();
		});

		updatedSession = useSessionStore.getState().sessions[0];
		const completedTab = updatedSession.aiTabs.find((tab) => tab.id === wizardTab.id)!;
		expect(completedTab.name).toBe('Launch Plan');
		expect(completedTab.agentSessionId).toBe('wizard-agent-2');
		expect(completedTab.wizardState).toBeUndefined();
		expect(completedTab.logs.map((log) => log.text)).toEqual(
			expect.arrayContaining([
				'Plan this app',
				'Two phases are ready',
				expect.stringContaining('Created 2 documents with 5 tasks'),
			])
		);
		expect(inlineWizardContext.endWizard).toHaveBeenCalled();
		expect(inlineWizardContext.generateDocuments).toHaveBeenCalledWith(undefined, wizardTab.id);
		expect(refreshAutoRun).toHaveBeenCalledTimes(1);
		expect(clearInput).toHaveBeenCalledWith('');
	});

	it('records history and skills command output into the active tab', async () => {
		const tab = createTab({
			name: 'Release Tab',
			lastSynopsisTime: Date.now() - 5_000,
		});
		const session = createSession({
			groupId: 'group-1',
			aiTabs: [tab],
			activeTabId: tab.id,
		});
		useSessionStore.setState({
			sessions: [session],
			activeSessionId: session.id,
			groups: [{ id: 'group-1', name: 'Delivery', collapsed: false, sessionIds: ['session-1'] }],
		});
		(
			window.maestro.claude as typeof window.maestro.claude & {
				getSkills: ReturnType<typeof vi.fn>;
			}
		).getSkills = vi.fn().mockResolvedValue([
			{
				name: 'review',
				source: 'project',
				tokenCount: 1400,
				description: 'Review code',
			},
			{
				name: 'notes',
				source: 'user',
				tokenCount: 80,
				description: 'No description',
			},
		]);
		const addHistoryEntry = vi.fn();
		const spawnBackgroundSynopsis = vi.fn().mockResolvedValue({
			success: true,
			response:
				'**Summary:** Implemented the dashboard shell.\n**Details:** Added navigation and persisted preferences.',
			usageStats: { inputTokens: 12, outputTokens: 34 },
		});
		const deps = createDeps({ addHistoryEntry, spawnBackgroundSynopsis });
		const { result } = renderHook(() => useWizardHandlers(deps));

		await act(async () => {
			await result.current.handleHistoryCommand();
			await result.current.handleSkillsCommand();
		});

		const activeTab = useSessionStore.getState().sessions[0].aiTabs[0];
		expect(spawnBackgroundSynopsis).toHaveBeenCalledWith(
			'session-1',
			'/repo/main',
			'agent-session-1',
			expect.stringContaining('Only synopsize work done since the last synopsis'),
			'claude-code',
			expect.objectContaining({
				customPath: undefined,
				sessionSshRemoteConfig: undefined,
			})
		);
		expect(addHistoryEntry).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'AUTO',
				summary: 'Implemented the dashboard shell.',
				fullResponse:
					'Implemented the dashboard shell.\n\nAdded navigation and persisted preferences.',
				agentSessionId: 'agent-session-1',
				sessionId: 'session-1',
				projectPath: '/repo/main',
				sessionName: 'Release Tab',
				usageStats: { inputTokens: 12, outputTokens: 34 },
			})
		);
		expect(activeTab.logs.map((log) => log.text)).toEqual(
			expect.arrayContaining([
				'Synopsis saved to history: Implemented the dashboard shell.',
				'/skills',
				expect.stringContaining('| **review** | ~1.4k | Review code |'),
			])
		);
		expect(useNotificationStore.getState().toasts[0]).toMatchObject({
			type: 'success',
			title: 'History Entry Added',
			group: 'Delivery',
			project: 'Test Agent',
			tabName: 'Release Tab',
		});
	});

	it('creates a session from onboarding wizard state and starts the first generated playbook', async () => {
		const input = document.createElement('textarea');
		const inputFocus = vi.spyOn(input, 'focus');
		window.maestro.git.isRepo = vi.fn().mockResolvedValue(true);
		window.maestro.git.branches = vi.fn().mockResolvedValue({ branches: ['main', 'release'] });
		(window.maestro.git as typeof window.maestro.git & { tags: ReturnType<typeof vi.fn> }).tags = vi
			.fn()
			.mockResolvedValue({ tags: ['v1.0.0'] });

		const completeWizard = vi.fn();
		const clearResumeState = vi.fn();
		const startBatchRun = vi.fn();
		const wizardState = createWizardState({
			agentName: 'Launch Builder',
			directoryPath: '/repo/wizard',
			customPath: '/usr/local/bin/claude',
			customArgs: '--dangerously-skip-permissions',
			customEnvVars: { FEATURE_FLAG: '1' },
			sessionSshRemoteConfig: {
				enabled: true,
				remoteId: 'remote-1',
				workingDirOverride: '/srv/wizard',
			},
			generatedDocuments: [
				{ filename: 'Phase-01-Setup.md', content: '# Phase 1', taskCount: 2 },
				{ filename: 'Phase-02-Polish.md', content: '# Phase 2', taskCount: 0 },
			],
		});
		const deps = createDeps({
			wizardContext: {
				state: wizardState,
				completeWizard,
				clearResumeState,
				openWizard: vi.fn(),
				restoreState: vi.fn(),
			},
			startBatchRun,
			inputRef: { current: input },
		});
		const { result } = renderHook(() => useWizardHandlers(deps));

		await act(async () => {
			await result.current.handleWizardLaunchSession(true);
		});

		const createdSession = useSessionStore.getState().sessions[0];
		expect(createdSession).toMatchObject({
			name: 'Launch Builder',
			toolType: 'claude-code',
			cwd: '/repo/wizard',
			isGitRepo: true,
			gitBranches: ['main', 'release'],
			gitTags: ['v1.0.0'],
			autoRunFolderPath: '/repo/wizard/.maestro/playbooks',
			autoRunSelectedFile: 'Phase-01-Setup',
			customPath: '/usr/local/bin/claude',
			customArgs: '--dangerously-skip-permissions',
			customEnvVars: { FEATURE_FLAG: '1' },
			sessionSshRemoteConfig: {
				enabled: true,
				remoteId: 'remote-1',
				workingDirOverride: '/srv/wizard',
			},
		});
		expect(useSessionStore.getState().activeSessionId).toBe(createdSession.id);
		expect(window.maestro.stats.recordSessionCreated).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: createdSession.id,
				agentType: 'claude-code',
				projectPath: '/repo/wizard',
				isRemote: true,
			})
		);
		expect(clearResumeState).toHaveBeenCalledTimes(1);
		expect(completeWizard).toHaveBeenCalledWith(createdSession.id);
		expect(useUIStore.getState()).toMatchObject({
			activeRightTab: 'autorun',
			activeFocus: 'main',
		});

		await act(async () => {
			await vi.runAllTimersAsync();
		});

		expect(inputFocus).toHaveBeenCalledTimes(1);
		expect(useModalStore.getState().isOpen('tour')).toBe(true);
		expect(startBatchRun).toHaveBeenCalledWith(
			createdSession.id,
			expect.objectContaining({
				documents: [
					expect.objectContaining({
						filename: 'Phase-01-Setup',
						resetOnCompletion: false,
						isDuplicate: false,
					}),
				],
				loopEnabled: false,
			}),
			'/repo/wizard/.maestro/playbooks'
		);
	});

	it('routes wizard resume actions through the real modal store', async () => {
		const restoreState = vi.fn();
		const openWizard = vi.fn();
		const clearResumeState = vi.fn();
		const deps = createDeps({
			wizardContext: {
				state: createWizardState(),
				completeWizard: vi.fn(),
				clearResumeState,
				openWizard,
				restoreState,
			},
		});
		const { result } = renderHook(() => useWizardHandlers(deps));
		const savedState = createWizardState({
			currentStep: 'phase-review',
			directoryPath: '/missing/repo',
			selectedAgent: 'claude-code',
		});

		act(() => {
			getModalActions().setWizardResumeState(savedState);
			result.current.handleWizardResume({ directoryInvalid: true });
		});

		expect(restoreState).toHaveBeenCalledWith(
			expect.objectContaining({
				currentStep: 'directory-selection',
				directoryPath: '',
				isGitRepo: false,
				directoryError:
					'The previously selected directory no longer exists. Please choose a new location.',
			})
		);
		expect(openWizard).toHaveBeenCalledTimes(1);
		expect(useModalStore.getState().isOpen('wizardResume')).toBe(false);

		act(() => {
			getModalActions().setWizardResumeState(savedState);
			result.current.handleWizardResume({ agentInvalid: true });
		});

		expect(restoreState).toHaveBeenLastCalledWith(
			expect.objectContaining({
				currentStep: 'agent-selection',
				selectedAgent: null,
			})
		);

		await act(async () => {
			getModalActions().setWizardResumeState(savedState);
			await result.current.handleWizardStartFresh();
		});

		expect(clearResumeState).toHaveBeenCalledTimes(1);
		expect(openWizard).toHaveBeenCalledTimes(3);

		act(() => {
			getModalActions().setWizardResumeState(savedState);
			result.current.handleWizardResumeClose();
		});

		expect(useModalStore.getState().isOpen('wizardResume')).toBe(false);
	});
});

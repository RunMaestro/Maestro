/**
 * Tests for useWizardHandlers hook
 *
 * Tests:
 *   - Slash command discovery effect
 *   - Wizard state sync effect (context → tab state)
 *   - sendWizardMessageWithThinking (thinking chunk routing)
 *   - handleHistoryCommand (/history slash command)
 *   - handleSkillsCommand (/skills slash command)
 *   - handleWizardCommand (/wizard slash command)
 *   - handleLaunchWizardTab (launch wizard in new tab)
 *   - isWizardActiveForCurrentTab (derived value)
 *   - handleWizardComplete (converts wizard tab to normal session)
 *   - handleWizardLetsGo (generates documents)
 *   - handleToggleWizardShowThinking (toggle thinking display)
 *   - handleWizardLaunchSession (onboarding wizard → session creation)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';

// ============================================================================
// Mocks
// ============================================================================

vi.mock('../../../renderer/services/git', () => ({
	gitService: {
		isRepo: vi.fn().mockResolvedValue(false),
		getBranches: vi.fn().mockResolvedValue(['main']),
		getTags: vi.fn().mockResolvedValue([]),
	},
}));

vi.mock('../../../renderer/stores/notificationStore', async () => {
	const actual = await vi.importActual('../../../renderer/stores/notificationStore');
	return { ...actual, notifyToast: vi.fn() };
});

let idCounter = 0;
vi.mock('../../../renderer/utils/ids', () => ({
	generateId: vi.fn(() => `mock-id-${++idCounter}`),
}));

vi.mock('../../../renderer/utils/sessionValidation', () => ({
	validateNewSession: vi.fn(() => ({ valid: true, error: null })),
}));

vi.mock('../../../renderer/constants/app', () => ({
	getSlashCommandDescription: vi.fn((cmd: string) => `Description for ${cmd}`),
}));

vi.mock('../../../prompts', async () => {
	const actual = await vi.importActual('../../../prompts');
	return { ...actual, autorunSynopsisPrompt: 'Generate a synopsis of all work done.' };
});

vi.mock('../../../shared/synopsis', () => ({
	parseSynopsis: vi.fn((response: string) => ({
		shortSummary: 'Short summary',
		fullSynopsis: response,
		nothingToReport: false,
	})),
}));

vi.mock('../../../shared/formatters', () => ({
	formatRelativeTime: vi.fn(() => '5 minutes ago'),
}));

vi.mock('../../../renderer/components/Wizard', () => ({
	AUTO_RUN_FOLDER_NAME: 'Auto Run Docs',
}));

vi.mock('../../../renderer/components/BatchRunnerModal', () => ({
	DEFAULT_BATCH_PROMPT: 'Run each task sequentially.',
}));

import { useWizardHandlers } from '../../../renderer/hooks/wizard/useWizardHandlers';
import type { UseWizardHandlersDeps } from '../../../renderer/hooks/wizard/useWizardHandlers';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { useUIStore } from '../../../renderer/stores/uiStore';
import { useModalStore, getModalActions } from '../../../renderer/stores/modalStore';
import { notifyToast } from '../../../renderer/stores/notificationStore';
import { gitService } from '../../../renderer/services/git';
import { validateNewSession } from '../../../renderer/utils/sessionValidation';
import { parseSynopsis } from '../../../shared/synopsis';
import type { Session, AITab } from '../../../renderer/types';

// ============================================================================
// Test Helpers
// ============================================================================

const createMockTab = (overrides: Partial<AITab> = {}): AITab => ({
	id: 'tab-1',
	agentSessionId: 'agent-session-1',
	name: 'Tab 1',
	starred: false,
	logs: [],
	inputValue: '',
	stagedImages: [],
	createdAt: Date.now() - 60000,
	state: 'idle',
	saveToHistory: true,
	showThinking: 'off',
	...overrides,
});

const createMockSession = (overrides: Partial<Session> = {}): Session =>
	({
		id: 'session-1',
		name: 'Test Agent',
		toolType: 'claude-code',
		state: 'idle',
		cwd: '/projects/test',
		fullPath: '/projects/test',
		projectRoot: '/projects/test',
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
		shellCwd: '/projects/test',
		aiCommandHistory: [],
		shellCommandHistory: [],
		executionQueue: [],
		activeTimeMs: 0,
		aiTabs: [createMockTab()],
		activeTabId: 'tab-1',
		closedTabHistory: [],
		filePreviewTabs: [],
		activeFileTabId: null,
		unifiedTabOrder: [{ type: 'ai' as const, id: 'tab-1' }],
		unifiedClosedTabHistory: [],
		...overrides,
	}) as Session;

const createMockDeps = (overrides: Partial<UseWizardHandlersDeps> = {}): UseWizardHandlersDeps => ({
	inlineWizardContext: {
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
		state: {} as any,
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
	} as any,
	wizardContext: {
		state: {
			currentStep: 'agent' as any,
			isOpen: false,
			selectedAgent: 'claude-code',
			availableAgents: [],
			agentName: 'Test Agent',
			directoryPath: '/projects/test',
			isGitRepo: false,
			detectedAgentPath: null,
			directoryError: null,
			hasExistingAutoRunDocs: false,
			existingDocsCount: 0,
			existingDocsChoice: null,
			conversationHistory: [],
			confidenceLevel: 0,
			isReadyToProceed: false,
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
		} as any,
		completeWizard: vi.fn(),
		clearResumeState: vi.fn(),
	},
	spawnBackgroundSynopsis: vi.fn().mockResolvedValue({
		success: true,
		response: 'Synopsis response text',
		usageStats: { inputTokens: 100, outputTokens: 50 },
	}),
	addHistoryEntry: vi.fn(),
	startBatchRun: vi.fn(),
	handleAutoRunRefreshRef: { current: vi.fn() },
	setInputValueRef: { current: vi.fn() },
	inputRef: { current: null },
	...overrides,
});

/**
 * Helper: create an inline wizard tab state matching a tab's wizardState.
 * The sync effect reads from getStateForTab and writes to tab.wizardState.
 * Without this, the sync effect clears wizardState on mount.
 */
const createMatchingInlineWizardTabState = (wizardState: any) => ({
	isActive: wizardState?.isActive ?? true,
	isWaiting: wizardState?.isWaiting ?? false,
	mode: wizardState?.mode ?? 'new',
	goal: wizardState?.goal ?? null,
	confidence: wizardState?.confidence ?? 0,
	ready: wizardState?.ready ?? false,
	conversationHistory: (wizardState?.conversationHistory ?? []).map((msg: any) => ({
		id: msg.id,
		role: msg.role,
		content: msg.content,
		timestamp: msg.timestamp,
		confidence: msg.confidence,
		ready: msg.ready,
		images: msg.images,
	})),
	previousUIState: wizardState?.previousUIState ?? null,
	error: wizardState?.error ?? null,
	isGeneratingDocs: wizardState?.isGeneratingDocs ?? false,
	generatedDocuments: (wizardState?.generatedDocuments ?? []).map((doc: any) => ({
		filename: doc.filename,
		content: doc.content,
		taskCount: doc.taskCount,
		savedPath: doc.savedPath,
	})),
	streamingContent: wizardState?.streamingContent ?? '',
	currentDocumentIndex: wizardState?.currentDocumentIndex ?? 0,
	generationProgress: null,
	projectPath: null,
	subfolderPath: wizardState?.subfolderPath,
	agentSessionId: wizardState?.agentSessionId,
	subfolderName: wizardState?.subfolderName,
});

const setupMaestroMocks = () => {
	(window as any).maestro = {
		claude: {
			getCommands: vi.fn().mockResolvedValue([]),
			getSkills: vi.fn().mockResolvedValue([]),
		},
		agents: {
			discoverSlashCommands: vi.fn().mockResolvedValue([]),
			get: vi.fn().mockResolvedValue({ id: 'claude-code', name: 'Claude Code' }),
		},
		stats: {
			recordSessionCreated: vi.fn(),
		},
	};
};

// ============================================================================
// Test Suite
// ============================================================================

describe('useWizardHandlers', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		idCounter = 0;
		useSessionStore.setState({
			sessions: [],
			activeSessionId: null,
			groups: [],
		} as any);
		useSettingsStore.setState({
			defaultSaveToHistory: true,
			defaultShowThinking: 'off',
			conductorProfile: 'default',
		} as any);
		useUIStore.setState({
			activeRightTab: 'files',
			activeFocus: 'main',
		} as any);
		useModalStore.setState({
			modals: new Map(),
		} as any);
		setupMaestroMocks();
	});

	afterEach(() => {
		cleanup();
	});

	// ========================================================================
	// Slash command discovery effect
	// ========================================================================
	describe('slash command discovery effect', () => {
		it('fetches custom commands and agent commands for claude-code sessions', async () => {
			const session = createMockSession({ agentCommands: undefined });
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			(window as any).maestro.claude.getCommands.mockResolvedValue([
				{ command: '/custom-cmd', description: 'Custom command' },
			]);
			(window as any).maestro.agents.discoverSlashCommands.mockResolvedValue(['init', 'review']);

			const deps = createMockDeps();
			renderHook(() => useWizardHandlers(deps));

			// Wait for async effects
			await act(async () => {
				await new Promise((r) => setTimeout(r, 50));
			});

			expect((window as any).maestro.claude.getCommands).toHaveBeenCalledWith('/projects/test');
			expect((window as any).maestro.agents.discoverSlashCommands).toHaveBeenCalledWith(
				'claude-code',
				'/projects/test',
				undefined
			);

			const updatedSession = useSessionStore.getState().sessions[0];
			expect(updatedSession.agentCommands).toEqual(
				expect.arrayContaining([
					{ command: '/custom-cmd', description: 'Custom command' },
					expect.objectContaining({ command: '/init' }),
					expect.objectContaining({ command: '/review' }),
				])
			);
		});

		it('skips discovery if agentCommands already populated', async () => {
			const session = createMockSession({
				agentCommands: [{ command: '/existing', description: 'Existing' }],
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const deps = createMockDeps();
			renderHook(() => useWizardHandlers(deps));

			await act(async () => {
				await new Promise((r) => setTimeout(r, 50));
			});

			expect((window as any).maestro.claude.getCommands).not.toHaveBeenCalled();
		});

		it('skips discovery for non-claude-code sessions', async () => {
			const session = createMockSession({ toolType: 'codex' as any });
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const deps = createMockDeps();
			renderHook(() => useWizardHandlers(deps));

			await act(async () => {
				await new Promise((r) => setTimeout(r, 50));
			});

			expect((window as any).maestro.claude.getCommands).not.toHaveBeenCalled();
		});

		it('handles fetch errors gracefully', async () => {
			const session = createMockSession({ agentCommands: undefined });
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			(window as any).maestro.claude.getCommands.mockRejectedValue(new Error('Network error'));
			(window as any).maestro.agents.discoverSlashCommands.mockRejectedValue(
				new Error('Discovery failed')
			);

			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
			const deps = createMockDeps();
			renderHook(() => useWizardHandlers(deps));

			await act(async () => {
				await new Promise((r) => setTimeout(r, 50));
			});

			// Should not throw; errors are caught and logged
			expect(consoleSpy).toHaveBeenCalled();
			consoleSpy.mockRestore();
		});
	});

	// ========================================================================
	// Wizard state sync effect
	// ========================================================================
	describe('wizard state sync effect', () => {
		it('syncs inline wizard state to tab wizard state', async () => {
			const session = createMockSession();
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const mockTabState = {
				isActive: true,
				isWaiting: false,
				mode: 'new',
				goal: 'Build a feature',
				confidence: 75,
				ready: false,
				conversationHistory: [
					{
						id: 'msg-1',
						role: 'user',
						content: 'Hello',
						timestamp: 1000,
					},
				],
				previousUIState: {
					readOnlyMode: false,
					saveToHistory: true,
					showThinking: 'off' as const,
				},
				error: null,
				isGeneratingDocs: false,
				generatedDocuments: [],
				streamingContent: '',
				currentDocumentIndex: 0,
				generationProgress: null,
				projectPath: '/projects/test',
				subfolderPath: undefined,
				agentSessionId: undefined,
				subfolderName: undefined,
			};

			const deps = createMockDeps({
				inlineWizardContext: {
					...createMockDeps().inlineWizardContext,
					getStateForTab: vi.fn().mockReturnValue(mockTabState),
				} as any,
			});

			renderHook(() => useWizardHandlers(deps));

			await act(async () => {
				await new Promise((r) => setTimeout(r, 50));
			});

			const updatedSession = useSessionStore.getState().sessions[0];
			const activeTab = updatedSession.aiTabs.find((t) => t.id === 'tab-1');
			expect(activeTab?.wizardState).toBeDefined();
			expect(activeTab?.wizardState?.isActive).toBe(true);
			expect(activeTab?.wizardState?.confidence).toBe(75);
			expect(activeTab?.wizardState?.goal).toBe('Build a feature');
			expect(activeTab?.wizardState?.conversationHistory).toHaveLength(1);
		});

		it('clears wizard state when wizard is no longer active on tab', async () => {
			const tab = createMockTab({
				wizardState: {
					isActive: true,
					isWaiting: false,
					mode: 'new',
					confidence: 50,
					ready: false,
					conversationHistory: [],
					previousUIState: {
						readOnlyMode: false,
						saveToHistory: true,
						showThinking: 'off' as const,
					},
					error: null,
					isGeneratingDocs: false,
					generatedDocuments: [],
					streamingContent: '',
					currentDocumentIndex: 0,
					showWizardThinking: false,
					thinkingContent: '',
				},
			});
			const session = createMockSession({ aiTabs: [tab] });
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const deps = createMockDeps({
				inlineWizardContext: {
					...createMockDeps().inlineWizardContext,
					getStateForTab: vi.fn().mockReturnValue(undefined),
				} as any,
			});

			renderHook(() => useWizardHandlers(deps));

			await act(async () => {
				await new Promise((r) => setTimeout(r, 50));
			});

			const updatedSession = useSessionStore.getState().sessions[0];
			const activeTab = updatedSession.aiTabs.find((t) => t.id === 'tab-1');
			expect(activeTab?.wizardState).toBeUndefined();
		});

		it('maps "ask" mode to "new" WizardMode', async () => {
			const session = createMockSession();
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const mockTabState = {
				isActive: true,
				isWaiting: false,
				mode: 'ask',
				goal: null,
				confidence: 0,
				ready: false,
				conversationHistory: [],
				previousUIState: null,
				error: null,
				isGeneratingDocs: false,
				generatedDocuments: [],
				streamingContent: '',
				currentDocumentIndex: 0,
				generationProgress: null,
				projectPath: null,
			};

			const deps = createMockDeps({
				inlineWizardContext: {
					...createMockDeps().inlineWizardContext,
					getStateForTab: vi.fn().mockReturnValue(mockTabState),
				} as any,
			});

			renderHook(() => useWizardHandlers(deps));

			await act(async () => {
				await new Promise((r) => setTimeout(r, 50));
			});

			const updatedSession = useSessionStore.getState().sessions[0];
			const activeTab = updatedSession.aiTabs.find((t) => t.id === 'tab-1');
			expect(activeTab?.wizardState?.mode).toBe('new');
		});
	});

	// ========================================================================
	// sendWizardMessageWithThinking
	// ========================================================================
	describe('sendWizardMessageWithThinking', () => {
		it('calls sendInlineWizardMessage with content and images', async () => {
			const session = createMockSession();
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const sendMessage = vi.fn().mockResolvedValue(undefined);
			const deps = createMockDeps({
				inlineWizardContext: {
					...createMockDeps().inlineWizardContext,
					sendMessage,
				} as any,
			});

			const { result } = renderHook(() => useWizardHandlers(deps));

			await act(async () => {
				await result.current.sendWizardMessageWithThinking('Hello wizard', ['img1.png']);
			});

			expect(sendMessage).toHaveBeenCalledWith(
				'Hello wizard',
				['img1.png'],
				expect.objectContaining({
					onThinkingChunk: expect.any(Function),
					onToolExecution: expect.any(Function),
				})
			);
		});

		it('clears thinking content and tool executions before sending', async () => {
			const tab = createMockTab({
				wizardState: {
					isActive: true,
					isWaiting: false,
					mode: 'new',
					confidence: 50,
					ready: false,
					conversationHistory: [],
					previousUIState: {
						readOnlyMode: false,
						saveToHistory: true,
						showThinking: 'off' as const,
					},
					error: null,
					isGeneratingDocs: false,
					generatedDocuments: [],
					streamingContent: '',
					currentDocumentIndex: 0,
					showWizardThinking: true,
					thinkingContent: 'Old thinking...',
					toolExecutions: [{ toolName: 'old-tool', timestamp: 1 }],
				},
			});
			const session = createMockSession({ aiTabs: [tab] });
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			// Capture store state at the moment sendMessage is called to verify clearing happened before send
			let stateAtSendTime: any = null;
			const sendMessage = vi.fn().mockImplementation(() => {
				const tab = useSessionStore.getState().sessions[0]?.aiTabs[0];
				stateAtSendTime = {
					thinkingContent: tab?.wizardState?.thinkingContent,
					toolExecutions: tab?.wizardState?.toolExecutions,
				};
				return Promise.resolve(undefined);
			});

			// getStateForTab must return a valid wizard state so the sync effect
			// preserves (rather than strips) the tab's wizardState before send
			const mockInlineState = {
				isActive: true,
				isWaiting: false,
				mode: 'new',
				goal: null,
				confidence: 50,
				ready: false,
				conversationHistory: [],
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
				generationProgress: null,
				projectPath: null,
				subfolderPath: null,
				agentSessionId: null,
				subfolderName: null,
			};
			const deps = createMockDeps({
				inlineWizardContext: {
					...createMockDeps().inlineWizardContext,
					sendMessage,
					getStateForTab: vi.fn(() => mockInlineState),
					isWizardActiveForTab: vi.fn(() => true),
				} as any,
			});

			const { result } = renderHook(() => useWizardHandlers(deps));

			await act(async () => {
				await result.current.sendWizardMessageWithThinking('Test');
			});

			// Verify thinking content and tool executions were cleared before sendMessage was called
			expect(sendMessage).toHaveBeenCalled();
			expect(stateAtSendTime?.thinkingContent).toBe('');
			expect(stateAtSendTime?.toolExecutions).toEqual([]);
		});

		it('routes thinking chunks to tab wizard state when showWizardThinking is on', async () => {
			const wizState = {
				isActive: true,
				isWaiting: false,
				mode: 'new',
				confidence: 50,
				ready: false,
				conversationHistory: [],
				previousUIState: {
					readOnlyMode: false,
					saveToHistory: true,
					showThinking: 'off' as const,
				},
				error: null,
				isGeneratingDocs: false,
				generatedDocuments: [],
				streamingContent: '',
				currentDocumentIndex: 0,
				showWizardThinking: true,
				thinkingContent: '',
				toolExecutions: [],
			};
			const tab = createMockTab({ wizardState: wizState });
			const session = createMockSession({ aiTabs: [tab] });
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			let capturedCallbacks: any;
			const sendMessage = vi.fn().mockImplementation((_content, _images, callbacks) => {
				capturedCallbacks = callbacks;
				return Promise.resolve();
			});

			const deps = createMockDeps({
				inlineWizardContext: {
					...createMockDeps().inlineWizardContext,
					sendMessage,
					getStateForTab: vi.fn().mockReturnValue(createMatchingInlineWizardTabState(wizState)),
				} as any,
			});

			const { result } = renderHook(() => useWizardHandlers(deps));

			await act(async () => {
				await result.current.sendWizardMessageWithThinking('Test');
			});

			// Simulate a thinking chunk
			act(() => {
				capturedCallbacks.onThinkingChunk('Thinking about the problem...');
			});

			const updatedSession = useSessionStore.getState().sessions[0];
			const updatedTab = updatedSession.aiTabs.find((t) => t.id === 'tab-1');
			expect(updatedTab?.wizardState?.thinkingContent).toContain('Thinking about the problem...');
		});

		it('ignores JSON thinking chunks (confidence/message payloads)', async () => {
			const wizState = {
				isActive: true,
				isWaiting: false,
				mode: 'new',
				confidence: 50,
				ready: false,
				conversationHistory: [],
				previousUIState: {
					readOnlyMode: false,
					saveToHistory: true,
					showThinking: 'off' as const,
				},
				error: null,
				isGeneratingDocs: false,
				generatedDocuments: [],
				streamingContent: '',
				currentDocumentIndex: 0,
				showWizardThinking: true,
				thinkingContent: '',
				toolExecutions: [],
			};
			const tab = createMockTab({ wizardState: wizState });
			const session = createMockSession({ aiTabs: [tab] });
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			let capturedCallbacks: any;
			const sendMessage = vi.fn().mockImplementation((_content, _images, callbacks) => {
				capturedCallbacks = callbacks;
				return Promise.resolve();
			});

			const deps = createMockDeps({
				inlineWizardContext: {
					...createMockDeps().inlineWizardContext,
					sendMessage,
					getStateForTab: vi.fn().mockReturnValue(createMatchingInlineWizardTabState(wizState)),
				} as any,
			});

			const { result } = renderHook(() => useWizardHandlers(deps));

			await act(async () => {
				await result.current.sendWizardMessageWithThinking('Test');
			});

			// Simulate a JSON thinking chunk (should be filtered)
			act(() => {
				capturedCallbacks.onThinkingChunk('{"confidence": 80, "message": "Ready"}');
			});

			const updatedSession = useSessionStore.getState().sessions[0];
			const updatedTab = updatedSession.aiTabs.find((t) => t.id === 'tab-1');
			// Should not have added the JSON chunk
			expect(updatedTab?.wizardState?.thinkingContent).toBe('');
		});

		it('routes tool execution events to tab wizard state', async () => {
			const wizState = {
				isActive: true,
				isWaiting: false,
				mode: 'new',
				confidence: 50,
				ready: false,
				conversationHistory: [],
				previousUIState: {
					readOnlyMode: false,
					saveToHistory: true,
					showThinking: 'off' as const,
				},
				error: null,
				isGeneratingDocs: false,
				generatedDocuments: [],
				streamingContent: '',
				currentDocumentIndex: 0,
				showWizardThinking: true,
				thinkingContent: '',
				toolExecutions: [],
			};
			const tab = createMockTab({ wizardState: wizState });
			const session = createMockSession({ aiTabs: [tab] });
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			let capturedCallbacks: any;
			const sendMessage = vi.fn().mockImplementation((_content, _images, callbacks) => {
				capturedCallbacks = callbacks;
				return Promise.resolve();
			});

			const deps = createMockDeps({
				inlineWizardContext: {
					...createMockDeps().inlineWizardContext,
					sendMessage,
					getStateForTab: vi.fn().mockReturnValue(createMatchingInlineWizardTabState(wizState)),
				} as any,
			});

			const { result } = renderHook(() => useWizardHandlers(deps));

			await act(async () => {
				await result.current.sendWizardMessageWithThinking('Test');
			});

			const toolEvent = { toolName: 'Read', state: 'running', timestamp: Date.now() };
			act(() => {
				capturedCallbacks.onToolExecution(toolEvent);
			});

			const updatedSession = useSessionStore.getState().sessions[0];
			const updatedTab = updatedSession.aiTabs.find((t) => t.id === 'tab-1');
			expect(updatedTab?.wizardState?.toolExecutions).toContainEqual(toolEvent);
		});

		it('does not route chunks when showWizardThinking is off', async () => {
			const wizState = {
				isActive: true,
				isWaiting: false,
				mode: 'new',
				confidence: 50,
				ready: false,
				conversationHistory: [],
				previousUIState: {
					readOnlyMode: false,
					saveToHistory: true,
					showThinking: 'off' as const,
				},
				error: null,
				isGeneratingDocs: false,
				generatedDocuments: [],
				streamingContent: '',
				currentDocumentIndex: 0,
				showWizardThinking: false,
				thinkingContent: '',
				toolExecutions: [],
			};
			const tab = createMockTab({ wizardState: wizState });
			const session = createMockSession({ aiTabs: [tab] });
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			let capturedCallbacks: any;
			const sendMessage = vi.fn().mockImplementation((_content, _images, callbacks) => {
				capturedCallbacks = callbacks;
				return Promise.resolve();
			});

			const deps = createMockDeps({
				inlineWizardContext: {
					...createMockDeps().inlineWizardContext,
					sendMessage,
					getStateForTab: vi.fn().mockReturnValue(createMatchingInlineWizardTabState(wizState)),
				} as any,
			});

			const { result } = renderHook(() => useWizardHandlers(deps));

			await act(async () => {
				await result.current.sendWizardMessageWithThinking('Test');
			});

			act(() => {
				capturedCallbacks.onThinkingChunk('Some thinking text');
			});

			const updatedSession = useSessionStore.getState().sessions[0];
			const updatedTab = updatedSession.aiTabs.find((t) => t.id === 'tab-1');
			// Should remain empty since showWizardThinking is false
			expect(updatedTab?.wizardState?.thinkingContent).toBe('');
		});

		it('does nothing when no active session', async () => {
			useSessionStore.setState({ sessions: [], activeSessionId: null });

			const sendMessage = vi.fn().mockResolvedValue(undefined);
			const deps = createMockDeps({
				inlineWizardContext: {
					...createMockDeps().inlineWizardContext,
					sendMessage,
				} as any,
			});

			const { result } = renderHook(() => useWizardHandlers(deps));

			await act(async () => {
				await result.current.sendWizardMessageWithThinking('Test');
			});

			expect(sendMessage).not.toHaveBeenCalled();
		});
	});

	// ========================================================================
	// handleHistoryCommand
	// ========================================================================
	describe('handleHistoryCommand', () => {
		it('spawns synopsis, parses result, and saves history entry', async () => {
			const session = createMockSession();
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const deps = createMockDeps();
			const { result } = renderHook(() => useWizardHandlers(deps));

			await act(async () => {
				await result.current.handleHistoryCommand();
			});

			expect(deps.spawnBackgroundSynopsis).toHaveBeenCalledWith(
				'session-1',
				'/projects/test',
				'agent-session-1',
				expect.any(String),
				'claude-code',
				expect.objectContaining({})
			);

			expect(deps.addHistoryEntry).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'AUTO',
					summary: 'Short summary',
					sessionId: 'session-1',
				})
			);
		});

		it('shows error log when no agent session exists', async () => {
			const tab = createMockTab({ agentSessionId: null });
			const session = createMockSession({ aiTabs: [tab] });
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const deps = createMockDeps();
			const { result } = renderHook(() => useWizardHandlers(deps));

			await act(async () => {
				await result.current.handleHistoryCommand();
			});

			const updatedSession = useSessionStore.getState().sessions[0];
			const activeTab = updatedSession.aiTabs[0];
			expect(activeTab.logs.some((l) => l.text.includes('No active agent session'))).toBe(true);
			expect(deps.spawnBackgroundSynopsis).not.toHaveBeenCalled();
		});

		it('adds time-scoped prompt when lastSynopsisTime exists', async () => {
			const tab = createMockTab({ lastSynopsisTime: Date.now() - 300000 });
			const session = createMockSession({ aiTabs: [tab] });
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const deps = createMockDeps();
			const { result } = renderHook(() => useWizardHandlers(deps));

			await act(async () => {
				await result.current.handleHistoryCommand();
			});

			const calledPrompt = (deps.spawnBackgroundSynopsis as any).mock.calls[0][3];
			expect(calledPrompt).toContain('Only synopsize work done since the last synopsis');
		});

		it('updates log and skips history entry when nothing to report', async () => {
			const session = createMockSession();
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			(parseSynopsis as any).mockReturnValueOnce({
				shortSummary: '',
				fullSynopsis: '',
				nothingToReport: true,
			});

			const deps = createMockDeps();
			const { result } = renderHook(() => useWizardHandlers(deps));

			await act(async () => {
				await result.current.handleHistoryCommand();
			});

			expect(deps.addHistoryEntry).not.toHaveBeenCalled();
			const updatedSession = useSessionStore.getState().sessions[0];
			const activeTab = updatedSession.aiTabs[0];
			expect(activeTab.logs.some((l) => l.text.includes('Nothing to report'))).toBe(true);
		});

		it('shows toast notification on success', async () => {
			const session = createMockSession();
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const deps = createMockDeps();
			const { result } = renderHook(() => useWizardHandlers(deps));

			await act(async () => {
				await result.current.handleHistoryCommand();
			});

			expect(notifyToast).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'success',
					title: 'History Entry Added',
				})
			);
		});

		it('handles synopsis failure gracefully', async () => {
			const session = createMockSession();
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const deps = createMockDeps({
				spawnBackgroundSynopsis: vi.fn().mockResolvedValue({
					success: false,
					response: null,
				}),
			});
			const { result } = renderHook(() => useWizardHandlers(deps));

			await act(async () => {
				await result.current.handleHistoryCommand();
			});

			expect(deps.addHistoryEntry).not.toHaveBeenCalled();
			const updatedSession = useSessionStore.getState().sessions[0];
			const activeTab = updatedSession.aiTabs[0];
			expect(
				activeTab.logs.some((l) => l.text.includes('Failed to generate history synopsis'))
			).toBe(true);
		});

		it('handles synopsis error exception', async () => {
			const session = createMockSession();
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
			const deps = createMockDeps({
				spawnBackgroundSynopsis: vi.fn().mockRejectedValue(new Error('Spawn failed')),
			});
			const { result } = renderHook(() => useWizardHandlers(deps));

			await act(async () => {
				await result.current.handleHistoryCommand();
			});

			const updatedSession = useSessionStore.getState().sessions[0];
			const activeTab = updatedSession.aiTabs[0];
			expect(activeTab.logs.some((l) => l.text.includes('Error generating synopsis'))).toBe(true);
			consoleSpy.mockRestore();
		});

		it('does nothing when no active session', async () => {
			useSessionStore.setState({ sessions: [], activeSessionId: null });

			const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
			const deps = createMockDeps();
			const { result } = renderHook(() => useWizardHandlers(deps));

			await act(async () => {
				await result.current.handleHistoryCommand();
			});

			expect(deps.spawnBackgroundSynopsis).not.toHaveBeenCalled();
			consoleSpy.mockRestore();
		});

		it('updates lastSynopsisTime on success', async () => {
			const session = createMockSession();
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const deps = createMockDeps();
			const { result } = renderHook(() => useWizardHandlers(deps));

			await act(async () => {
				await result.current.handleHistoryCommand();
			});

			const updatedSession = useSessionStore.getState().sessions[0];
			const activeTab = updatedSession.aiTabs[0];
			expect(activeTab.lastSynopsisTime).toBeDefined();
			expect(activeTab.lastSynopsisTime).toBeGreaterThan(0);
		});
	});

	// ========================================================================
	// handleSkillsCommand
	// ========================================================================
	describe('handleSkillsCommand', () => {
		it('fetches and displays skills in a table format', async () => {
			const session = createMockSession();
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			(window as any).maestro.claude.getSkills.mockResolvedValue([
				{
					name: 'code-review',
					source: 'project',
					tokenCount: 2500,
					description: 'Automated code review',
				},
				{
					name: 'test-gen',
					source: 'user',
					tokenCount: 800,
					description: 'Generate test files',
				},
			]);

			const deps = createMockDeps();
			const { result } = renderHook(() => useWizardHandlers(deps));

			await act(async () => {
				await result.current.handleSkillsCommand();
			});

			const updatedSession = useSessionStore.getState().sessions[0];
			const activeTab = updatedSession.aiTabs[0];
			const skillsLog = activeTab.logs.find((l) => l.text.includes('## Skills'));
			expect(skillsLog).toBeDefined();
			expect(skillsLog!.text).toContain('2 skills available');
			expect(skillsLog!.text).toContain('code-review');
			expect(skillsLog!.text).toContain('test-gen');
			expect(skillsLog!.text).toContain('Project Skills');
			expect(skillsLog!.text).toContain('User Skills');
		});

		it('displays "no skills found" message when empty', async () => {
			const session = createMockSession();
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			(window as any).maestro.claude.getSkills.mockResolvedValue([]);

			const deps = createMockDeps();
			const { result } = renderHook(() => useWizardHandlers(deps));

			await act(async () => {
				await result.current.handleSkillsCommand();
			});

			const updatedSession = useSessionStore.getState().sessions[0];
			const activeTab = updatedSession.aiTabs[0];
			const skillsLog = activeTab.logs.find((l) => l.text.includes('No Claude Code skills'));
			expect(skillsLog).toBeDefined();
		});

		it('skips for non-claude-code sessions', async () => {
			const session = createMockSession({ toolType: 'codex' as any });
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
			const deps = createMockDeps();
			const { result } = renderHook(() => useWizardHandlers(deps));

			await act(async () => {
				await result.current.handleSkillsCommand();
			});

			expect((window as any).maestro.claude.getSkills).not.toHaveBeenCalled();
			consoleSpy.mockRestore();
		});

		it('adds a user log entry for the /skills command', async () => {
			const session = createMockSession();
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const deps = createMockDeps();
			const { result } = renderHook(() => useWizardHandlers(deps));

			await act(async () => {
				await result.current.handleSkillsCommand();
			});

			const updatedSession = useSessionStore.getState().sessions[0];
			const activeTab = updatedSession.aiTabs[0];
			const userLog = activeTab.logs.find((l) => l.source === 'user' && l.text === '/skills');
			expect(userLog).toBeDefined();
		});

		it('handles skill fetch errors gracefully', async () => {
			const session = createMockSession();
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			(window as any).maestro.claude.getSkills.mockRejectedValue(new Error('Skill fetch failed'));

			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
			const deps = createMockDeps();
			const { result } = renderHook(() => useWizardHandlers(deps));

			await act(async () => {
				await result.current.handleSkillsCommand();
			});

			const updatedSession = useSessionStore.getState().sessions[0];
			const activeTab = updatedSession.aiTabs[0];
			const errorLog = activeTab.logs.find((l) => l.text.includes('Error listing skills'));
			expect(errorLog).toBeDefined();
			consoleSpy.mockRestore();
		});

		it('formats token counts with k suffix for large values', async () => {
			const session = createMockSession();
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			(window as any).maestro.claude.getSkills.mockResolvedValue([
				{
					name: 'big-skill',
					source: 'project',
					tokenCount: 5000,
					description: 'Large skill',
				},
				{
					name: 'small-skill',
					source: 'project',
					tokenCount: 500,
					description: 'Small skill',
				},
			]);

			const deps = createMockDeps();
			const { result } = renderHook(() => useWizardHandlers(deps));

			await act(async () => {
				await result.current.handleSkillsCommand();
			});

			const updatedSession = useSessionStore.getState().sessions[0];
			const activeTab = updatedSession.aiTabs[0];
			const skillsLog = activeTab.logs.find((l) => l.text.includes('## Skills'));
			expect(skillsLog!.text).toContain('~5.0k');
			expect(skillsLog!.text).toContain('~500');
		});
	});

	// ========================================================================
	// handleWizardCommand
	// ========================================================================
	describe('handleWizardCommand', () => {
		it('starts inline wizard with args on current tab', () => {
			const session = createMockSession();
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const deps = createMockDeps();
			const { result } = renderHook(() => useWizardHandlers(deps));

			act(() => {
				result.current.handleWizardCommand('build a REST API');
			});

			expect(deps.inlineWizardContext.startWizard).toHaveBeenCalledWith(
				'build a REST API',
				expect.objectContaining({ readOnlyMode: false }),
				'/projects/test',
				'claude-code',
				'Test Agent',
				'tab-1',
				'session-1',
				undefined, // autoRunFolderPath
				undefined, // sessionSshRemoteConfig
				expect.any(String), // conductorProfile
				expect.objectContaining({}) // custom config
			);
		});

		it('renames tab to "Wizard"', () => {
			const session = createMockSession();
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const deps = createMockDeps();
			const { result } = renderHook(() => useWizardHandlers(deps));

			act(() => {
				result.current.handleWizardCommand('');
			});

			const updatedSession = useSessionStore.getState().sessions[0];
			const activeTab = updatedSession.aiTabs.find((t) => t.id === 'tab-1');
			expect(activeTab?.name).toBe('Wizard');
		});

		it('adds a wizard log entry', () => {
			const session = createMockSession();
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const deps = createMockDeps();
			const { result } = renderHook(() => useWizardHandlers(deps));

			act(() => {
				result.current.handleWizardCommand('test args');
			});

			const updatedSession = useSessionStore.getState().sessions[0];
			const activeTab = updatedSession.aiTabs.find((t) => t.id === 'tab-1');
			const wizardLog = activeTab?.logs.find((l) =>
				l.text.includes('Starting wizard with: "test args"')
			);
			expect(wizardLog).toBeDefined();
		});

		it('shows generic log when no args provided', () => {
			const session = createMockSession();
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const deps = createMockDeps();
			const { result } = renderHook(() => useWizardHandlers(deps));

			act(() => {
				result.current.handleWizardCommand('');
			});

			const updatedSession = useSessionStore.getState().sessions[0];
			const activeTab = updatedSession.aiTabs.find((t) => t.id === 'tab-1');
			const wizardLog = activeTab?.logs.find((l) =>
				l.text.includes('Starting wizard for Auto Run documents...')
			);
			expect(wizardLog).toBeDefined();
		});

		it('does nothing when no active session', () => {
			useSessionStore.setState({ sessions: [], activeSessionId: null });

			const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
			const deps = createMockDeps();
			const { result } = renderHook(() => useWizardHandlers(deps));

			act(() => {
				result.current.handleWizardCommand('test');
			});

			expect(deps.inlineWizardContext.startWizard).not.toHaveBeenCalled();
			consoleSpy.mockRestore();
		});
	});

	// ========================================================================
	// handleLaunchWizardTab
	// ========================================================================
	describe('handleLaunchWizardTab', () => {
		it('creates a new tab and starts wizard on it', async () => {
			const session = createMockSession();
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const deps = createMockDeps();
			const { result } = renderHook(() => useWizardHandlers(deps));

			act(() => {
				result.current.handleLaunchWizardTab();
			});

			const updatedSession = useSessionStore.getState().sessions[0];
			// Should have created a new tab (original + new)
			expect(updatedSession.aiTabs.length).toBeGreaterThanOrEqual(2);

			// Wait for setTimeout wizard launch
			await act(async () => {
				await new Promise((r) => setTimeout(r, 50));
			});

			expect(deps.inlineWizardContext.startWizard).toHaveBeenCalled();
		});

		it('sets active tab to the new wizard tab', () => {
			const session = createMockSession();
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const deps = createMockDeps();
			const { result } = renderHook(() => useWizardHandlers(deps));

			act(() => {
				result.current.handleLaunchWizardTab();
			});

			const updatedSession = useSessionStore.getState().sessions[0];
			// Active tab should no longer be the original tab-1
			expect(updatedSession.activeTabId).not.toBe('tab-1');
		});

		it('does nothing when no active session', () => {
			useSessionStore.setState({ sessions: [], activeSessionId: null });

			const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
			const deps = createMockDeps();
			const { result } = renderHook(() => useWizardHandlers(deps));

			act(() => {
				result.current.handleLaunchWizardTab();
			});

			expect(deps.inlineWizardContext.startWizard).not.toHaveBeenCalled();
			consoleSpy.mockRestore();
		});
	});

	// ========================================================================
	// isWizardActiveForCurrentTab
	// ========================================================================
	describe('isWizardActiveForCurrentTab', () => {
		it('returns true when wizard is active on current tab', () => {
			const session = createMockSession();
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const deps = createMockDeps({
				inlineWizardContext: {
					...createMockDeps().inlineWizardContext,
					isWizardActive: true,
					wizardTabId: 'tab-1',
				} as any,
			});

			const { result } = renderHook(() => useWizardHandlers(deps));

			expect(result.current.isWizardActiveForCurrentTab).toBe(true);
		});

		it('returns false when wizard is active on a different tab', () => {
			const session = createMockSession();
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const deps = createMockDeps({
				inlineWizardContext: {
					...createMockDeps().inlineWizardContext,
					isWizardActive: true,
					wizardTabId: 'other-tab',
				} as any,
			});

			const { result } = renderHook(() => useWizardHandlers(deps));

			expect(result.current.isWizardActiveForCurrentTab).toBe(false);
		});

		it('returns false when wizard is not active', () => {
			const session = createMockSession();
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const deps = createMockDeps();
			const { result } = renderHook(() => useWizardHandlers(deps));

			expect(result.current.isWizardActiveForCurrentTab).toBe(false);
		});

		it('returns false when no active session', () => {
			useSessionStore.setState({ sessions: [], activeSessionId: null });

			const deps = createMockDeps({
				inlineWizardContext: {
					...createMockDeps().inlineWizardContext,
					isWizardActive: true,
					wizardTabId: 'tab-1',
				} as any,
			});

			const { result } = renderHook(() => useWizardHandlers(deps));

			expect(result.current.isWizardActiveForCurrentTab).toBe(false);
		});
	});

	// ========================================================================
	// handleWizardComplete
	// ========================================================================
	describe('handleWizardComplete', () => {
		it('converts wizard tab to normal session with conversation logs', () => {
			const wizState = {
				isActive: true,
				isWaiting: false,
				mode: 'new',
				confidence: 90,
				ready: true,
				conversationHistory: [
					{
						id: 'msg-1',
						role: 'user' as const,
						content: 'Build a REST API',
						timestamp: 1000,
					},
					{
						id: 'msg-2',
						role: 'assistant' as const,
						content: 'I will create...',
						timestamp: 2000,
					},
				],
				previousUIState: {
					readOnlyMode: false,
					saveToHistory: true,
					showThinking: 'off' as const,
				},
				error: null,
				isGeneratingDocs: false,
				generatedDocuments: [
					{
						filename: 'phase-1.md',
						content: '# Phase 1\n- Task A\n- Task B',
						taskCount: 2,
					},
				],
				streamingContent: '',
				currentDocumentIndex: 0,
				showWizardThinking: false,
				thinkingContent: '',
				subfolderName: 'api-project',
			};
			const tab = createMockTab({ wizardState: wizState });
			const session = createMockSession({ aiTabs: [tab] });
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const deps = createMockDeps({
				inlineWizardContext: {
					...createMockDeps().inlineWizardContext,
					getStateForTab: vi.fn().mockReturnValue(createMatchingInlineWizardTabState(wizState)),
				} as any,
			});
			const { result } = renderHook(() => useWizardHandlers(deps));

			act(() => {
				result.current.handleWizardComplete();
			});

			const updatedSession = useSessionStore.getState().sessions[0];
			const activeTab = updatedSession.aiTabs[0];

			// Wizard state should be cleared
			expect(activeTab.wizardState).toBeUndefined();

			// Tab should be renamed to subfolder name
			expect(activeTab.name).toBe('api-project');

			// Should have wizard conversation logs + summary
			expect(activeTab.logs.length).toBeGreaterThanOrEqual(3); // 2 messages + summary
			const summaryLog = activeTab.logs.find((l) => l.text.includes('Wizard Complete'));
			expect(summaryLog).toBeDefined();
			expect(summaryLog!.text).toContain('1 document');
			expect(summaryLog!.text).toContain('2 tasks');

			// endInlineWizard should be called
			expect(deps.inlineWizardContext.endWizard).toHaveBeenCalled();

			// Should refresh auto run and clear input
			expect(deps.handleAutoRunRefreshRef.current).toHaveBeenCalled();
			expect(deps.setInputValueRef.current).toHaveBeenCalledWith('');
		});

		it('preserves agentSessionId from wizard state', () => {
			const wizState = {
				isActive: true,
				isWaiting: false,
				mode: 'new',
				confidence: 90,
				ready: true,
				conversationHistory: [],
				previousUIState: {
					readOnlyMode: false,
					saveToHistory: true,
					showThinking: 'off' as const,
				},
				error: null,
				isGeneratingDocs: false,
				generatedDocuments: [],
				streamingContent: '',
				currentDocumentIndex: 0,
				showWizardThinking: false,
				thinkingContent: '',
				agentSessionId: 'wizard-agent-session-123',
			};
			const tab = createMockTab({ wizardState: wizState });
			const session = createMockSession({ aiTabs: [tab] });
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const deps = createMockDeps({
				inlineWizardContext: {
					...createMockDeps().inlineWizardContext,
					getStateForTab: vi.fn().mockReturnValue(createMatchingInlineWizardTabState(wizState)),
				} as any,
			});
			const { result } = renderHook(() => useWizardHandlers(deps));

			act(() => {
				result.current.handleWizardComplete();
			});

			const updatedSession = useSessionStore.getState().sessions[0];
			const activeTab = updatedSession.aiTabs[0];
			expect(activeTab.agentSessionId).toBe('wizard-agent-session-123');
		});

		it('does nothing when no wizard state on active tab', () => {
			const session = createMockSession();
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const deps = createMockDeps();
			const { result } = renderHook(() => useWizardHandlers(deps));

			act(() => {
				result.current.handleWizardComplete();
			});

			expect(deps.inlineWizardContext.endWizard).not.toHaveBeenCalled();
		});
	});

	// ========================================================================
	// handleWizardLetsGo
	// ========================================================================
	describe('handleWizardLetsGo', () => {
		it('calls generateInlineWizardDocuments with active tab id', () => {
			const session = createMockSession();
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const deps = createMockDeps();
			const { result } = renderHook(() => useWizardHandlers(deps));

			act(() => {
				result.current.handleWizardLetsGo();
			});

			expect(deps.inlineWizardContext.generateDocuments).toHaveBeenCalledWith(undefined, 'tab-1');
		});

		it('does nothing when no active session', () => {
			useSessionStore.setState({ sessions: [], activeSessionId: null });

			const deps = createMockDeps();
			const { result } = renderHook(() => useWizardHandlers(deps));

			act(() => {
				result.current.handleWizardLetsGo();
			});

			expect(deps.inlineWizardContext.generateDocuments).not.toHaveBeenCalled();
		});
	});

	// ========================================================================
	// handleToggleWizardShowThinking
	// ========================================================================
	describe('handleToggleWizardShowThinking', () => {
		it('toggles showWizardThinking from false to true and clears thinking content', () => {
			const wizState = {
				isActive: true,
				isWaiting: false,
				mode: 'new',
				confidence: 50,
				ready: false,
				conversationHistory: [],
				previousUIState: {
					readOnlyMode: false,
					saveToHistory: true,
					showThinking: 'off' as const,
				},
				error: null,
				isGeneratingDocs: false,
				generatedDocuments: [],
				streamingContent: '',
				currentDocumentIndex: 0,
				showWizardThinking: false,
				thinkingContent: 'old content',
			};
			const tab = createMockTab({ wizardState: wizState });
			const session = createMockSession({ aiTabs: [tab] });
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const deps = createMockDeps({
				inlineWizardContext: {
					...createMockDeps().inlineWizardContext,
					getStateForTab: vi.fn().mockReturnValue(createMatchingInlineWizardTabState(wizState)),
				} as any,
			});
			const { result } = renderHook(() => useWizardHandlers(deps));

			act(() => {
				result.current.handleToggleWizardShowThinking();
			});

			const updatedSession = useSessionStore.getState().sessions[0];
			const activeTab = updatedSession.aiTabs[0];
			expect(activeTab.wizardState?.showWizardThinking).toBe(true);
			// When toggling ON, thinking content should be cleared (fresh start)
			expect(activeTab.wizardState?.thinkingContent).toBe('');
		});

		it('toggles showWizardThinking from true to false and preserves content', () => {
			const wizState = {
				isActive: true,
				isWaiting: false,
				mode: 'new',
				confidence: 50,
				ready: false,
				conversationHistory: [],
				previousUIState: {
					readOnlyMode: false,
					saveToHistory: true,
					showThinking: 'off' as const,
				},
				error: null,
				isGeneratingDocs: false,
				generatedDocuments: [],
				streamingContent: '',
				currentDocumentIndex: 0,
				showWizardThinking: true,
				thinkingContent: 'existing thinking',
			};
			const tab = createMockTab({ wizardState: wizState });
			const session = createMockSession({ aiTabs: [tab] });
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const deps = createMockDeps({
				inlineWizardContext: {
					...createMockDeps().inlineWizardContext,
					getStateForTab: vi.fn().mockReturnValue(createMatchingInlineWizardTabState(wizState)),
				} as any,
			});
			const { result } = renderHook(() => useWizardHandlers(deps));

			act(() => {
				result.current.handleToggleWizardShowThinking();
			});

			const updatedSession = useSessionStore.getState().sessions[0];
			const activeTab = updatedSession.aiTabs[0];
			expect(activeTab.wizardState?.showWizardThinking).toBe(false);
			// When toggling OFF, content is preserved
			expect(activeTab.wizardState?.thinkingContent).toBe('existing thinking');
		});

		it('does nothing when no wizard state on active tab', () => {
			const session = createMockSession();
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const deps = createMockDeps();
			const { result } = renderHook(() => useWizardHandlers(deps));

			// Should not throw
			act(() => {
				result.current.handleToggleWizardShowThinking();
			});

			const updatedSession = useSessionStore.getState().sessions[0];
			const activeTab = updatedSession.aiTabs[0];
			expect(activeTab.wizardState).toBeUndefined();
		});
	});

	// ========================================================================
	// handleWizardLaunchSession
	// ========================================================================
	describe('handleWizardLaunchSession', () => {
		it('creates a new session from onboarding wizard data', async () => {
			useSessionStore.setState({ sessions: [], activeSessionId: null });

			const deps = createMockDeps({
				wizardContext: {
					state: {
						currentStep: 'review' as any,
						isOpen: true,
						selectedAgent: 'claude-code',
						availableAgents: [],
						agentName: 'My Project',
						directoryPath: '/projects/my-app',
						isGitRepo: false,
						detectedAgentPath: null,
						directoryError: null,
						hasExistingAutoRunDocs: false,
						existingDocsCount: 0,
						existingDocsChoice: null,
						conversationHistory: [],
						confidenceLevel: 90,
						isReadyToProceed: true,
						isConversationLoading: false,
						conversationError: null,
						generatedDocuments: [{ filename: 'phase-1.md', content: '# Phase 1', taskCount: 3 }],
						currentDocumentIndex: 0,
						isGeneratingDocuments: false,
						generationError: null,
						editedPhase1Content: null,
						wantsTour: false,
						isComplete: false,
						createdSessionId: null,
					} as any,
					completeWizard: vi.fn(),
					clearResumeState: vi.fn(),
				},
			});

			const { result } = renderHook(() => useWizardHandlers(deps));

			await act(async () => {
				await result.current.handleWizardLaunchSession(false);
			});

			const sessions = useSessionStore.getState().sessions;
			expect(sessions).toHaveLength(1);

			const newSession = sessions[0];
			expect(newSession.name).toBe('My Project');
			expect(newSession.toolType).toBe('claude-code');
			expect(newSession.cwd).toBe('/projects/my-app');
			expect(newSession.autoRunFolderPath).toBe('/projects/my-app/Auto Run Docs');
			expect(newSession.autoRunSelectedFile).toBe('phase-1');

			// Should have been set as active
			expect(useSessionStore.getState().activeSessionId).toBe(newSession.id);

			// Wizard should be completed
			expect(deps.wizardContext.completeWizard).toHaveBeenCalledWith(newSession.id);
			expect(deps.wizardContext.clearResumeState).toHaveBeenCalled();

			// Stats should be recorded
			expect((window as any).maestro.stats.recordSessionCreated).toHaveBeenCalledWith(
				expect.objectContaining({
					agentType: 'claude-code',
					projectPath: '/projects/my-app',
				})
			);
		});

		it('auto-starts batch run with first document that has tasks', async () => {
			useSessionStore.setState({ sessions: [], activeSessionId: null });

			const deps = createMockDeps({
				wizardContext: {
					state: {
						currentStep: 'review' as any,
						isOpen: true,
						selectedAgent: 'claude-code',
						availableAgents: [],
						agentName: 'Test',
						directoryPath: '/projects/test',
						isGitRepo: false,
						detectedAgentPath: null,
						directoryError: null,
						hasExistingAutoRunDocs: false,
						existingDocsCount: 0,
						existingDocsChoice: null,
						conversationHistory: [],
						confidenceLevel: 90,
						isReadyToProceed: true,
						isConversationLoading: false,
						conversationError: null,
						generatedDocuments: [{ filename: 'phase-1.md', content: '# Phase 1', taskCount: 2 }],
						currentDocumentIndex: 0,
						isGeneratingDocuments: false,
						generationError: null,
						editedPhase1Content: null,
						wantsTour: false,
						isComplete: false,
						createdSessionId: null,
					} as any,
					completeWizard: vi.fn(),
					clearResumeState: vi.fn(),
				},
			});

			const { result } = renderHook(() => useWizardHandlers(deps));

			await act(async () => {
				await result.current.handleWizardLaunchSession(false);
			});

			// Wait for the setTimeout batch run
			await act(async () => {
				await new Promise((r) => setTimeout(r, 600));
			});

			expect(deps.startBatchRun).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({
					documents: expect.arrayContaining([expect.objectContaining({ filename: 'phase-1' })]),
				}),
				expect.stringContaining('Auto Run Docs')
			);
		});

		it('starts tour when wantsTour is true', async () => {
			useSessionStore.setState({ sessions: [], activeSessionId: null });

			const deps = createMockDeps({
				wizardContext: {
					state: {
						currentStep: 'review' as any,
						isOpen: true,
						selectedAgent: 'claude-code',
						availableAgents: [],
						agentName: 'Test',
						directoryPath: '/projects/test',
						isGitRepo: false,
						detectedAgentPath: null,
						directoryError: null,
						hasExistingAutoRunDocs: false,
						existingDocsCount: 0,
						existingDocsChoice: null,
						conversationHistory: [],
						confidenceLevel: 90,
						isReadyToProceed: true,
						isConversationLoading: false,
						conversationError: null,
						generatedDocuments: [],
						currentDocumentIndex: 0,
						isGeneratingDocuments: false,
						generationError: null,
						editedPhase1Content: null,
						wantsTour: true,
						isComplete: false,
						createdSessionId: null,
					} as any,
					completeWizard: vi.fn(),
					clearResumeState: vi.fn(),
				},
			});

			const { result } = renderHook(() => useWizardHandlers(deps));

			await act(async () => {
				await result.current.handleWizardLaunchSession(true);
			});

			// Wait for the setTimeout tour launch
			await act(async () => {
				await new Promise((r) => setTimeout(r, 400));
			});

			// Tour should be opened (stored in modals Map)
			const tourModal = useModalStore.getState().modals.get('tour');
			expect(tourModal?.open).toBe(true);
		});

		it('throws when missing agent or directory', async () => {
			useSessionStore.setState({ sessions: [], activeSessionId: null });

			const deps = createMockDeps({
				wizardContext: {
					state: {
						selectedAgent: null,
						directoryPath: '',
						agentName: '',
						generatedDocuments: [],
					} as any,
					completeWizard: vi.fn(),
					clearResumeState: vi.fn(),
				},
			});

			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
			const { result } = renderHook(() => useWizardHandlers(deps));

			await expect(
				act(async () => {
					await result.current.handleWizardLaunchSession(false);
				})
			).rejects.toThrow('Missing required wizard data');
			consoleSpy.mockRestore();
		});

		it('throws when session validation fails', async () => {
			useSessionStore.setState({ sessions: [], activeSessionId: null });

			(validateNewSession as any).mockReturnValueOnce({
				valid: false,
				error: 'Duplicate session',
			});

			const deps = createMockDeps({
				wizardContext: {
					state: {
						currentStep: 'review' as any,
						isOpen: true,
						selectedAgent: 'claude-code',
						availableAgents: [],
						agentName: 'Test',
						directoryPath: '/projects/test',
						isGitRepo: false,
						detectedAgentPath: null,
						directoryError: null,
						hasExistingAutoRunDocs: false,
						existingDocsCount: 0,
						existingDocsChoice: null,
						conversationHistory: [],
						confidenceLevel: 90,
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
					} as any,
					completeWizard: vi.fn(),
					clearResumeState: vi.fn(),
				},
			});

			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
			const { result } = renderHook(() => useWizardHandlers(deps));

			await expect(
				act(async () => {
					await result.current.handleWizardLaunchSession(false);
				})
			).rejects.toThrow('Duplicate session');

			expect(notifyToast).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'error',
					title: 'Agent Creation Failed',
				})
			);
			consoleSpy.mockRestore();
		});

		it('throws when agent is not found', async () => {
			useSessionStore.setState({ sessions: [], activeSessionId: null });

			(window as any).maestro.agents.get.mockResolvedValue(null);

			const deps = createMockDeps({
				wizardContext: {
					state: {
						currentStep: 'review' as any,
						isOpen: true,
						selectedAgent: 'nonexistent',
						availableAgents: [],
						agentName: 'Test',
						directoryPath: '/projects/test',
						isGitRepo: false,
						detectedAgentPath: null,
						directoryError: null,
						hasExistingAutoRunDocs: false,
						existingDocsCount: 0,
						existingDocsChoice: null,
						conversationHistory: [],
						confidenceLevel: 90,
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
					} as any,
					completeWizard: vi.fn(),
					clearResumeState: vi.fn(),
				},
			});

			const { result } = renderHook(() => useWizardHandlers(deps));

			await expect(
				act(async () => {
					await result.current.handleWizardLaunchSession(false);
				})
			).rejects.toThrow('Agent not found: nonexistent');
		});

		it('fetches git info for git repos', async () => {
			useSessionStore.setState({ sessions: [], activeSessionId: null });

			(gitService.isRepo as any).mockResolvedValue(true);
			(gitService.getBranches as any).mockResolvedValue(['main', 'dev']);
			(gitService.getTags as any).mockResolvedValue(['v1.0', 'v2.0']);

			const deps = createMockDeps({
				wizardContext: {
					state: {
						currentStep: 'review' as any,
						isOpen: true,
						selectedAgent: 'claude-code',
						availableAgents: [],
						agentName: 'Git Project',
						directoryPath: '/projects/git-app',
						isGitRepo: true,
						detectedAgentPath: null,
						directoryError: null,
						hasExistingAutoRunDocs: false,
						existingDocsCount: 0,
						existingDocsChoice: null,
						conversationHistory: [],
						confidenceLevel: 90,
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
					} as any,
					completeWizard: vi.fn(),
					clearResumeState: vi.fn(),
				},
			});

			const { result } = renderHook(() => useWizardHandlers(deps));

			await act(async () => {
				await result.current.handleWizardLaunchSession(false);
			});

			const sessions = useSessionStore.getState().sessions;
			expect(sessions[0].isGitRepo).toBe(true);
			expect(sessions[0].gitBranches).toEqual(['main', 'dev']);
			expect(sessions[0].gitTags).toEqual(['v1.0', 'v2.0']);
		});

		it('sets right tab to autorun', async () => {
			useSessionStore.setState({ sessions: [], activeSessionId: null });

			const deps = createMockDeps({
				wizardContext: {
					state: {
						currentStep: 'review' as any,
						isOpen: true,
						selectedAgent: 'claude-code',
						availableAgents: [],
						agentName: 'Test',
						directoryPath: '/projects/test',
						isGitRepo: false,
						detectedAgentPath: null,
						directoryError: null,
						hasExistingAutoRunDocs: false,
						existingDocsCount: 0,
						existingDocsChoice: null,
						conversationHistory: [],
						confidenceLevel: 90,
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
					} as any,
					completeWizard: vi.fn(),
					clearResumeState: vi.fn(),
				},
			});

			const { result } = renderHook(() => useWizardHandlers(deps));

			await act(async () => {
				await result.current.handleWizardLaunchSession(false);
			});

			expect(useUIStore.getState().activeRightTab).toBe('autorun');
		});

		it('passes custom path, args, envVars and SSH config to new session', async () => {
			useSessionStore.setState({ sessions: [], activeSessionId: null });

			const sshConfig = {
				enabled: true,
				remoteId: 'ssh-remote-1',
				workingDirOverride: '/remote/path',
			};

			const deps = createMockDeps({
				wizardContext: {
					state: {
						currentStep: 'review' as any,
						isOpen: true,
						selectedAgent: 'claude-code',
						availableAgents: [],
						agentName: 'Remote Test',
						directoryPath: '/projects/remote',
						isGitRepo: false,
						detectedAgentPath: null,
						directoryError: null,
						hasExistingAutoRunDocs: false,
						existingDocsCount: 0,
						existingDocsChoice: null,
						conversationHistory: [],
						confidenceLevel: 90,
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
						customPath: '/custom/claude',
						customArgs: '--verbose',
						customEnvVars: { API_KEY: '123' },
						sessionSshRemoteConfig: sshConfig,
					} as any,
					completeWizard: vi.fn(),
					clearResumeState: vi.fn(),
				},
			});

			const { result } = renderHook(() => useWizardHandlers(deps));

			await act(async () => {
				await result.current.handleWizardLaunchSession(false);
			});

			const sessions = useSessionStore.getState().sessions;
			expect(sessions[0].customPath).toBe('/custom/claude');
			expect(sessions[0].customArgs).toBe('--verbose');
			expect(sessions[0].customEnvVars).toEqual({ API_KEY: '123' });
			expect(sessions[0].sessionSshRemoteConfig).toEqual(sshConfig);
		});
	});
});

/**
 * Integration edge tests for useWizardHandlers hook
 *
 * Tests:
 *   - Slash command discovery effect
 *   - Wizard state sync effect (context -> tab state)
 *   - sendWizardMessageWithThinking (thinking chunk routing)
 *   - handleHistoryCommand (/history slash command)
 *   - handleSkillsCommand (/skills slash command)
 *   - handleWizardCommand (/wizard slash command)
 *   - handleLaunchWizardTab (launch wizard in new tab)
 *   - isWizardActiveForCurrentTab (derived value)
 *   - handleWizardComplete (converts wizard tab to normal session)
 *   - handleWizardLetsGo (generates documents)
 *   - handleToggleWizardShowThinking (toggle thinking display)
 *   - handleWizardLaunchSession (onboarding wizard -> session creation)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';

// ============================================================================
// Mocks
// ============================================================================

vi.mock('../../renderer/services/git', () => ({
	gitService: {
		isRepo: vi.fn().mockResolvedValue(false),
		getBranches: vi.fn().mockResolvedValue(['main']),
		getTags: vi.fn().mockResolvedValue([]),
	},
}));

vi.mock('../../renderer/stores/notificationStore', async () => {
	const actual = await vi.importActual('../../renderer/stores/notificationStore');
	return { ...actual, notifyToast: vi.fn() };
});

let idCounter = 0;
vi.mock('../../renderer/utils/ids', () => ({
	generateId: vi.fn(() => `mock-id-${++idCounter}`),
}));

vi.mock('../../renderer/utils/sessionValidation', () => ({
	validateNewSession: vi.fn(() => ({ valid: true, error: null })),
}));

vi.mock('../../renderer/constants/app', () => ({
	getSlashCommandDescription: vi.fn((cmd: string) => `Description for ${cmd}`),
}));

vi.mock('../../prompts', async () => {
	const actual = await vi.importActual('../../prompts');
	return { ...actual, autorunSynopsisPrompt: 'Generate a synopsis of all work done.' };
});

vi.mock('../../shared/synopsis', () => ({
	parseSynopsis: vi.fn((response: string) => ({
		shortSummary: 'Short summary',
		fullSynopsis: response,
		nothingToReport: false,
	})),
}));

vi.mock('../../shared/formatters', () => ({
	formatRelativeTime: vi.fn(() => '5 minutes ago'),
}));

vi.mock('../../renderer/components/Wizard', () => ({
	AUTO_RUN_FOLDER_NAME: 'Auto Run Docs',
}));

vi.mock('../../renderer/components/BatchRunnerModal', () => ({
	DEFAULT_BATCH_PROMPT: 'Run each task sequentially.',
}));

vi.mock('../../renderer/utils/tabHelpers', async () => {
	const actual = await vi.importActual<typeof import('../../renderer/utils/tabHelpers')>(
		'../../renderer/utils/tabHelpers'
	);
	return {
		...actual,
		createTab: vi.fn(actual.createTab),
	};
});

vi.mock('../../renderer/utils/logger', () => ({
	logger: {
		debug: vi.fn(),
		error: (...args: unknown[]) => console.error(...args),
		info: vi.fn(),
		warn: (...args: unknown[]) => console.warn(...args),
	},
}));

import { useWizardHandlers } from '../../renderer/hooks/wizard/useWizardHandlers';
import type { UseWizardHandlersDeps } from '../../renderer/hooks/wizard/useWizardHandlers';
import { useSessionStore } from '../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../renderer/stores/settingsStore';
import { useUIStore } from '../../renderer/stores/uiStore';
import { useModalStore, getModalActions } from '../../renderer/stores/modalStore';
import { notifyToast } from '../../renderer/stores/notificationStore';
import { gitService } from '../../renderer/services/git';
import { validateNewSession } from '../../renderer/utils/sessionValidation';
import { parseSynopsis } from '../../shared/synopsis';
import { createTab } from '../../renderer/utils/tabHelpers';
import type { Session, AITab } from '../../renderer/types';

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
		hydrateTabState: vi.fn(),
		isWizardActiveForTab: vi.fn(() => false),
		selectWizardTab: vi.fn(),
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
		openWizard: vi.fn(),
		resetWizard: vi.fn(),
		restoreState: vi.fn(),
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

const createWizardState = (overrides: Record<string, any> = {}) => ({
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
	...overrides,
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
			(window as any).maestro.agents.discoverSlashCommands.mockResolvedValue([
				{ name: 'init' },
				{ name: 'review' },
			]);

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
				undefined,
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

		it('merges discovered commands only into the active session', async () => {
			const session = createMockSession({ agentCommands: undefined });
			const otherSession = createMockSession({
				id: 'other-session',
				name: 'Other Session',
				agentCommands: undefined,
				aiTabs: [createMockTab({ id: 'other-tab' })],
				activeTabId: 'other-tab',
			});
			useSessionStore.setState({
				sessions: [otherSession, session],
				activeSessionId: 'session-1',
			});

			(window as any).maestro.claude.getCommands.mockResolvedValue([
				{ command: '/existing', description: 'Custom command' },
			]);
			(window as any).maestro.agents.discoverSlashCommands.mockResolvedValue([{ name: 'review' }]);

			const deps = createMockDeps();
			renderHook(() => useWizardHandlers(deps));

			await act(async () => {
				await new Promise((r) => setTimeout(r, 50));
			});

			const sessions = useSessionStore.getState().sessions;
			expect(sessions.find((s) => s.id === 'session-1')?.agentCommands).toEqual(
				expect.arrayContaining([
					{ command: '/existing', description: 'Custom command' },
					expect.objectContaining({ command: '/review' }),
				])
			);
			expect(sessions.find((s) => s.id === 'other-session')?.agentCommands).toBeUndefined();
		});

		it('deduplicates discovered slash commands and normalizes missing slashes', async () => {
			const session = createMockSession({ agentCommands: undefined });
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			(window as any).maestro.claude.getCommands.mockResolvedValue([]);
			(window as any).maestro.agents.discoverSlashCommands.mockResolvedValue([
				{ name: '/review' },
				{ name: 'review' },
			]);

			const deps = createMockDeps();
			renderHook(() => useWizardHandlers(deps));

			await act(async () => {
				await new Promise((r) => setTimeout(r, 50));
			});

			const commands = useSessionStore.getState().sessions[0].agentCommands ?? [];
			expect(commands.filter((cmd) => cmd.command === '/review')).toHaveLength(1);
		});

		it('leaves commands unset when discovery returns null responses', async () => {
			const session = createMockSession({ agentCommands: undefined });
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			(window as any).maestro.claude.getCommands.mockResolvedValue(null);
			(window as any).maestro.agents.discoverSlashCommands.mockResolvedValue(null);

			const deps = createMockDeps();
			renderHook(() => useWizardHandlers(deps));

			await act(async () => {
				await new Promise((r) => setTimeout(r, 50));
			});

			expect(useSessionStore.getState().sessions[0].agentCommands).toBeUndefined();
		});

		it('ignores discovered commands that resolve after unmount', async () => {
			const session = createMockSession({ agentCommands: undefined });
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			let resolveCustomCommands!: (commands: { command: string; description: string }[]) => void;
			let resolveAgentCommands!: (commands: { name: string }[]) => void;
			const customCommandsPromise = new Promise<{ command: string; description: string }[]>(
				(resolve) => {
					resolveCustomCommands = resolve;
				}
			);
			const agentCommandsPromise = new Promise<{ name: string }[]>((resolve) => {
				resolveAgentCommands = resolve;
			});

			(window as any).maestro.claude.getCommands.mockReturnValue(customCommandsPromise);
			(window as any).maestro.agents.discoverSlashCommands.mockReturnValue(agentCommandsPromise);

			const deps = createMockDeps();
			const { unmount } = renderHook(() => useWizardHandlers(deps));

			unmount();
			await act(async () => {
				resolveCustomCommands([{ command: '/late', description: 'Late custom command' }]);
				resolveAgentCommands([{ name: 'late-agent' }]);
				await Promise.all([customCommandsPromise, agentCommandsPromise]);
			});

			expect(useSessionStore.getState().sessions[0].agentCommands).toBeUndefined();
		});

		it('does not log discovery errors after unmount', async () => {
			const session = createMockSession({ agentCommands: undefined });
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			let rejectCustomCommands!: (error: Error) => void;
			let rejectAgentCommands!: (error: Error) => void;
			const customCommandsPromise = new Promise<never>((_resolve, reject) => {
				rejectCustomCommands = reject;
			});
			const agentCommandsPromise = new Promise<never>((_resolve, reject) => {
				rejectAgentCommands = reject;
			});

			(window as any).maestro.claude.getCommands.mockReturnValue(customCommandsPromise);
			(window as any).maestro.agents.discoverSlashCommands.mockReturnValue(agentCommandsPromise);

			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
			const deps = createMockDeps();
			const { unmount } = renderHook(() => useWizardHandlers(deps));

			unmount();
			await act(async () => {
				rejectCustomCommands(new Error('late custom failure'));
				rejectAgentCommands(new Error('late agent failure'));
				await Promise.allSettled([customCommandsPromise, agentCommandsPromise]);
			});

			expect(consoleSpy).not.toHaveBeenCalled();
			consoleSpy.mockRestore();
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

		it('clears active tab wizard state when inline state is missing', async () => {
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

			const hydrateTabState = vi.fn();
			const deps = createMockDeps({
				inlineWizardContext: {
					...createMockDeps().inlineWizardContext,
					getStateForTab: vi.fn().mockReturnValue(undefined),
					hydrateTabState,
				} as any,
			});

			renderHook(() => useWizardHandlers(deps));

			await act(async () => {
				await new Promise((r) => setTimeout(r, 50));
			});

			const updatedSession = useSessionStore.getState().sessions[0];
			const activeTab = updatedSession.aiTabs.find((t) => t.id === 'tab-1');
			expect(activeTab?.wizardState).toBeUndefined();
			expect(hydrateTabState).not.toHaveBeenCalled();
		});

		it('clears stale wizard state only from the active session and active tab', async () => {
			const staleWizardState = createWizardState({
				isActive: false,
				goal: 'Stale inactive wizard',
			});
			const siblingWizardState = createWizardState({ goal: 'Keep sibling wizard' });
			const otherWizardState = createWizardState({ goal: 'Keep other session wizard' });
			const session = createMockSession({
				aiTabs: [
					createMockTab({ id: 'tab-1', wizardState: staleWizardState }),
					createMockTab({ id: 'tab-2', name: 'Sibling', wizardState: siblingWizardState }),
				],
				activeTabId: 'tab-1',
			});
			const otherSession = createMockSession({
				id: 'other-session',
				aiTabs: [createMockTab({ id: 'other-tab', wizardState: otherWizardState })],
				activeTabId: 'other-tab',
			});
			useSessionStore.setState({
				sessions: [otherSession, session],
				activeSessionId: 'session-1',
			});

			const hydrateTabState = vi.fn();
			const deps = createMockDeps({
				inlineWizardContext: {
					...createMockDeps().inlineWizardContext,
					getStateForTab: vi.fn().mockReturnValue(undefined),
					hydrateTabState,
				} as any,
			});

			renderHook(() => useWizardHandlers(deps));

			await act(async () => {
				await new Promise((r) => setTimeout(r, 50));
			});

			const sessions = useSessionStore.getState().sessions;
			const activeSession = sessions.find((s) => s.id === 'session-1')!;
			expect(activeSession.aiTabs.find((tab) => tab.id === 'tab-1')?.wizardState).toBeUndefined();
			expect(hydrateTabState).not.toHaveBeenCalled();
			expect(activeSession.aiTabs.find((tab) => tab.id === 'tab-2')?.wizardState).toBe(
				siblingWizardState
			);
			expect(sessions.find((s) => s.id === 'other-session')?.aiTabs[0].wizardState).toBe(
				otherWizardState
			);
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

		it('syncs wizard state only to the active session and active tab', async () => {
			const inactiveWizardState = createWizardState({ goal: 'Keep existing tab state' });
			const session = createMockSession({
				aiTabs: [
					createMockTab({ id: 'tab-1' }),
					createMockTab({ id: 'tab-2', name: 'Other tab', wizardState: inactiveWizardState }),
				],
				activeTabId: 'tab-1',
			});
			const otherSession = createMockSession({
				id: 'other-session',
				aiTabs: [
					createMockTab({
						id: 'other-tab',
						wizardState: createWizardState({ goal: 'Other session state' }),
					}),
				],
				activeTabId: 'other-tab',
			});
			useSessionStore.setState({
				sessions: [otherSession, session],
				activeSessionId: 'session-1',
			});

			const mockTabState = {
				isActive: true,
				isWaiting: true,
				mode: 'new',
				goal: 'Build active tab flow',
				confidence: 80,
				ready: true,
				conversationHistory: [],
				previousUIState: null,
				error: null,
				isGeneratingDocs: false,
				generatedDocuments: [],
				streamingContent: '',
				currentDocumentIndex: 0,
				generationProgress: null,
				projectPath: '/projects/test',
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

			const sessions = useSessionStore.getState().sessions;
			const updatedActiveSession = sessions.find((s) => s.id === 'session-1')!;
			const updatedOtherSession = sessions.find((s) => s.id === 'other-session')!;
			expect(updatedActiveSession.aiTabs.find((tab) => tab.id === 'tab-1')?.wizardState?.goal).toBe(
				'Build active tab flow'
			);
			expect(updatedActiveSession.aiTabs.find((tab) => tab.id === 'tab-2')?.wizardState).toBe(
				inactiveWizardState
			);
			expect(updatedOtherSession.aiTabs[0].wizardState?.goal).toBe('Other session state');
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
				}),
				'tab-1'
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
				capturedCallbacks.onThinkingChunk('{"message": "Ready"}');
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

		it('routes tool execution events when legacy wizard state has no tool list', async () => {
			const wizState = createWizardState({
				showWizardThinking: true,
				toolExecutions: undefined,
			});
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
				useSessionStore.setState({
					sessions: [
						createMockSession({
							aiTabs: [
								createMockTab({
									wizardState: { ...wizState, toolExecutions: undefined },
								}),
							],
						}),
					],
					activeSessionId: 'session-1',
				});
				capturedCallbacks.onToolExecution({
					toolName: 'Read',
					state: 'running',
					timestamp: 42,
				});
			});

			expect(useSessionStore.getState().sessions[0].aiTabs[0].wizardState?.toolExecutions).toEqual([
				{ toolName: 'Read', state: 'running', timestamp: 42 },
			]);
		});

		it('does not crash on malformed duplicate tab ids during stream updates', async () => {
			const wizState = createWizardState({
				showWizardThinking: true,
				thinkingContent: 'Existing thinking',
				toolExecutions: [],
			});
			const session = createMockSession();
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
				useSessionStore.setState({
					sessions: [
						createMockSession({
							aiTabs: [
								createMockTab({ id: 'tab-1', wizardState: wizState }),
								createMockTab({ id: 'tab-1', name: 'Duplicate without wizard state' }),
							],
							activeTabId: 'tab-1',
						}),
					],
					activeSessionId: 'session-1',
				});
				await result.current.sendWizardMessageWithThinking('Test');
			});

			act(() => {
				useSessionStore.setState({
					sessions: [
						createMockSession({
							aiTabs: [
								createMockTab({ id: 'tab-1', wizardState: wizState }),
								createMockTab({ id: 'tab-1', name: 'Duplicate without wizard state' }),
							],
							activeTabId: 'tab-1',
						}),
					],
					activeSessionId: 'session-1',
				});
				capturedCallbacks.onThinkingChunk('New thinking');
				capturedCallbacks.onToolExecution({
					toolName: 'Read',
					state: 'running',
					timestamp: 7,
				});
			});

			const tabs = useSessionStore.getState().sessions[0].aiTabs;
			expect(tabs[0].wizardState?.thinkingContent).toContain('New thinking');
			expect(tabs[0].wizardState?.toolExecutions).toContainEqual({
				toolName: 'Read',
				state: 'running',
				timestamp: 7,
			});
			expect(tabs[1].name).toBe('Duplicate without wizard state');
		});

		it('routes thinking and tool updates only to the active session tab', async () => {
			const activeWizardState = createWizardState({
				showWizardThinking: true,
				thinkingContent: 'Old active thinking',
				toolExecutions: [{ toolName: 'OldActive', state: 'done', timestamp: 1 }],
			});
			const siblingWizardState = createWizardState({
				goal: 'Sibling wizard',
				showWizardThinking: true,
				thinkingContent: 'Sibling thinking',
				toolExecutions: [{ toolName: 'SiblingTool', state: 'done', timestamp: 2 }],
			});
			const otherWizardState = createWizardState({
				goal: 'Other wizard',
				showWizardThinking: true,
				thinkingContent: 'Other thinking',
				toolExecutions: [{ toolName: 'OtherTool', state: 'done', timestamp: 3 }],
			});
			const session = createMockSession({
				aiTabs: [
					createMockTab({ id: 'tab-1', wizardState: activeWizardState }),
					createMockTab({ id: 'tab-2', name: 'Sibling', wizardState: siblingWizardState }),
				],
				activeTabId: 'tab-1',
			});
			const otherSession = createMockSession({
				id: 'other-session',
				aiTabs: [createMockTab({ id: 'other-tab', wizardState: otherWizardState })],
				activeTabId: 'other-tab',
			});
			useSessionStore.setState({
				sessions: [otherSession, session],
				activeSessionId: 'session-1',
			});

			let capturedCallbacks: any;
			const sendMessage = vi.fn().mockImplementation((_content, _images, callbacks) => {
				capturedCallbacks = callbacks;
				return Promise.resolve();
			});
			const deps = createMockDeps({
				inlineWizardContext: {
					...createMockDeps().inlineWizardContext,
					sendMessage,
					getStateForTab: vi
						.fn()
						.mockReturnValue(createMatchingInlineWizardTabState(activeWizardState)),
				} as any,
			});

			const { result } = renderHook(() => useWizardHandlers(deps));

			await act(async () => {
				await result.current.sendWizardMessageWithThinking('Test');
			});

			act(() => {
				capturedCallbacks.onThinkingChunk('New active thinking');
				capturedCallbacks.onToolExecution({
					toolName: 'Read',
					state: 'running',
					timestamp: 4,
				});
			});

			const sessions = useSessionStore.getState().sessions;
			const activeSession = sessions.find((s) => s.id === 'session-1')!;
			const activeTab = activeSession.aiTabs.find((tab) => tab.id === 'tab-1')!;
			const siblingTab = activeSession.aiTabs.find((tab) => tab.id === 'tab-2')!;
			const otherTab = sessions.find((s) => s.id === 'other-session')!.aiTabs[0];
			expect(activeTab.wizardState?.thinkingContent).toBe('New active thinking');
			expect(activeTab.wizardState?.toolExecutions).toEqual([
				{ toolName: 'Read', state: 'running', timestamp: 4 },
			]);
			expect(siblingTab.wizardState).toBe(siblingWizardState);
			expect(otherTab.wizardState).toBe(otherWizardState);
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

		it('does not route tool executions when showWizardThinking is off', async () => {
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
				capturedCallbacks.onToolExecution({
					toolName: 'Read',
					state: 'running',
					timestamp: Date.now(),
				});
			});

			const updatedSession = useSessionStore.getState().sessions[0];
			const updatedTab = updatedSession.aiTabs.find((t) => t.id === 'tab-1');
			expect(updatedTab?.wizardState?.toolExecutions).toEqual([]);
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

		it('ignores thinking callbacks when the session has no active tab', async () => {
			const session = createMockSession({ aiTabs: [], activeTabId: null });
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
				} as any,
			});

			const { result } = renderHook(() => useWizardHandlers(deps));

			await act(async () => {
				await result.current.sendWizardMessageWithThinking('Test');
			});

			act(() => {
				capturedCallbacks.onThinkingChunk('Thinking text');
				capturedCallbacks.onToolExecution({
					toolName: 'Read',
					state: 'running',
					timestamp: Date.now(),
				});
			});

			expect(sendMessage).toHaveBeenCalled();
			expect(useSessionStore.getState().sessions[0].aiTabs).toEqual([]);
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
			const existingLog = {
				id: 'existing-log',
				timestamp: 1,
				source: 'system' as const,
				text: 'Keep this log',
			};
			const session = createMockSession({
				aiTabs: [createMockTab({ logs: [existingLog] })],
			});
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
			expect(activeTab.logs).toContainEqual(existingLog);
			expect(activeTab.logs.some((l) => l.text.includes('Nothing to report'))).toBe(true);
		});

		it('uses fallback history metadata and preserves existing logs on success', async () => {
			const existingLog = {
				id: 'existing-log',
				timestamp: 1,
				source: 'system' as const,
				text: 'Keep this log',
			};
			const tab = createMockTab({ name: '', logs: [existingLog] });
			const session = createMockSession({ aiTabs: [tab] });
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const deps = createMockDeps();
			const { result } = renderHook(() => useWizardHandlers(deps));

			await act(async () => {
				await result.current.handleHistoryCommand();
			});

			expect(deps.addHistoryEntry).toHaveBeenCalledWith(
				expect.objectContaining({ sessionName: undefined })
			);
			expect(notifyToast).toHaveBeenCalledWith(expect.objectContaining({ tabName: undefined }));
			const activeTab = useSessionStore.getState().sessions[0].aiTabs[0];
			expect(activeTab.logs).toContainEqual(existingLog);
			expect(activeTab.logs.some((log) => log.text.includes('Synopsis saved to history'))).toBe(
				true
			);
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
			const existingLog = {
				id: 'existing-log',
				timestamp: 1,
				source: 'system' as const,
				text: 'Keep this log',
			};
			const session = createMockSession({
				aiTabs: [createMockTab({ logs: [existingLog] })],
			});
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
			expect(activeTab.logs).toContainEqual(existingLog);
			expect(
				activeTab.logs.some((l) => l.text.includes('Failed to generate history synopsis'))
			).toBe(true);
		});

		it('replaces only the active tab pending log when synopsis generation fails', async () => {
			const session = createMockSession({
				aiTabs: [
					createMockTab({ id: 'tab-1', name: 'Active tab' }),
					createMockTab({ id: 'tab-2', name: 'Other tab' }),
				],
				activeTabId: 'tab-1',
			});
			const otherSession = createMockSession({
				id: 'other-session',
				aiTabs: [createMockTab({ id: 'other-tab', name: 'Other session tab' })],
				activeTabId: 'other-tab',
			});
			useSessionStore.setState({
				sessions: [otherSession, session],
				activeSessionId: 'session-1',
			});

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

			const sessions = useSessionStore.getState().sessions;
			const updatedActiveSession = sessions.find((s) => s.id === 'session-1')!;
			const updatedOtherSession = sessions.find((s) => s.id === 'other-session')!;
			expect(
				updatedActiveSession.aiTabs
					.find((tab) => tab.id === 'tab-1')
					?.logs.some((log) => log.text.includes('Failed to generate history synopsis'))
			).toBe(true);
			expect(updatedActiveSession.aiTabs.find((tab) => tab.id === 'tab-2')?.logs).toEqual([]);
			expect(updatedOtherSession.aiTabs[0].logs).toEqual([]);
		});

		it('handles synopsis error exception', async () => {
			const existingLog = {
				id: 'existing-log',
				timestamp: 1,
				source: 'system' as const,
				text: 'Keep this log',
			};
			const session = createMockSession({
				aiTabs: [createMockTab({ logs: [existingLog] })],
			});
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
			expect(activeTab.logs).toContainEqual(existingLog);
			expect(activeTab.logs.some((l) => l.text.includes('Error generating synopsis'))).toBe(true);
			consoleSpy.mockRestore();
		});

		it('replaces only the active tab pending log when synopsis generation throws', async () => {
			const session = createMockSession({
				aiTabs: [
					createMockTab({ id: 'tab-1', name: 'Active tab' }),
					createMockTab({ id: 'tab-2', name: 'Other tab' }),
				],
				activeTabId: 'tab-1',
			});
			const otherSession = createMockSession({
				id: 'other-session',
				aiTabs: [createMockTab({ id: 'other-tab', name: 'Other session tab' })],
				activeTabId: 'other-tab',
			});
			useSessionStore.setState({
				sessions: [otherSession, session],
				activeSessionId: 'session-1',
			});

			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
			const deps = createMockDeps({
				spawnBackgroundSynopsis: vi.fn().mockRejectedValue(new Error('Spawn failed')),
			});
			const { result } = renderHook(() => useWizardHandlers(deps));

			try {
				await act(async () => {
					await result.current.handleHistoryCommand();
				});

				const sessions = useSessionStore.getState().sessions;
				const updatedActiveSession = sessions.find((s) => s.id === 'session-1')!;
				const updatedOtherSession = sessions.find((s) => s.id === 'other-session')!;
				expect(
					updatedActiveSession.aiTabs
						.find((tab) => tab.id === 'tab-1')
						?.logs.some((log) => log.text.includes('Error generating synopsis: Spawn failed'))
				).toBe(true);
				expect(updatedActiveSession.aiTabs.find((tab) => tab.id === 'tab-2')?.logs).toEqual([]);
				expect(updatedOtherSession.aiTabs[0].logs).toEqual([]);
			} finally {
				consoleSpy.mockRestore();
			}
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

		it('updates only the active session/tab and uses group metadata on success', async () => {
			const session = createMockSession({
				groupId: 'group-1',
				aiTabs: [
					createMockTab({ id: 'tab-1', name: 'Active tab' }),
					createMockTab({ id: 'tab-2', name: 'Other tab' }),
				],
				activeTabId: 'tab-1',
			});
			const otherSession = createMockSession({
				id: 'other-session',
				aiTabs: [createMockTab({ id: 'other-tab', name: 'Other session tab' })],
				activeTabId: 'other-tab',
			});
			useSessionStore.setState({
				sessions: [otherSession, session],
				activeSessionId: 'session-1',
				groups: [{ id: 'group-1', name: 'Core Team' }],
			} as any);

			const deps = createMockDeps();
			const { result } = renderHook(() => useWizardHandlers(deps));

			await act(async () => {
				await result.current.handleHistoryCommand();
			});

			const sessions = useSessionStore.getState().sessions;
			const updatedActiveSession = sessions.find((s) => s.id === 'session-1')!;
			const updatedOtherSession = sessions.find((s) => s.id === 'other-session')!;
			expect(
				updatedActiveSession.aiTabs.find((tab) => tab.id === 'tab-1')?.lastSynopsisTime
			).toBeDefined();
			expect(
				updatedActiveSession.aiTabs.find((tab) => tab.id === 'tab-2')?.lastSynopsisTime
			).toBeUndefined();
			expect(updatedOtherSession.aiTabs[0].lastSynopsisTime).toBeUndefined();
			expect(notifyToast).toHaveBeenCalledWith(
				expect.objectContaining({
					group: 'Core Team',
					tabName: 'Active tab',
				})
			);
		});

		it('replaces only the active tab pending log when nothing is reported', async () => {
			const session = createMockSession({
				aiTabs: [
					createMockTab({ id: 'tab-1', name: 'Active tab' }),
					createMockTab({ id: 'tab-2', name: 'Other tab' }),
				],
				activeTabId: 'tab-1',
			});
			const otherSession = createMockSession({
				id: 'other-session',
				aiTabs: [createMockTab({ id: 'other-tab', name: 'Other session tab' })],
				activeTabId: 'other-tab',
			});
			useSessionStore.setState({
				sessions: [otherSession, session],
				activeSessionId: 'session-1',
			});

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

			const sessions = useSessionStore.getState().sessions;
			const updatedActiveSession = sessions.find((s) => s.id === 'session-1')!;
			const updatedOtherSession = sessions.find((s) => s.id === 'other-session')!;
			expect(
				updatedActiveSession.aiTabs
					.find((tab) => tab.id === 'tab-1')
					?.logs.some((log) => log.text.includes('Nothing to report'))
			).toBe(true);
			expect(updatedActiveSession.aiTabs.find((tab) => tab.id === 'tab-2')?.logs).toEqual([]);
			expect(updatedOtherSession.aiTabs[0].logs).toEqual([]);
			expect(deps.addHistoryEntry).not.toHaveBeenCalled();
		});
	});

	// ========================================================================
	// handleSkillsCommand
	// ========================================================================
	describe('handleSkillsCommand', () => {
		it('does nothing when there is no active session', async () => {
			useSessionStore.setState({ sessions: [], activeSessionId: null });

			const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
			const deps = createMockDeps();
			const { result } = renderHook(() => useWizardHandlers(deps));

			await act(async () => {
				await result.current.handleSkillsCommand();
			});

			expect((window as any).maestro.claude.getSkills).not.toHaveBeenCalled();
			expect(consoleSpy).toHaveBeenCalledWith('[handleSkillsCommand] No active session');
			consoleSpy.mockRestore();
		});

		it('does nothing when the active session has no active tab', async () => {
			const session = createMockSession({ aiTabs: [], activeTabId: null });
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
			const deps = createMockDeps();
			const { result } = renderHook(() => useWizardHandlers(deps));

			await act(async () => {
				await result.current.handleSkillsCommand();
			});

			expect((window as any).maestro.claude.getSkills).not.toHaveBeenCalled();
			expect(consoleSpy).toHaveBeenCalledWith('[handleSkillsCommand] No active tab');
			consoleSpy.mockRestore();
		});

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

		it('formats a single project skill without a description', async () => {
			const session = createMockSession();
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			(window as any).maestro.claude.getSkills.mockResolvedValue([
				{
					name: 'planner',
					source: 'project',
					tokenCount: 1,
					description: 'No description',
				},
			]);

			const deps = createMockDeps();
			const { result } = renderHook(() => useWizardHandlers(deps));

			await act(async () => {
				await result.current.handleSkillsCommand();
			});

			const skillsLog = useSessionStore
				.getState()
				.sessions[0].aiTabs[0].logs.find((l) => l.text.includes('## Skills'));
			expect(skillsLog!.text).toContain('1 skill available');
			expect(skillsLog!.text).toContain('| **planner** | ~1 | \u2014 |');
		});

		it('formats user skills when there are no project skills', async () => {
			const session = createMockSession();
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			(window as any).maestro.claude.getSkills.mockResolvedValue([
				{
					name: 'reviewer',
					source: 'user',
					tokenCount: 250,
					description: 'No description',
				},
			]);

			const deps = createMockDeps();
			const { result } = renderHook(() => useWizardHandlers(deps));

			await act(async () => {
				await result.current.handleSkillsCommand();
			});

			const skillsLog = useSessionStore
				.getState()
				.sessions[0].aiTabs[0].logs.find((l) => l.text.includes('## Skills'));
			expect(skillsLog!.text).not.toContain('Project Skills');
			expect(skillsLog!.text).toContain('User Skills');
			expect(skillsLog!.text).toContain('| **reviewer** | ~250 | \u2014 |');
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

		it('uses tab defaults and cwd fallback when optional wizard command state is missing', () => {
			const tab = createMockTab({
				saveToHistory: undefined as any,
				showThinking: undefined as any,
			});
			const siblingTab = createMockTab({ id: 'tab-2', name: 'Keep sibling' });
			const session = createMockSession({
				projectRoot: undefined as any,
				aiTabs: [tab, siblingTab],
				activeTabId: 'tab-1',
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const deps = createMockDeps();
			const { result } = renderHook(() => useWizardHandlers(deps));

			act(() => {
				result.current.handleWizardCommand('');
			});

			expect(deps.inlineWizardContext.startWizard).toHaveBeenCalledWith(
				undefined,
				{
					readOnlyMode: false,
					saveToHistory: true,
					showThinking: 'off',
				},
				'/projects/test',
				'claude-code',
				'Test Agent',
				'tab-1',
				'session-1',
				undefined,
				undefined,
				expect.any(String),
				expect.objectContaining({})
			);
			const updatedSession = useSessionStore.getState().sessions[0];
			expect(updatedSession.aiTabs.find((t) => t.id === 'tab-1')?.name).toBe('Wizard');
			expect(updatedSession.aiTabs.find((t) => t.id === 'tab-2')?.name).toBe('Keep sibling');
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

		it('renames only the active session tab when starting wizard', () => {
			const session = createMockSession();
			const otherSession = createMockSession({
				id: 'other-session',
				aiTabs: [createMockTab({ id: 'other-tab', name: 'Other tab' })],
				activeTabId: 'other-tab',
			});
			useSessionStore.setState({
				sessions: [otherSession, session],
				activeSessionId: 'session-1',
			});

			const deps = createMockDeps();
			const { result } = renderHook(() => useWizardHandlers(deps));

			act(() => {
				result.current.handleWizardCommand('focus this session');
			});

			const sessions = useSessionStore.getState().sessions;
			expect(sessions.find((s) => s.id === 'session-1')?.aiTabs[0].name).toBe('Wizard');
			expect(sessions.find((s) => s.id === 'other-session')?.aiTabs[0].name).toBe('Other tab');
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

		it('does nothing when the active session has no active tab', () => {
			const session = createMockSession({ aiTabs: [], activeTabId: null });
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
			const deps = createMockDeps();
			const { result } = renderHook(() => useWizardHandlers(deps));

			act(() => {
				result.current.handleWizardCommand('test');
			});

			expect(deps.inlineWizardContext.startWizard).not.toHaveBeenCalled();
			expect(consoleSpy).toHaveBeenCalledWith('[handleWizardCommand] No active tab');
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

		it('starts launched wizard tabs with cwd when project root is missing', async () => {
			const session = createMockSession({ projectRoot: undefined as any });
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const deps = createMockDeps();
			const { result } = renderHook(() => useWizardHandlers(deps));

			act(() => {
				result.current.handleLaunchWizardTab();
			});

			await act(async () => {
				await new Promise((r) => setTimeout(r, 50));
			});

			expect(deps.inlineWizardContext.startWizard).toHaveBeenCalledWith(
				undefined,
				expect.any(Object),
				'/projects/test',
				'claude-code',
				'Test Agent',
				expect.any(String),
				'session-1',
				undefined,
				undefined,
				expect.any(String),
				expect.objectContaining({})
			);
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

		it('adds the wizard tab only to the active session', () => {
			const session = createMockSession();
			const otherSession = createMockSession({
				id: 'other-session',
				aiTabs: [createMockTab({ id: 'other-tab' })],
				activeTabId: 'other-tab',
			});
			useSessionStore.setState({
				sessions: [otherSession, session],
				activeSessionId: 'session-1',
			});

			const deps = createMockDeps();
			const { result } = renderHook(() => useWizardHandlers(deps));

			act(() => {
				result.current.handleLaunchWizardTab();
			});

			const sessions = useSessionStore.getState().sessions;
			expect(sessions.find((s) => s.id === 'session-1')?.aiTabs).toHaveLength(2);
			expect(sessions.find((s) => s.id === 'other-session')?.aiTabs).toHaveLength(1);
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

		it('does not start wizard when tab creation fails', () => {
			const session = createMockSession();
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });
			vi.mocked(createTab).mockReturnValueOnce(null);

			const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
			const deps = createMockDeps();
			const { result } = renderHook(() => useWizardHandlers(deps));

			try {
				act(() => {
					result.current.handleLaunchWizardTab();
				});

				expect(consoleSpy).toHaveBeenCalledWith('[handleLaunchWizardTab] Failed to create new tab');
				expect(deps.inlineWizardContext.startWizard).not.toHaveBeenCalled();
				expect(useSessionStore.getState().sessions[0].aiTabs).toHaveLength(1);
			} finally {
				consoleSpy.mockRestore();
			}
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
					isWizardActiveForTab: vi.fn((tabId: string) => tabId === 'tab-1'),
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
					isWizardActiveForTab: vi.fn((tabId: string) => tabId === 'other-tab'),
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

		it('completes only the active wizard tab in the active session', () => {
			const wizardState = createWizardState({
				conversationHistory: [
					{
						id: 'msg-1',
						role: 'user',
						content: 'Build the plan',
						timestamp: 1000,
					},
				],
				generatedDocuments: [
					{
						filename: 'phase-1.md',
						content: '# Phase 1',
						taskCount: 1,
					},
				],
			});
			const inactiveWizardState = createWizardState({ goal: 'Keep me' });
			const session = createMockSession({
				aiTabs: [
					createMockTab({ id: 'tab-1', wizardState }),
					createMockTab({ id: 'tab-2', name: 'Other tab', wizardState: inactiveWizardState }),
				],
				activeTabId: 'tab-1',
			});
			const otherSession = createMockSession({
				id: 'other-session',
				aiTabs: [
					createMockTab({
						id: 'other-tab',
						name: 'Other session tab',
						wizardState: createWizardState({ goal: 'Other session' }),
					}),
				],
				activeTabId: 'other-tab',
			});
			useSessionStore.setState({
				sessions: [otherSession, session],
				activeSessionId: 'session-1',
			});

			const deps = createMockDeps({
				inlineWizardContext: {
					...createMockDeps().inlineWizardContext,
					getStateForTab: vi.fn().mockReturnValue(createMatchingInlineWizardTabState(wizardState)),
				} as any,
			});
			const { result } = renderHook(() => useWizardHandlers(deps));

			act(() => {
				result.current.handleWizardComplete();
			});

			const sessions = useSessionStore.getState().sessions;
			const updatedActiveSession = sessions.find((s) => s.id === 'session-1')!;
			const updatedOtherSession = sessions.find((s) => s.id === 'other-session')!;
			expect(
				updatedActiveSession.aiTabs.find((tab) => tab.id === 'tab-1')?.wizardState
			).toBeUndefined();
			expect(updatedActiveSession.aiTabs.find((tab) => tab.id === 'tab-2')?.wizardState).toBe(
				inactiveWizardState
			);
			expect(updatedOtherSession.aiTabs[0].wizardState?.goal).toBe('Other session');
		});

		it('completes legacy wizard state without generated documents', () => {
			const session = createMockSession();
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const legacyWizardState = createWizardState({
				generatedDocuments: undefined,
				subfolderName: '',
			});
			const deps = createMockDeps();
			const { result } = renderHook(() => useWizardHandlers(deps));

			act(() => {
				useSessionStore.setState({
					sessions: [
						createMockSession({
							aiTabs: [createMockTab({ wizardState: legacyWizardState })],
						}),
					],
					activeSessionId: 'session-1',
				});
				result.current.handleWizardComplete();
			});

			const activeTab = useSessionStore.getState().sessions[0].aiTabs[0];
			const summaryLog = activeTab.logs.find((log) => log.text.includes('Wizard Complete'));
			expect(summaryLog?.text).toContain('0 documents');
			expect(summaryLog?.text).toContain('0 tasks');
			expect(activeTab.name).toBe('Wizard');
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

		it('does nothing when there is no active session', () => {
			useSessionStore.setState({ sessions: [], activeSessionId: null });

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

		it('does not crash on malformed duplicate tab ids when toggling thinking', () => {
			const wizState = createWizardState({
				showWizardThinking: false,
				thinkingContent: 'old content',
			});
			const session = createMockSession();
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const deps = createMockDeps({
				inlineWizardContext: {
					...createMockDeps().inlineWizardContext,
					getStateForTab: vi.fn().mockReturnValue(createMatchingInlineWizardTabState(wizState)),
				} as any,
			});
			const { result } = renderHook(() => useWizardHandlers(deps));

			act(() => {
				useSessionStore.setState({
					sessions: [
						createMockSession({
							aiTabs: [
								createMockTab({ id: 'tab-1', wizardState: wizState }),
								createMockTab({ id: 'tab-1', name: 'Duplicate without wizard state' }),
							],
							activeTabId: 'tab-1',
						}),
					],
					activeSessionId: 'session-1',
				});
				result.current.handleToggleWizardShowThinking();
			});

			const tabs = useSessionStore.getState().sessions[0].aiTabs;
			expect(tabs[0].wizardState?.showWizardThinking).toBe(true);
			expect(tabs[1].name).toBe('Duplicate without wizard state');
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

		it('does nothing when there is no active session', () => {
			useSessionStore.setState({ sessions: [], activeSessionId: null });

			const deps = createMockDeps();
			const { result } = renderHook(() => useWizardHandlers(deps));

			act(() => {
				result.current.handleToggleWizardShowThinking();
			});

			expect(useSessionStore.getState().sessions).toEqual([]);
		});

		it('toggles thinking only on the active wizard tab', () => {
			const activeWizardState = createWizardState({
				showWizardThinking: false,
				thinkingContent: 'active old content',
			});
			const otherTabWizardState = createWizardState({
				showWizardThinking: true,
				thinkingContent: 'other tab content',
			});
			const session = createMockSession({
				aiTabs: [
					createMockTab({ id: 'tab-1', wizardState: activeWizardState }),
					createMockTab({ id: 'tab-2', wizardState: otherTabWizardState }),
				],
				activeTabId: 'tab-1',
			});
			const otherSession = createMockSession({
				id: 'other-session',
				aiTabs: [
					createMockTab({
						id: 'other-tab',
						wizardState: createWizardState({
							showWizardThinking: true,
							thinkingContent: 'other session content',
						}),
					}),
				],
				activeTabId: 'other-tab',
			});
			useSessionStore.setState({
				sessions: [otherSession, session],
				activeSessionId: 'session-1',
			});

			const deps = createMockDeps({
				inlineWizardContext: {
					...createMockDeps().inlineWizardContext,
					getStateForTab: vi
						.fn()
						.mockReturnValue(createMatchingInlineWizardTabState(activeWizardState)),
				} as any,
			});
			const { result } = renderHook(() => useWizardHandlers(deps));

			act(() => {
				result.current.handleToggleWizardShowThinking();
			});

			const sessions = useSessionStore.getState().sessions;
			const updatedActiveSession = sessions.find((s) => s.id === 'session-1')!;
			const updatedOtherSession = sessions.find((s) => s.id === 'other-session')!;
			expect(
				updatedActiveSession.aiTabs.find((tab) => tab.id === 'tab-1')?.wizardState
					?.showWizardThinking
			).toBe(true);
			expect(updatedActiveSession.aiTabs.find((tab) => tab.id === 'tab-2')?.wizardState).toBe(
				otherTabWizardState
			);
			expect(updatedOtherSession.aiTabs[0].wizardState?.thinkingContent).toBe(
				'other session content'
			);
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
			expect(newSession.autoRunFolderPath).toBe('/projects/my-app/.maestro/playbooks');
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

		it('uses selected agent as the session name when agent name is blank', async () => {
			useSessionStore.setState({ sessions: [], activeSessionId: null });

			const baseDeps = createMockDeps();
			const deps = createMockDeps({
				wizardContext: {
					...baseDeps.wizardContext,
					state: {
						...baseDeps.wizardContext.state,
						currentStep: 'review' as any,
						isOpen: true,
						agentName: '',
					},
				},
			});

			const { result } = renderHook(() => useWizardHandlers(deps));

			await act(async () => {
				await result.current.handleWizardLaunchSession(false);
			});

			expect(validateNewSession).toHaveBeenCalledWith(
				'claude-code Session',
				'/projects/test',
				'claude-code',
				[]
			);
			expect(useSessionStore.getState().sessions[0].name).toBe('claude-code Session');
		});

		it('auto-starts batch run with first document that has tasks', async () => {
			useSessionStore.setState({ sessions: [], activeSessionId: null });
			const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

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

			try {
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
					expect.stringContaining('.maestro/playbooks')
				);
			} finally {
				consoleSpy.mockRestore();
			}
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

		it('uses fallback validation messages when validation fails without an error', async () => {
			useSessionStore.setState({ sessions: [], activeSessionId: null });

			(validateNewSession as any).mockReturnValueOnce({
				valid: false,
				error: null,
			});

			const baseDeps = createMockDeps();
			const deps = createMockDeps({
				wizardContext: {
					...baseDeps.wizardContext,
					state: {
						...baseDeps.wizardContext.state,
						currentStep: 'review' as any,
						isOpen: true,
						agentName: 'Test',
					},
				},
			});

			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
			const { result } = renderHook(() => useWizardHandlers(deps));

			try {
				await expect(
					act(async () => {
						await result.current.handleWizardLaunchSession(false);
					})
				).rejects.toThrow('Session validation failed');

				expect(notifyToast).toHaveBeenCalledWith(
					expect.objectContaining({
						type: 'error',
						title: 'Agent Creation Failed',
						message: 'Cannot create duplicate agent',
					})
				);
			} finally {
				consoleSpy.mockRestore();
			}
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

	// ======================================================================
	// Tier 3D: Wizard Resume Handlers
	// ======================================================================

	describe('Wizard Resume Handlers (Tier 3D)', () => {
		const createResumeDeps = (overrides: Partial<UseWizardHandlersDeps> = {}) =>
			createMockDeps({
				wizardContext: {
					state: {
						currentStep: 'conversation' as any,
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
						confidenceLevel: 50,
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
					openWizard: vi.fn(),
					resetWizard: vi.fn(),
					restoreState: vi.fn(),
				},
				...overrides,
			});

		describe('handleWizardResume', () => {
			it('no-ops when no resume state exists in modal store', () => {
				const deps = createResumeDeps();
				const { result } = renderHook(() => useWizardHandlers(deps));

				act(() => {
					result.current.handleWizardResume();
				});

				// restoreState should NOT have been called - no state to restore
				expect(deps.wizardContext.restoreState).not.toHaveBeenCalled();
				expect(deps.wizardContext.openWizard).not.toHaveBeenCalled();
			});

			it('restores wizard state normally when no invalid flags', () => {
				const savedState = {
					currentStep: 'conversation',
					selectedAgent: 'claude-code',
					directoryPath: '/projects/test',
				};
				getModalActions().setWizardResumeState(savedState as any);

				const deps = createResumeDeps();
				const { result } = renderHook(() => useWizardHandlers(deps));

				act(() => {
					result.current.handleWizardResume();
				});

				expect(deps.wizardContext.restoreState).toHaveBeenCalledWith(savedState);
				expect(deps.wizardContext.openWizard).toHaveBeenCalled();
			});

			it('redirects to agent-selection when agentInvalid is true', () => {
				const savedState = {
					currentStep: 'conversation',
					selectedAgent: 'claude-code',
					directoryPath: '/projects/test',
				};
				getModalActions().setWizardResumeState(savedState as any);

				const deps = createResumeDeps();
				const { result } = renderHook(() => useWizardHandlers(deps));

				act(() => {
					result.current.handleWizardResume({ agentInvalid: true });
				});

				expect(deps.wizardContext.restoreState).toHaveBeenCalledWith({
					...savedState,
					currentStep: 'agent-selection',
					selectedAgent: null,
				});
			});

			it('redirects to directory-selection when directoryInvalid is true', () => {
				const savedState = {
					currentStep: 'conversation',
					selectedAgent: 'claude-code',
					directoryPath: '/old/path',
					isGitRepo: true,
				};
				getModalActions().setWizardResumeState(savedState as any);

				const deps = createResumeDeps();
				const { result } = renderHook(() => useWizardHandlers(deps));

				act(() => {
					result.current.handleWizardResume({ directoryInvalid: true });
				});

				expect(deps.wizardContext.restoreState).toHaveBeenCalledWith({
					...savedState,
					currentStep: 'directory-selection',
					directoryError:
						'The previously selected directory no longer exists. Please choose a new location.',
					directoryPath: '',
					isGitRepo: false,
				});
			});

			it('opens wizard and clears resume state after restoring', () => {
				const savedState = {
					currentStep: 'conversation',
					selectedAgent: 'claude-code',
					directoryPath: '/projects/test',
				};
				getModalActions().setWizardResumeState(savedState as any);

				const deps = createResumeDeps();
				const { result } = renderHook(() => useWizardHandlers(deps));

				act(() => {
					result.current.handleWizardResume();
				});

				expect(deps.wizardContext.openWizard).toHaveBeenCalled();
				// Resume state should be cleared in the modal store
				expect(useModalStore.getState().getData('wizardResume')).toBeUndefined();
			});
		});

		describe('handleWizardStartFresh', () => {
			it('clears resume state and opens a fresh wizard', async () => {
				getModalActions().setWizardResumeModalOpen(true);

				const deps = createResumeDeps();
				const { result } = renderHook(() => useWizardHandlers(deps));

				await act(async () => {
					await result.current.handleWizardStartFresh();
				});

				expect(useModalStore.getState().isOpen('wizardResume')).toBe(false);
				expect(deps.wizardContext.clearResumeState).toHaveBeenCalled();
				expect(deps.wizardContext.openWizard).toHaveBeenCalled();
			});

			it('calls clearResumeState on wizard context', async () => {
				const deps = createResumeDeps();
				const { result } = renderHook(() => useWizardHandlers(deps));

				await act(async () => {
					await result.current.handleWizardStartFresh();
				});

				expect(deps.wizardContext.clearResumeState).toHaveBeenCalled();
			});
		});

		describe('handleWizardResumeClose', () => {
			it('closes modal and clears resume state without further action', () => {
				const savedState = {
					currentStep: 'conversation',
					selectedAgent: 'claude-code',
				};
				getModalActions().setWizardResumeState(savedState as any);

				const deps = createResumeDeps();
				const { result } = renderHook(() => useWizardHandlers(deps));

				act(() => {
					result.current.handleWizardResumeClose();
				});

				expect(useModalStore.getState().isOpen('wizardResume')).toBe(false);
				expect(useModalStore.getState().getData('wizardResume')).toBeUndefined();
				// Should NOT have opened wizard or restored state
				expect(deps.wizardContext.restoreState).not.toHaveBeenCalled();
				expect(deps.wizardContext.openWizard).not.toHaveBeenCalled();
			});
		});
	});
});

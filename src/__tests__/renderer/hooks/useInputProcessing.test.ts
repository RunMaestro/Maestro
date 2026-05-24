import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Mock hasCapabilityCached — batch mode agents should return true for supportsBatchMode
vi.mock('../../../renderer/hooks/agent/useAgentCapabilities', async () => {
	const actual = await vi.importActual('../../../renderer/hooks/agent/useAgentCapabilities');
	return {
		...actual,
		hasCapabilityCached: vi.fn((agentId: string, capability: string) => {
			// Default batch mode agents: claude-code, codex, opencode, factory-droid
			if (capability === 'supportsBatchMode') {
				return ['claude-code', 'codex', 'opencode', 'factory-droid'].includes(agentId);
			}
			return false;
		}),
	};
});

import { useInputProcessing } from '../../../renderer/hooks/input/useInputProcessing';
import { gitService } from '../../../renderer/services/git';
import type {
	Session,
	AITab,
	CustomAICommand,
	BatchRunState,
	QueuedItem,
} from '../../../renderer/types';

// Create a mock AITab
const createMockTab = (overrides: Partial<AITab> = {}): AITab => ({
	id: 'tab-1',
	agentSessionId: null,
	name: null,
	starred: false,
	logs: [],
	inputValue: '',
	stagedImages: [],
	createdAt: 1700000000000,
	state: 'idle',
	saveToHistory: true,
	...overrides,
});

// Create a mock Session
const createMockSession = (overrides: Partial<Session> = {}): Session => {
	const baseTab = createMockTab();

	return {
		id: 'session-1',
		name: 'Test Session',
		toolType: 'claude-code',
		state: 'idle',
		cwd: '/test/project',
		fullPath: '/test/project',
		projectRoot: '/test/project',
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
		aiTabs: [baseTab],
		activeTabId: baseTab.id,
		closedTabHistory: [],
		executionQueue: [],
		activeTimeMs: 0,
		...overrides,
	} as Session;
};

// Default batch state (not running)
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

describe('useInputProcessing', () => {
	const mockSetSessions = vi.fn();
	const mockSetInputValue = vi.fn();
	const mockSetStagedImages = vi.fn();
	const mockSetSlashCommandOpen = vi.fn();
	const mockSyncAiInputToSession = vi.fn();
	const mockSyncTerminalInputToSession = vi.fn();
	const mockGetBatchState = vi.fn(() => defaultBatchState);
	const mockProcessQueuedItemRef = { current: vi.fn() };
	const mockFlushBatchedUpdates = vi.fn();
	const mockOnHistoryCommand = vi.fn().mockResolvedValue(undefined);
	const mockInputRef = { current: null } as React.RefObject<HTMLTextAreaElement | null>;

	// Store original window.maestro
	const originalMaestro = { ...window.maestro };

	beforeEach(() => {
		vi.clearAllMocks();
		mockGetBatchState.mockReturnValue(defaultBatchState);

		// Mock window.maestro.process.spawn
		window.maestro = {
			...window.maestro,
			process: {
				...window.maestro?.process,
				spawn: vi.fn().mockResolvedValue(undefined),
				write: vi.fn().mockResolvedValue(undefined),
				runCommand: vi.fn().mockResolvedValue(undefined),
			},
			agents: {
				...window.maestro?.agents,
				get: vi.fn().mockResolvedValue({
					id: 'claude-code',
					command: 'claude',
					path: '/usr/local/bin/claude',
					args: ['--print', '--verbose'],
				}),
			},
			web: {
				...window.maestro?.web,
				broadcastUserInput: vi.fn().mockResolvedValue(undefined),
			},
		} as typeof window.maestro;
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		Object.assign(window.maestro, originalMaestro);
	});

	// Helper to create hook dependencies
	const createDeps = (overrides: Partial<Parameters<typeof useInputProcessing>[0]> = {}) => {
		const session = createMockSession();
		const sessionsRef = { current: [session] };

		return {
			activeSession: session,
			activeSessionId: session.id,
			setSessions: mockSetSessions,
			inputValue: '',
			setInputValue: mockSetInputValue,
			stagedImages: [],
			setStagedImages: mockSetStagedImages,
			inputRef: mockInputRef,
			customAICommands: [] as CustomAICommand[],
			setSlashCommandOpen: mockSetSlashCommandOpen,
			syncAiInputToSession: mockSyncAiInputToSession,
			syncTerminalInputToSession: mockSyncTerminalInputToSession,
			isAiMode: true,
			sessionsRef,
			getBatchState: mockGetBatchState,
			activeBatchRunState: defaultBatchState,
			processQueuedItemRef: mockProcessQueuedItemRef,
			flushBatchedUpdates: mockFlushBatchedUpdates,
			onHistoryCommand: mockOnHistoryCommand,
			...overrides,
		};
	};

	const applySetSessionCalls = (initialSessions: Session[]) => {
		return mockSetSessions.mock.calls.reduce((sessions, [update]) => {
			return typeof update === 'function' ? update(sessions) : update;
		}, initialSessions);
	};

	const flushAsyncWork = () => new Promise((resolve) => setTimeout(resolve, 0));

	describe('hook initialization', () => {
		it('returns processInput function', () => {
			const deps = createDeps();
			const { result } = renderHook(() => useInputProcessing(deps));

			expect(result.current.processInput).toBeInstanceOf(Function);
			expect(result.current.processInputRef).toBeDefined();
		});

		it('handles null session gracefully', async () => {
			const deps = createDeps({ activeSession: null });
			const { result } = renderHook(() => useInputProcessing(deps));

			// Should not throw
			await act(async () => {
				await result.current.processInput('test message');
			});

			// Should not call any state setters
			expect(mockSetSessions).not.toHaveBeenCalled();
		});
	});

	describe('built-in /history command', () => {
		it('intercepts /history command and calls handler', async () => {
			const deps = createDeps({ inputValue: '/history' });
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});

			expect(mockOnHistoryCommand).toHaveBeenCalledTimes(1);
			expect(mockSetInputValue).toHaveBeenCalledWith('');
			expect(mockSetSlashCommandOpen).toHaveBeenCalledWith(false);
		});

		it('does not intercept /history in terminal mode', async () => {
			const session = createMockSession({ inputMode: 'terminal' });
			const deps = createDeps({
				activeSession: session,
				inputValue: '/history',
				isAiMode: false,
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});

			// Should not call history handler in terminal mode
			expect(mockOnHistoryCommand).not.toHaveBeenCalled();
		});

		it('resets input height and logs rejected /history handlers', async () => {
			const textarea = document.createElement('textarea');
			textarea.style.height = '64px';
			const error = new Error('history failed');
			const onHistoryCommand = vi.fn().mockRejectedValue(error);
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
			const deps = createDeps({
				inputValue: '/history',
				inputRef: { current: textarea },
				onHistoryCommand,
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
				await Promise.resolve();
			});

			expect(textarea.style.height).toBe('auto');
			expect(consoleError).toHaveBeenCalledWith('[processInput] /history command failed:', error);
			consoleError.mockRestore();
		});
	});

	describe('built-in /wizard command', () => {
		const mockOnWizardCommand = vi.fn();

		it('intercepts /wizard command and calls handler with empty args', async () => {
			const deps = createDeps({
				inputValue: '/wizard',
				onWizardCommand: mockOnWizardCommand,
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});

			expect(mockOnWizardCommand).toHaveBeenCalledTimes(1);
			expect(mockOnWizardCommand).toHaveBeenCalledWith('');
			expect(mockSetInputValue).toHaveBeenCalledWith('');
			expect(mockSetSlashCommandOpen).toHaveBeenCalledWith(false);
			expect(mockSyncAiInputToSession).toHaveBeenCalledWith('');
		});

		it('intercepts /wizard with arguments and passes them to handler', async () => {
			const deps = createDeps({
				inputValue: '/wizard create a new feature for user authentication',
				onWizardCommand: mockOnWizardCommand,
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});

			expect(mockOnWizardCommand).toHaveBeenCalledTimes(1);
			expect(mockOnWizardCommand).toHaveBeenCalledWith(
				'create a new feature for user authentication'
			);
			expect(mockSetInputValue).toHaveBeenCalledWith('');
		});

		it('handles /wizard with only whitespace after command', async () => {
			const deps = createDeps({
				inputValue: '/wizard   ',
				onWizardCommand: mockOnWizardCommand,
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});

			expect(mockOnWizardCommand).toHaveBeenCalledTimes(1);
			expect(mockOnWizardCommand).toHaveBeenCalledWith('');
		});

		it('resets input height when intercepting /wizard', async () => {
			const textarea = document.createElement('textarea');
			textarea.style.height = '88px';
			const deps = createDeps({
				inputValue: '/wizard write docs',
				inputRef: { current: textarea },
				onWizardCommand: mockOnWizardCommand,
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});

			expect(textarea.style.height).toBe('auto');
			expect(mockOnWizardCommand).toHaveBeenCalledWith('write docs');
		});

		it('does not intercept /wizard in terminal mode', async () => {
			const session = createMockSession({ inputMode: 'terminal' });
			const deps = createDeps({
				activeSession: session,
				inputValue: '/wizard',
				isAiMode: false,
				onWizardCommand: mockOnWizardCommand,
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});

			// Should not call wizard handler in terminal mode
			expect(mockOnWizardCommand).not.toHaveBeenCalled();
		});

		it('does not intercept /wizard when handler is not provided', async () => {
			const deps = createDeps({
				inputValue: '/wizard',
				onWizardCommand: undefined, // Handler not provided
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});

			// Should fall through to be processed as regular message
			expect(mockSetSessions).toHaveBeenCalled();
		});

		it('does not match /wizardry or other similar commands', async () => {
			const deps = createDeps({
				inputValue: '/wizardry',
				onWizardCommand: mockOnWizardCommand,
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});

			// /wizardry should NOT trigger the wizard handler
			// because it starts with /wizard but is a different command
			// The implementation correctly matches "/wizard" or "/wizard " (with space) only
			expect(mockOnWizardCommand).not.toHaveBeenCalled();
			// Should fall through to be processed as regular message
			expect(mockSetSessions).toHaveBeenCalled();
		});

		beforeEach(() => {
			mockOnWizardCommand.mockClear();
		});
	});

	describe('built-in /skills command', () => {
		const mockOnSkillsCommand = vi.fn().mockResolvedValue(undefined);

		beforeEach(() => {
			mockOnSkillsCommand.mockClear();
		});

		it('intercepts /skills for Claude Code sessions and resets the input', async () => {
			const textarea = document.createElement('textarea');
			textarea.style.height = '72px';
			const deps = createDeps({
				inputValue: '/skills',
				inputRef: { current: textarea },
				onSkillsCommand: mockOnSkillsCommand,
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});

			expect(mockOnSkillsCommand).toHaveBeenCalledTimes(1);
			expect(mockSetInputValue).toHaveBeenCalledWith('');
			expect(mockSetSlashCommandOpen).toHaveBeenCalledWith(false);
			expect(mockSyncAiInputToSession).toHaveBeenCalledWith('');
			expect(textarea.style.height).toBe('auto');
		});

		it('logs rejected /skills handlers without routing the command to the agent', async () => {
			const error = new Error('skills failed');
			const onSkillsCommand = vi.fn().mockRejectedValue(error);
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
			const deps = createDeps({
				inputValue: '/skills',
				onSkillsCommand,
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
				await Promise.resolve();
			});

			expect(onSkillsCommand).toHaveBeenCalledTimes(1);
			expect(mockSetSessions).not.toHaveBeenCalled();
			expect(consoleError).toHaveBeenCalledWith('[processInput] /skills command failed:', error);
			consoleError.mockRestore();
		});

		it('does not intercept /skills for non-Claude Code sessions', async () => {
			const codexSession = createMockSession({ toolType: 'codex' });
			const deps = createDeps({
				activeSession: codexSession,
				sessionsRef: { current: [codexSession] },
				inputValue: '/skills',
				onSkillsCommand: mockOnSkillsCommand,
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});

			expect(mockOnSkillsCommand).not.toHaveBeenCalled();
			expect(mockSetSessions).toHaveBeenCalled();
		});
	});

	describe('wizard active message routing', () => {
		it('ignores non-wizard slash commands while the inline wizard is active', async () => {
			const onWizardSendMessage = vi.fn().mockResolvedValue(undefined);
			const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
			const deps = createDeps({
				inputValue: '/unknown',
				isWizardActive: true,
				onWizardSendMessage,
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});

			expect(onWizardSendMessage).not.toHaveBeenCalled();
			expect(mockSetSessions).not.toHaveBeenCalled();
			expect(consoleLog).toHaveBeenCalledWith(
				'[processInput] Ignoring slash command in wizard mode:',
				'/unknown'
			);
			consoleLog.mockRestore();
		});

		it('sends wizard messages with staged images and resets local input state', async () => {
			const textarea = document.createElement('textarea');
			textarea.style.height = '80px';
			const onWizardSendMessage = vi.fn().mockResolvedValue(undefined);
			const deps = createDeps({
				inputValue: 'Create a plan',
				stagedImages: ['image-data'],
				inputRef: { current: textarea },
				isWizardActive: true,
				onWizardSendMessage,
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});

			expect(onWizardSendMessage).toHaveBeenCalledWith('Create a plan', ['image-data']);
			expect(mockSetInputValue).toHaveBeenCalledWith('');
			expect(mockSetStagedImages).toHaveBeenCalledWith([]);
			expect(mockSyncAiInputToSession).toHaveBeenCalledWith('');
			expect(textarea.style.height).toBe('auto');
		});

		it('sends wizard messages without images and logs send failures', async () => {
			const error = new Error('wizard send failed');
			const onWizardSendMessage = vi.fn().mockRejectedValue(error);
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
			const deps = createDeps({
				inputValue: 'Keep planning',
				isWizardActive: true,
				onWizardSendMessage,
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
				await Promise.resolve();
			});

			expect(onWizardSendMessage).toHaveBeenCalledWith('Keep planning', undefined);
			expect(consoleError).toHaveBeenCalledWith('[processInput] Wizard message failed:', error);
			consoleError.mockRestore();
		});
	});

	describe('custom AI commands', () => {
		const customCommands: CustomAICommand[] = [
			{
				id: 'commit',
				command: '/commit',
				description: 'Commit changes',
				prompt: 'Please commit all outstanding changes with a good message.',
				isBuiltIn: true,
			},
			{
				id: 'test',
				command: '/test',
				description: 'Run tests',
				prompt: 'Run the test suite and report results.',
			},
		];

		it('matches and processes custom AI command', async () => {
			vi.useFakeTimers();
			const deps = createDeps({
				inputValue: '/commit',
				customAICommands: customCommands,
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});

			// Should clear input
			expect(mockSetInputValue).toHaveBeenCalledWith('');
			expect(mockSetSlashCommandOpen).toHaveBeenCalledWith(false);
			expect(mockSyncAiInputToSession).toHaveBeenCalledWith('');
			vi.useRealTimers();
		});

		it('resets the textarea and marks only the active session busy for immediate custom commands', async () => {
			vi.useFakeTimers();
			const textarea = document.createElement('textarea');
			textarea.style.height = '96px';
			const activeTab = createMockTab({ id: 'tab-active', state: 'idle' });
			const session = createMockSession({
				isGitRepo: true,
				aiTabs: [activeTab],
				activeTabId: activeTab.id,
				aiCommandHistory: ['/old'],
			});
			const inactiveSession = createMockSession({ id: 'inactive-session', name: 'Inactive' });
			const getStatusSpy = vi
				.spyOn(gitService, 'getStatus')
				.mockResolvedValue({ branch: 'feature/testing' } as any);
			const deps = createDeps({
				activeSession: session,
				activeSessionId: session.id,
				sessionsRef: { current: [session, inactiveSession] },
				inputValue: '/commit',
				inputRef: { current: textarea },
				customAICommands: customCommands,
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
				await Promise.resolve();
				await Promise.resolve();
			});

			const updatedSessions = applySetSessionCalls([inactiveSession, session]);
			expect(updatedSessions[0]).toBe(inactiveSession);
			expect(updatedSessions[1].state).toBe('busy');
			expect(updatedSessions[1].aiTabs[0].state).toBe('busy');
			expect(updatedSessions[1].aiCommandHistory).toContain('/commit');
			expect(textarea.style.height).toBe('auto');
			expect(getStatusSpy).toHaveBeenCalledWith('/test/project');

			await act(async () => {
				vi.advanceTimersByTime(50);
			});
			expect(mockProcessQueuedItemRef.current).toHaveBeenCalledWith(
				session.id,
				expect.objectContaining({ command: '/commit' })
			);

			getStatusSpy.mockRestore();
			vi.useRealTimers();
		});

		it('does not match unknown slash command as custom command', async () => {
			const deps = createDeps({
				inputValue: '/unknown-command',
				customAICommands: customCommands,
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});

			// Unknown command should be sent through as regular message
			// (for agent to handle natively)
			expect(mockSetSessions).toHaveBeenCalled();
		});

		it('processes command immediately when session is idle', async () => {
			vi.useFakeTimers();

			const deps = createDeps({
				inputValue: '/commit',
				customAICommands: customCommands,
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});

			// Advance timer to trigger immediate processing
			await act(async () => {
				vi.advanceTimersByTime(100);
			});

			// Should call processQueuedItem
			expect(mockProcessQueuedItemRef.current).toHaveBeenCalled();

			vi.useRealTimers();
		});

		it('queues command when session is busy', async () => {
			const busySession = createMockSession({
				state: 'busy',
				aiTabs: [createMockTab({ state: 'busy' })],
			});
			const inactiveSession = createMockSession({ id: 'inactive-session', name: 'Inactive' });
			const deps = createDeps({
				activeSession: busySession,
				inputValue: '/test',
				customAICommands: customCommands,
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});

			// Should add to execution queue
			expect(mockSetSessions).toHaveBeenCalled();
			const setSessionsCall = mockSetSessions.mock.calls[0][0];
			// The function passed should add to executionQueue
			const updatedSessions = setSessionsCall([inactiveSession, busySession]);
			expect(updatedSessions[0]).toBe(inactiveSession);
			expect(updatedSessions[1].executionQueue.length).toBe(1);
			expect(updatedSessions[1].executionQueue[0].type).toBe('command');
			expect(updatedSessions[1].executionQueue[0].command).toBe('/test');
		});

		it('uses agent session prefix for custom command tab names and only marks the target tab busy', async () => {
			vi.useFakeTimers();
			const activeTab = createMockTab({
				id: 'tab-active',
				name: null,
				agentSessionId: 'claude-session-123',
			});
			const siblingTab = createMockTab({ id: 'tab-sibling', state: 'idle' });
			const session = createMockSession({
				aiTabs: [activeTab, siblingTab],
				activeTabId: activeTab.id,
			});
			const deps = createDeps({
				activeSession: session,
				inputValue: '/commit',
				customAICommands: customCommands,
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});

			const updatedSessions = applySetSessionCalls([session]);
			expect(updatedSessions[0].aiTabs.find((tab) => tab.id === 'tab-active')?.state).toBe('busy');
			expect(updatedSessions[0].aiTabs.find((tab) => tab.id === 'tab-sibling')?.state).toBe('idle');

			await act(async () => {
				vi.advanceTimersByTime(50);
			});
			expect(mockProcessQueuedItemRef.current).toHaveBeenCalledWith(
				session.id,
				expect.objectContaining({
					tabId: 'tab-active',
					tabName: 'CLAUDE',
				})
			);
			vi.useRealTimers();
		});

		it('falls back to activeTabId and New tab label when queuing a command without an active tab', async () => {
			const busySession = createMockSession({
				state: 'busy',
				aiTabs: [],
				activeTabId: 'missing-tab',
				executionQueue: [
					{
						id: 'queued-write',
						timestamp: 1,
						tabId: 'previous-tab',
						type: 'message',
						text: 'already queued',
						readOnlyMode: false,
					} as QueuedItem,
				],
			});
			const deps = createDeps({
				activeSession: busySession,
				inputValue: '/test',
				customAICommands: customCommands,
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});

			const setSessionsCall = mockSetSessions.mock.calls[0][0];
			const updatedSessions = setSessionsCall([busySession]);
			expect(updatedSessions[0].executionQueue[1]).toEqual(
				expect.objectContaining({
					tabId: 'missing-tab',
					tabName: 'New',
				})
			);
		});
	});

	describe('speckit commands (via customAICommands)', () => {
		// SpecKit commands are now included in customAICommands with id prefix 'speckit-'
		const speckitCommands: CustomAICommand[] = [
			{
				id: 'speckit-help',
				command: '/speckit.help',
				description: 'Learn how to use spec-kit',
				prompt: '# Spec-Kit Help\n\nYou are explaining how to use Spec-Kit...',
				isBuiltIn: true,
			},
			{
				id: 'speckit-constitution',
				command: '/speckit.constitution',
				description: 'Create project constitution',
				prompt: '# Create Constitution\n\nCreate a project constitution...',
				isBuiltIn: true,
			},
		];

		it('matches and processes speckit command', async () => {
			vi.useFakeTimers();
			const deps = createDeps({
				inputValue: '/speckit.help',
				customAICommands: speckitCommands,
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});

			// Should clear input (indicates command was matched)
			expect(mockSetInputValue).toHaveBeenCalledWith('');
			expect(mockSetSlashCommandOpen).toHaveBeenCalledWith(false);
			vi.useRealTimers();
		});

		it('matches speckit.constitution command', async () => {
			vi.useFakeTimers();
			const deps = createDeps({
				inputValue: '/speckit.constitution',
				customAICommands: speckitCommands,
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});

			expect(mockSetInputValue).toHaveBeenCalledWith('');
			vi.useRealTimers();
		});

		it('does not match partial speckit command', async () => {
			const deps = createDeps({
				inputValue: '/speckit', // Not a complete command
				customAICommands: speckitCommands,
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});

			// Partial command should be sent through as message
			expect(mockSetSessions).toHaveBeenCalled();
		});
	});

	describe('combined custom and speckit commands', () => {
		// Test the real-world scenario where both are combined
		const combinedCommands: CustomAICommand[] = [
			// Regular custom command
			{
				id: 'commit',
				command: '/commit',
				description: 'Commit changes',
				prompt: 'Commit all changes.',
				isBuiltIn: true,
			},
			// Speckit command (merged into customAICommands)
			{
				id: 'speckit-help',
				command: '/speckit.help',
				description: 'Spec-kit help',
				prompt: 'Help content here.',
				isBuiltIn: true,
			},
		];

		it('matches custom command when both types present', async () => {
			vi.useFakeTimers();
			const deps = createDeps({
				inputValue: '/commit',
				customAICommands: combinedCommands,
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});

			expect(mockSetInputValue).toHaveBeenCalledWith('');
			vi.useRealTimers();
		});

		it('matches speckit command when both types present', async () => {
			vi.useFakeTimers();
			const deps = createDeps({
				inputValue: '/speckit.help',
				customAICommands: combinedCommands,
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});

			expect(mockSetInputValue).toHaveBeenCalledWith('');
			vi.useRealTimers();
		});
	});

	describe('slash commands with arguments', () => {
		const speckitCommandsWithArgs: CustomAICommand[] = [
			{
				id: 'speckit-plan',
				command: '/speckit.constitution',
				description: 'Plan a feature',
				prompt:
					'## User Input\n\n```text\n$ARGUMENTS\n```\n\nYou must plan based on the above input.',
				isBuiltIn: true,
			},
			{
				id: 'test-command',
				command: '/testcommand',
				description: 'Test command',
				prompt: 'Test: $ARGUMENTS',
				isBuiltIn: true,
			},
		];

		beforeEach(() => {
			// Clear the processQueuedItemRef mock between tests in this suite
			// to ensure mock.calls[0] always refers to current test's call
			mockProcessQueuedItemRef.current.mockClear();
		});

		it('matches command with arguments and stores args in queued item', async () => {
			vi.useFakeTimers();

			const deps = createDeps({
				inputValue: '/testcommand Blah blah blah',
				customAICommands: speckitCommandsWithArgs,
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});

			// Should clear input (command matched)
			expect(mockSetInputValue).toHaveBeenCalledWith('');
			expect(mockSetSlashCommandOpen).toHaveBeenCalledWith(false);

			// Advance timer to trigger immediate processing
			await act(async () => {
				vi.advanceTimersByTime(100);
			});

			// Check that processQueuedItem was called with the correct arguments
			expect(mockProcessQueuedItemRef.current).toHaveBeenCalled();
			const callArgs = mockProcessQueuedItemRef.current.mock.calls[0];
			const queuedItem = callArgs[1] as QueuedItem;

			expect(queuedItem.type).toBe('command');
			expect(queuedItem.command).toBe('/testcommand');
			expect(queuedItem.commandArgs).toBe('Blah blah blah');

			vi.useRealTimers();
		});

		it('handles command without arguments (empty args)', async () => {
			vi.useFakeTimers();

			const deps = createDeps({
				inputValue: '/speckit.constitution',
				customAICommands: speckitCommandsWithArgs,
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});

			expect(mockSetInputValue).toHaveBeenCalledWith('');

			await act(async () => {
				vi.advanceTimersByTime(100);
			});

			const queuedItem = mockProcessQueuedItemRef.current.mock.calls[0][1] as QueuedItem;
			expect(queuedItem.command).toBe('/speckit.constitution');
			expect(queuedItem.commandArgs).toBe('');

			vi.useRealTimers();
		});

		it('preserves multi-word arguments with spaces', async () => {
			vi.useFakeTimers();

			const deps = createDeps({
				inputValue: '/testcommand Add user authentication with OAuth 2.0 support',
				customAICommands: speckitCommandsWithArgs,
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});

			await act(async () => {
				vi.advanceTimersByTime(100);
			});

			const queuedItem = mockProcessQueuedItemRef.current.mock.calls[0][1] as QueuedItem;
			expect(queuedItem.command).toBe('/testcommand');
			expect(queuedItem.commandArgs).toBe('Add user authentication with OAuth 2.0 support');

			vi.useRealTimers();
		});

		it('queues command with arguments when session is busy', async () => {
			const busySession = createMockSession({
				state: 'busy',
				aiTabs: [createMockTab({ state: 'busy' })],
			});
			const deps = createDeps({
				activeSession: busySession,
				inputValue: '/speckit.constitution create a new feature',
				customAICommands: speckitCommandsWithArgs,
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});

			// Should add to execution queue
			expect(mockSetSessions).toHaveBeenCalled();
			const setSessionsCall = mockSetSessions.mock.calls[0][0];
			const updatedSessions = setSessionsCall([busySession]);
			expect(updatedSessions[0].executionQueue.length).toBe(1);
			expect(updatedSessions[0].executionQueue[0].command).toBe('/speckit.constitution');
			expect(updatedSessions[0].executionQueue[0].commandArgs).toBe('create a new feature');
		});
	});

	describe('agent-native commands (pass-through)', () => {
		// Agent commands like /compact, /clear should NOT be in customAICommands
		// and should fall through to be sent to the agent as regular messages
		it('passes unknown slash command to agent as message', async () => {
			const deps = createDeps({
				inputValue: '/compact', // Claude Code native command
				customAICommands: [], // Not in custom commands
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});

			// Should be processed as a regular message (setSessions called for adding to logs)
			expect(mockSetSessions).toHaveBeenCalled();
		});

		it('queues normal messages with activeTabId fallback when the busy session has no active tab', async () => {
			const busySession = createMockSession({
				state: 'busy',
				aiTabs: [],
				activeTabId: 'missing-tab',
				executionQueue: [
					{
						id: 'queued-write',
						timestamp: 1,
						tabId: 'previous-tab',
						type: 'message',
						text: 'already queued',
						readOnlyMode: false,
					} as QueuedItem,
				],
			});
			const deps = createDeps({
				activeSession: busySession,
				inputValue: 'follow up while busy',
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});

			const setSessionsCall = mockSetSessions.mock.calls[0][0];
			const updatedSessions = setSessionsCall([busySession]);
			expect(updatedSessions[0].executionQueue[1]).toEqual(
				expect.objectContaining({
					type: 'message',
					tabId: 'missing-tab',
				})
			);
		});

		it('passes /clear command through to agent', async () => {
			const deps = createDeps({
				inputValue: '/clear',
				customAICommands: [],
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});

			expect(mockSetSessions).toHaveBeenCalled();
		});
	});

	describe('terminal mode behavior', () => {
		it('does not process custom commands in terminal mode', async () => {
			const session = createMockSession({ inputMode: 'terminal' });
			const deps = createDeps({
				activeSession: session,
				inputValue: '/commit',
				customAICommands: [
					{ id: 'commit', command: '/commit', description: 'Commit', prompt: 'Commit changes.' },
				],
				isAiMode: false,
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});

			// Should not match custom command in terminal mode
			// Input should be processed as terminal command
			expect(mockSetSessions).toHaveBeenCalled();
		});

		it('clears terminal logs locally for clear without running a shell command', async () => {
			const session = createMockSession({
				inputMode: 'terminal',
				shellLogs: [
					{ id: 'shell-1', timestamp: 1, source: 'user', text: 'pwd' },
					{ id: 'shell-2', timestamp: 2, source: 'output', text: '/test/project' },
				] as any,
			});
			const inactiveSession = createMockSession({ id: 'inactive-session', name: 'Inactive' });
			const deps = createDeps({
				activeSession: session,
				sessionsRef: { current: [inactiveSession, session] },
				inputValue: 'clear',
				isAiMode: false,
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});

			const updatedSessions = applySetSessionCalls([inactiveSession, session]);
			expect(updatedSessions[0]).toBe(inactiveSession);
			expect(updatedSessions[1].shellLogs).toEqual([]);
			expect(updatedSessions[1].state).toBe('idle');
			expect(updatedSessions[1].busySource).toBeUndefined();
			expect(window.maestro.process.runCommand).not.toHaveBeenCalled();
		});

		it('updates local shell cwd for verified cd commands and refreshes git status', async () => {
			const isRepoSpy = vi.spyOn(gitService, 'isRepo').mockResolvedValue(true);
			vi.mocked(window.maestro.fs.readDir).mockResolvedValueOnce([] as any);
			const session = createMockSession({
				inputMode: 'terminal',
				cwd: '/test/project',
				shellCwd: '/test/project/src',
			});
			const deps = createDeps({
				activeSession: session,
				sessionsRef: { current: [session] },
				inputValue: 'cd ..',
				isAiMode: false,
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});
			await new Promise((resolve) => setTimeout(resolve, 0));

			expect(window.maestro.fs.readDir).toHaveBeenCalledWith('/test/project', undefined);
			expect(isRepoSpy).toHaveBeenCalledWith('/test/project', undefined);
			expect(window.maestro.process.runCommand).toHaveBeenCalledWith(
				expect.objectContaining({
					sessionId: 'session-1',
					command: 'cd ..',
					cwd: '/test/project/src',
				})
			);
			const updatedSessions = applySetSessionCalls([session]);
			expect(updatedSessions[0].shellCwd).toBe('/test/project');
			expect(updatedSessions[0].isGitRepo).toBe(true);
			isRepoSpy.mockRestore();
		});

		it('updates remote cwd for verified SSH cd commands using the configured remote id', async () => {
			const isRepoSpy = vi.spyOn(gitService, 'isRepo').mockResolvedValue(false);
			vi.mocked(window.maestro.fs.readDir).mockResolvedValueOnce([] as any);
			const session = createMockSession({
				inputMode: 'terminal',
				cwd: '/local/project',
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: 'remote-1',
					workingDirOverride: '/remote/project',
				},
			});
			const deps = createDeps({
				activeSession: session,
				sessionsRef: { current: [session] },
				inputValue: 'cd ~/src',
				isAiMode: false,
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});
			await new Promise((resolve) => setTimeout(resolve, 0));

			expect(window.maestro.fs.readDir).toHaveBeenCalledWith('/remote/project/src', 'remote-1');
			expect(isRepoSpy).toHaveBeenCalledWith('/remote/project/src', 'remote-1');
			expect(window.maestro.process.runCommand).toHaveBeenCalledWith(
				expect.objectContaining({
					command: 'cd ~/src',
					cwd: '/remote/project',
					sessionSshRemoteConfig: session.sessionSshRemoteConfig,
				})
			);
			const updatedSessions = applySetSessionCalls([session]);
			expect(updatedSessions[0].remoteCwd).toBe('/remote/project/src');
			expect(updatedSessions[0].isGitRepo).toBe(false);
			isRepoSpy.mockRestore();
		});

		it.each([
			{ inputValue: 'cd', shellCwd: '/test/project/src', expectedCwd: '/test/project' },
			{ inputValue: 'cd ~', shellCwd: '/test/project/src', expectedCwd: '/test/project' },
			{
				inputValue: 'cd ~/docs',
				shellCwd: '/test/project/src',
				expectedCwd: '/test/project/docs',
			},
			{ inputValue: 'cd /tmp', shellCwd: '/test/project/src', expectedCwd: '/tmp' },
			{
				inputValue: 'cd ../shared/utils',
				shellCwd: '/test/project/src/components',
				expectedCwd: '/test/project/src/shared/utils',
			},
		])('updates local shell cwd for $inputValue', async ({ inputValue, shellCwd, expectedCwd }) => {
			const isRepoSpy = vi.spyOn(gitService, 'isRepo').mockResolvedValue(false);
			if (inputValue !== 'cd') {
				vi.mocked(window.maestro.fs.readDir).mockResolvedValueOnce([] as any);
			}
			const session = createMockSession({
				inputMode: 'terminal',
				cwd: '/test/project',
				shellCwd,
			});
			const deps = createDeps({
				activeSession: session,
				sessionsRef: { current: [session] },
				inputValue,
				isAiMode: false,
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});
			await new Promise((resolve) => setTimeout(resolve, 0));

			if (inputValue === 'cd') {
				expect(window.maestro.fs.readDir).not.toHaveBeenCalled();
			} else {
				expect(window.maestro.fs.readDir).toHaveBeenCalledWith(expectedCwd, undefined);
			}
			expect(isRepoSpy).toHaveBeenCalledWith(expectedCwd, undefined);
			const updatedSessions = applySetSessionCalls([session]);
			expect(updatedSessions[0].shellCwd).toBe(expectedCwd);
			isRepoSpy.mockRestore();
		});

		it.each([
			{ inputValue: 'cd', expectedCwd: '/remote/project' },
			{ inputValue: 'cd ~', expectedCwd: '/remote/project' },
		])(
			'updates remote cwd for $inputValue using the remote working directory',
			async ({ inputValue, expectedCwd }) => {
				const isRepoSpy = vi.spyOn(gitService, 'isRepo').mockResolvedValue(false);
				if (inputValue !== 'cd') {
					vi.mocked(window.maestro.fs.readDir).mockResolvedValueOnce([] as any);
				}
				const session = createMockSession({
					inputMode: 'terminal',
					cwd: '/local/project',
					remoteCwd: '/remote/project/src',
					sessionSshRemoteConfig: {
						enabled: true,
						remoteId: 'remote-1',
						workingDirOverride: '/remote/project',
					},
				});
				const deps = createDeps({
					activeSession: session,
					sessionsRef: { current: [session] },
					inputValue,
					isAiMode: false,
				});
				const { result } = renderHook(() => useInputProcessing(deps));

				await act(async () => {
					await result.current.processInput();
				});
				await new Promise((resolve) => setTimeout(resolve, 0));

				if (inputValue === 'cd') {
					expect(window.maestro.fs.readDir).not.toHaveBeenCalled();
				} else {
					expect(window.maestro.fs.readDir).toHaveBeenCalledWith(expectedCwd, 'remote-1');
				}
				expect(isRepoSpy).toHaveBeenCalledWith(expectedCwd, 'remote-1');
				const updatedSessions = applySetSessionCalls([session]);
				expect(updatedSessions[0].remoteCwd).toBe(expectedCwd);
				isRepoSpy.mockRestore();
			}
		);

		it('uses session cwd as the SSH base when no remote cwd or working directory override exists', async () => {
			const isRepoSpy = vi.spyOn(gitService, 'isRepo').mockResolvedValue(false);
			vi.mocked(window.maestro.fs.readDir).mockResolvedValueOnce([] as any);
			const session = createMockSession({
				inputMode: 'terminal',
				cwd: '/remote/root/',
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: 'remote-1',
				},
			});
			const inactiveSession = createMockSession({ id: 'inactive-session' });
			const deps = createDeps({
				activeSession: session,
				sessionsRef: { current: [inactiveSession, session] },
				inputValue: 'cd ~/docs',
				isAiMode: false,
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});
			await new Promise((resolve) => setTimeout(resolve, 0));

			expect(window.maestro.fs.readDir).toHaveBeenCalledWith('/remote/root/docs', 'remote-1');
			expect(window.maestro.process.runCommand).toHaveBeenCalledWith(
				expect.objectContaining({
					command: 'cd ~/docs',
					cwd: '/remote/root/',
				})
			);
			const updatedSessions = applySetSessionCalls([inactiveSession, session]);
			expect(updatedSessions[0]).toBe(inactiveSession);
			expect(updatedSessions[1].remoteCwd).toBe('/remote/root/docs');
			expect(updatedSessions[1].isGitRepo).toBe(false);
			expect(isRepoSpy).toHaveBeenCalledWith('/remote/root/docs', 'remote-1');
			isRepoSpy.mockRestore();
		});

		it('uses session cwd for a bare SSH cd when no working directory override exists', async () => {
			const isRepoSpy = vi.spyOn(gitService, 'isRepo').mockResolvedValue(false);
			const session = createMockSession({
				inputMode: 'terminal',
				cwd: '/remote/root',
				remoteCwd: '/remote/root/current',
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: 'remote-1',
				},
			});
			const deps = createDeps({
				activeSession: session,
				sessionsRef: { current: [session] },
				inputValue: 'cd',
				isAiMode: false,
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});
			await new Promise((resolve) => setTimeout(resolve, 0));

			expect(window.maestro.fs.readDir).not.toHaveBeenCalled();
			const updatedSessions = applySetSessionCalls([session]);
			expect(updatedSessions[0].remoteCwd).toBe('/remote/root');
			expect(isRepoSpy).toHaveBeenCalledWith('/remote/root', 'remote-1');
			isRepoSpy.mockRestore();
		});

		it('handles trailing slash cwd when expanding local home-relative and child paths', async () => {
			const isRepoSpy = vi.spyOn(gitService, 'isRepo').mockResolvedValue(false);
			vi.mocked(window.maestro.fs.readDir).mockResolvedValue([] as any);

			const homeSession = createMockSession({
				inputMode: 'terminal',
				cwd: '/test/project/',
				shellCwd: '/test/project/src',
			});
			const homeDeps = createDeps({
				activeSession: homeSession,
				sessionsRef: { current: [homeSession] },
				inputValue: 'cd ~/docs',
				isAiMode: false,
			});
			const homeHook = renderHook(() => useInputProcessing(homeDeps));
			await act(async () => {
				await homeHook.result.current.processInput();
			});
			await new Promise((resolve) => setTimeout(resolve, 0));

			expect(window.maestro.fs.readDir).toHaveBeenCalledWith('/test/project/docs', undefined);

			vi.clearAllMocks();
			mockGetBatchState.mockReturnValue(defaultBatchState);
			const childSession = createMockSession({
				inputMode: 'terminal',
				cwd: '/test/project',
				shellCwd: '/test/project/src/',
			});
			const childDeps = createDeps({
				activeSession: childSession,
				sessionsRef: { current: [childSession] },
				inputValue: 'cd child',
				isAiMode: false,
			});
			const childHook = renderHook(() => useInputProcessing(childDeps));
			await act(async () => {
				await childHook.result.current.processInput();
			});
			await new Promise((resolve) => setTimeout(resolve, 0));

			expect(window.maestro.fs.readDir).toHaveBeenCalledWith('/test/project/src/child', undefined);
			isRepoSpy.mockRestore();
		});

		it('keeps cwd unchanged when terminal cd verification fails', async () => {
			const isRepoSpy = vi.spyOn(gitService, 'isRepo');
			vi.mocked(window.maestro.fs.readDir).mockRejectedValueOnce(new Error('missing dir'));
			const session = createMockSession({
				inputMode: 'terminal',
				cwd: '/test/project',
				shellCwd: '/test/project/src',
			});
			const deps = createDeps({
				activeSession: session,
				sessionsRef: { current: [session] },
				inputValue: 'cd missing',
				isAiMode: false,
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});
			await new Promise((resolve) => setTimeout(resolve, 0));

			expect(window.maestro.fs.readDir).toHaveBeenCalledWith(
				'/test/project/src/missing',
				undefined
			);
			expect(isRepoSpy).not.toHaveBeenCalled();
			const updatedSessions = applySetSessionCalls([session]);
			expect(updatedSessions[0].shellCwd).toBe('/test/project/src');
			isRepoSpy.mockRestore();
		});

		it('logs terminal runCommand failures and returns the session to idle', async () => {
			const error = new Error('command failed');
			const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
			vi.mocked(window.maestro.process.runCommand).mockRejectedValueOnce(error);
			const session = createMockSession({
				inputMode: 'terminal',
				cwd: '/test/project',
				shellCwd: '/test/project',
			});
			const inactiveSession = createMockSession({ id: 'inactive-session', name: 'Inactive' });
			const deps = createDeps({
				activeSession: session,
				sessionsRef: { current: [inactiveSession, session] },
				inputValue: 'npm test',
				isAiMode: false,
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});
			await new Promise((resolve) => setTimeout(resolve, 0));

			expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to run command:', error);
			const updatedSessions = applySetSessionCalls([inactiveSession, session]);
			expect(updatedSessions[0]).toBe(inactiveSession);
			expect(updatedSessions[1].state).toBe('idle');
			expect(updatedSessions[1].busySource).toBeUndefined();
			expect(updatedSessions[1].shellLogs.at(-1)).toEqual(
				expect.objectContaining({
					source: 'system',
					text: 'Error: Failed to run command - command failed',
				})
			);
			consoleErrorSpy.mockRestore();
		});
	});

	describe('empty input handling', () => {
		it('does not process empty input', async () => {
			const deps = createDeps({ inputValue: '' });
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});

			expect(mockSetSessions).not.toHaveBeenCalled();
			expect(mockSetInputValue).not.toHaveBeenCalled();
		});

		it('does not process whitespace-only input', async () => {
			const deps = createDeps({ inputValue: '   ' });
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});

			expect(mockSetSessions).not.toHaveBeenCalled();
		});

		it('processes input with only images (no text)', async () => {
			const deps = createDeps({
				inputValue: '',
				stagedImages: ['base64-image-data'],
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});

			// Should process because there are staged images
			expect(mockSetSessions).toHaveBeenCalled();
		});
	});

	describe('override input value', () => {
		it('uses overrideInputValue when provided', async () => {
			vi.useFakeTimers();
			const customCommands: CustomAICommand[] = [
				{ id: 'commit', command: '/commit', description: 'Commit', prompt: 'Commit.' },
			];
			const deps = createDeps({
				inputValue: 'ignored input',
				customAICommands: customCommands,
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput('/commit'); // Override
			});

			// Should match the override value, not the inputValue
			expect(mockSetInputValue).toHaveBeenCalledWith('');
			vi.useRealTimers();
		});
	});

	describe('Auto Run blocking', () => {
		it('queues write commands when Auto Run is active AND session is busy', async () => {
			const runningBatchState: BatchRunState = {
				...defaultBatchState,
				isRunning: true,
			};
			mockGetBatchState.mockReturnValue(runningBatchState);

			// Session must be busy for the message to actually be queued
			// If session is idle, it processes immediately instead of queuing
			const session = createMockSession({ state: 'busy' });
			const deps = createDeps({
				activeSession: session,
				inputValue: 'regular message',
				activeBatchRunState: runningBatchState,
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});

			// Should add to queue because both Auto Run is active AND session is busy
			expect(mockSetSessions).toHaveBeenCalled();
			const setSessionsCall = mockSetSessions.mock.calls[0][0];
			const updatedSessions = setSessionsCall([session]);
			expect(updatedSessions[0].executionQueue.length).toBe(1);
		});

		it('queues write commands when Auto Run is active even if session is idle', async () => {
			const runningBatchState: BatchRunState = {
				...defaultBatchState,
				isRunning: true,
			};
			mockGetBatchState.mockReturnValue(runningBatchState);

			// When Auto Run is active, write-mode messages should ALWAYS be queued
			// to prevent file conflicts, even if the session is idle.
			// The queue will be processed when Auto Run completes via onProcessQueueAfterCompletion.
			const textarea = document.createElement('textarea');
			textarea.style.height = '80px';
			const session = createMockSession({ state: 'idle' });
			const inactiveSession = createMockSession({ id: 'inactive-session', name: 'Inactive' });
			const deps = createDeps({
				activeSession: session,
				inputValue: 'regular message',
				inputRef: { current: textarea },
				activeBatchRunState: runningBatchState,
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});

			// Should add to queue, NOT process immediately
			expect(mockSetSessions).toHaveBeenCalled();
			const setSessionsCall = mockSetSessions.mock.calls[0][0];
			const updatedSessions = setSessionsCall([inactiveSession, session]);
			expect(updatedSessions[0]).toBe(inactiveSession);
			expect(updatedSessions[1].state).toBe('idle'); // Session stays idle
			expect(updatedSessions[1].executionQueue.length).toBe(1); // Message is queued
			expect(updatedSessions[1].executionQueue[0].text).toBe('regular message');
			expect(textarea.style.height).toBe('auto');
		});

		it('queues read-only messages when the active read-only tab is busy', async () => {
			const readOnlyTab = createMockTab({
				id: 'readonly-tab',
				agentSessionId: 'readonly-agent-session',
				readOnlyMode: true,
				state: 'busy',
			});
			const session = createMockSession({
				state: 'busy',
				aiTabs: [readOnlyTab],
				activeTabId: readOnlyTab.id,
			});
			const deps = createDeps({
				activeSession: session,
				sessionsRef: { current: [session] },
				inputValue: 'read-only follow-up',
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});

			const updatedSessions = applySetSessionCalls([session]);
			expect(updatedSessions[0].executionQueue).toHaveLength(1);
			expect(updatedSessions[0].executionQueue[0]).toMatchObject({
				tabId: readOnlyTab.id,
				text: 'read-only follow-up',
				readOnlyMode: true,
			});
			expect(window.maestro.process.spawn).not.toHaveBeenCalled();
		});

		it('lets write messages bypass a busy session when all busy and queued work is read-only', async () => {
			const writeTab = createMockTab({
				id: 'write-tab',
				agentSessionId: 'write-agent-session',
				readOnlyMode: false,
				state: 'idle',
			});
			const busyReadOnlyTab = createMockTab({
				id: 'readonly-tab',
				agentSessionId: 'readonly-agent-session',
				readOnlyMode: true,
				state: 'busy',
			});
			const readOnlyQueuedItem: QueuedItem = {
				id: 'queue-1',
				timestamp: Date.now(),
				tabId: busyReadOnlyTab.id,
				type: 'message',
				text: 'read-only queued work',
				images: [],
				tabName: 'Read Only',
				readOnlyMode: true,
			};
			const session = createMockSession({
				state: 'busy',
				aiTabs: [writeTab, busyReadOnlyTab],
				activeTabId: writeTab.id,
				executionQueue: [readOnlyQueuedItem],
			});
			const deps = createDeps({
				activeSession: session,
				sessionsRef: { current: [session] },
				inputValue: 'write now',
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});

			const setSessionsCall = mockSetSessions.mock.calls[0][0];
			const updatedSessions = setSessionsCall([session]);
			expect(updatedSessions[0].executionQueue).toHaveLength(1);
			expect(updatedSessions[0].aiTabs[0].logs.at(-1)?.text).toBe('write now');
			expect(window.maestro.process.spawn).toHaveBeenCalled();
		});

		it('queues write messages when a busy tab is not read-only', async () => {
			const writeTab = createMockTab({
				id: 'write-tab',
				agentSessionId: 'write-agent-session',
				readOnlyMode: false,
				state: 'idle',
			});
			const busyWriteTab = createMockTab({
				id: 'busy-write-tab',
				agentSessionId: 'busy-write-agent-session',
				readOnlyMode: false,
				state: 'busy',
			});
			const session = createMockSession({
				state: 'busy',
				aiTabs: [writeTab, busyWriteTab],
				activeTabId: writeTab.id,
				executionQueue: [],
			});
			const deps = createDeps({
				activeSession: session,
				sessionsRef: { current: [session] },
				inputValue: 'write after busy write tab',
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});

			const updatedSessions = applySetSessionCalls([session]);
			expect(updatedSessions[0].executionQueue.at(-1)?.text).toBe('write after busy write tab');
			expect(window.maestro.process.spawn).not.toHaveBeenCalled();
		});

		it('queues write messages when queued work includes a write item', async () => {
			const writeTab = createMockTab({
				id: 'write-tab',
				agentSessionId: 'write-agent-session',
				readOnlyMode: false,
				state: 'idle',
			});
			const busyReadOnlyTab = createMockTab({
				id: 'readonly-tab',
				agentSessionId: 'readonly-agent-session',
				readOnlyMode: true,
				state: 'busy',
			});
			const queuedWriteItem: QueuedItem = {
				id: 'queue-1',
				timestamp: Date.now(),
				tabId: writeTab.id,
				type: 'message',
				text: 'write queued work',
				images: [],
				tabName: 'Write',
				readOnlyMode: false,
			};
			const session = createMockSession({
				state: 'busy',
				aiTabs: [writeTab, busyReadOnlyTab],
				activeTabId: writeTab.id,
				executionQueue: [queuedWriteItem],
			});
			const deps = createDeps({
				activeSession: session,
				sessionsRef: { current: [session] },
				inputValue: 'write after queued write item',
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});

			const updatedSessions = applySetSessionCalls([session]);
			expect(updatedSessions[0].executionQueue).toHaveLength(2);
			expect(updatedSessions[0].executionQueue.at(-1)?.text).toBe('write after queued write item');
			expect(window.maestro.process.spawn).not.toHaveBeenCalled();
		});
	});

	describe('flushBatchedUpdates', () => {
		it('calls flushBatchedUpdates before processing', async () => {
			const deps = createDeps({ inputValue: 'test message' });
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});

			expect(mockFlushBatchedUpdates).toHaveBeenCalledTimes(1);
		});
	});

	describe('read-only mode suffix', () => {
		it('appends read-only instruction suffix when tab is in read-only mode', async () => {
			const readOnlyTab = createMockTab({ readOnlyMode: true });
			const session = createMockSession({
				aiTabs: [readOnlyTab],
				activeTabId: readOnlyTab.id,
			});
			const deps = createDeps({
				activeSession: session,
				sessionsRef: { current: [session] },
				inputValue: 'explain this code',
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});

			// Verify spawn was called with the read-only suffix appended
			expect(window.maestro.process.spawn).toHaveBeenCalled();
			const spawnCall = (window.maestro.process.spawn as ReturnType<typeof vi.fn>).mock.calls[0][0];
			expect(spawnCall.prompt).toContain('explain this code');
			expect(spawnCall.prompt).toContain(
				'IMPORTANT: You are in read-only/plan mode. Do NOT write a plan file. Instead, return your plan directly to the user in beautiful markdown formatting.'
			);
			expect(spawnCall.readOnlyMode).toBe(true);
		});

		it('appends read-only instruction suffix when Auto Run is active without worktree (read-only tab)', async () => {
			const runningBatchState: BatchRunState = {
				...defaultBatchState,
				isRunning: true,
				worktreeActive: false,
			};
			mockGetBatchState.mockReturnValue(runningBatchState);

			// Use a read-only tab so the message executes immediately (not queued)
			const readOnlyTab = createMockTab({ readOnlyMode: true });
			const session = createMockSession({
				aiTabs: [readOnlyTab],
				activeTabId: readOnlyTab.id,
			});
			const deps = createDeps({
				activeSession: session,
				sessionsRef: { current: [session] },
				inputValue: 'what does this function do',
				activeBatchRunState: runningBatchState,
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});

			// Verify spawn was called with read-only suffix (Auto Run without worktree forces read-only)
			expect(window.maestro.process.spawn).toHaveBeenCalled();
			const spawnCall = (window.maestro.process.spawn as ReturnType<typeof vi.fn>).mock.calls[0][0];
			expect(spawnCall.prompt).toContain('what does this function do');
			expect(spawnCall.prompt).toContain('IMPORTANT: You are in read-only/plan mode');
			expect(spawnCall.readOnlyMode).toBe(true);
		});

		it('does not append read-only suffix when in normal write mode', async () => {
			// Use a tab WITH agentSessionId to skip system prompt prepending
			const writeTab = createMockTab({
				readOnlyMode: false,
				agentSessionId: 'existing-session-123',
			});
			const session = createMockSession({
				aiTabs: [writeTab],
				activeTabId: writeTab.id,
			});
			const deps = createDeps({
				activeSession: session,
				sessionsRef: { current: [session] },
				inputValue: 'fix this bug',
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});

			// Verify spawn was called WITHOUT the read-only suffix
			expect(window.maestro.process.spawn).toHaveBeenCalled();
			const spawnCall = (window.maestro.process.spawn as ReturnType<typeof vi.fn>).mock.calls[0][0];
			expect(spawnCall.prompt).toBe('fix this bug');
			expect(spawnCall.prompt).not.toContain('read-only/plan mode');
			expect(spawnCall.readOnlyMode).toBeFalsy();
		});

		it('warns when spawning a batch agent for a tab with logs but no agentSessionId', async () => {
			const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			const tab = createMockTab({
				agentSessionId: null,
				logs: [
					{
						id: 'log-1',
						timestamp: 1700000000000,
						source: 'ai',
						text: 'Existing context',
					},
				],
			});
			const session = createMockSession({
				aiTabs: [tab],
				activeTabId: tab.id,
			});
			const deps = createDeps({
				activeSession: session,
				sessionsRef: { current: [session] },
				inputValue: 'continue',
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});
			await flushAsyncWork();

			expect(consoleWarn).toHaveBeenCalledWith(
				'[InputProcessing] Spawning batch agent without agentSessionId for tab with existing logs',
				{
					tabId: tab.id,
					logCount: 1,
					sessionId: session.id,
				}
			);
			expect(window.maestro.process.spawn).toHaveBeenCalled();
		});

		it('appends nudge text only to the spawned prompt and resets textarea height', async () => {
			const textarea = document.createElement('textarea');
			textarea.style.height = '80px';
			vi.mocked(window.maestro.agents.get).mockResolvedValueOnce({
				id: 'claude-code',
				command: 'claude',
				path: '/usr/local/bin/claude',
				args: undefined,
			} as any);
			const writeTab = createMockTab({
				agentSessionId: 'existing-session-123',
			});
			const session = createMockSession({
				aiTabs: [writeTab],
				activeTabId: writeTab.id,
				nudgeMessage: 'Stay inside the requested scope.',
			});
			const deps = createDeps({
				activeSession: session,
				sessionsRef: { current: [session] },
				inputValue: 'fix this bug',
				inputRef: { current: textarea },
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});
			await flushAsyncWork();

			const spawnCall = (window.maestro.process.spawn as ReturnType<typeof vi.fn>).mock.calls[0][0];
			expect(spawnCall.prompt).toBe('fix this bug\n\n---\n\nStay inside the requested scope.');
			expect(spawnCall.args).toEqual([]);
			expect(window.maestro.web.broadcastUserInput).toHaveBeenCalledWith(
				session.id,
				'fix this bug',
				'ai'
			);
			expect(textarea.style.height).toBe('auto');
		});

		it('falls back to agent command when an agent path is not configured', async () => {
			vi.mocked(window.maestro.agents.get).mockResolvedValueOnce({
				id: 'claude-code',
				command: 'claude',
				path: undefined,
				args: [],
			} as any);
			const writeTab = createMockTab({
				agentSessionId: 'existing-session-123',
			});
			const session = createMockSession({
				aiTabs: [writeTab],
				activeTabId: writeTab.id,
			});
			const deps = createDeps({
				activeSession: session,
				sessionsRef: { current: [session] },
				inputValue: 'continue work',
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});
			await flushAsyncWork();

			expect(window.maestro.process.spawn).toHaveBeenCalledWith(
				expect.objectContaining({
					command: 'claude',
				})
			);
		});

		it('looks up the git branch when building the system prompt for a new git session', async () => {
			const getStatusSpy = vi
				.spyOn(gitService, 'getStatus')
				.mockResolvedValue({ branch: 'feature/new-session' } as any);
			const session = createMockSession({
				isGitRepo: true,
				aiTabs: [createMockTab({ agentSessionId: null })],
			});
			const deps = createDeps({
				activeSession: session,
				sessionsRef: { current: [session] },
				inputValue: 'start a new task',
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});
			await flushAsyncWork();

			expect(getStatusSpy).toHaveBeenCalledWith('/test/project');
			expect(window.maestro.process.spawn).toHaveBeenCalled();
			getStatusSpy.mockRestore();
		});

		it('omits empty history file paths from new-session system prompt context', async () => {
			(window.maestro as any).history = {
				...(window.maestro as any).history,
				getFilePath: vi.fn().mockResolvedValue(''),
			};
			const session = createMockSession({
				aiTabs: [createMockTab({ agentSessionId: null })],
			});
			const deps = createDeps({
				activeSession: session,
				sessionsRef: { current: [session] },
				inputValue: 'start work',
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});
			await flushAsyncWork();

			expect(window.maestro.history.getFilePath).toHaveBeenCalledWith(session.id);
			expect(window.maestro.process.spawn).toHaveBeenCalledWith(
				expect.objectContaining({
					prompt: expect.stringContaining('# User Request\n\nstart work'),
				})
			);
		});

		it('skips local history path lookup for SSH new-session system prompts', async () => {
			(window.maestro as any).history = {
				...(window.maestro as any).history,
				getFilePath: vi.fn().mockResolvedValue('/local/history.jsonl'),
			};
			const session = createMockSession({
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: 'remote-1',
				},
				aiTabs: [createMockTab({ agentSessionId: null })],
			});
			const deps = createDeps({
				activeSession: session,
				sessionsRef: { current: [session] },
				inputValue: 'start remote work',
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});
			await flushAsyncWork();

			expect(window.maestro.history.getFilePath).not.toHaveBeenCalled();
			expect(window.maestro.process.spawn).toHaveBeenCalled();
		});
	});

	describe('AI process error handling', () => {
		it('logs and leaves the session unchanged when AI mode has no active tab', async () => {
			const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
			const session = createMockSession({
				toolType: 'custom-agent' as any,
				aiTabs: [],
				activeTabId: 'missing-tab',
				aiPid: 999,
			});
			const deps = createDeps({
				activeSession: session,
				sessionsRef: { current: [session] },
				inputValue: 'message without an active tab',
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});

			const updatedSessions = applySetSessionCalls([session]);
			expect(updatedSessions[0]).toBe(session);
			expect(consoleErrorSpy).toHaveBeenCalledWith(
				'[processInput] No active tab found - session has no aiTabs, this should not happen'
			);
			consoleErrorSpy.mockRestore();
		});

		it('records a system error when the batch agent definition is missing', async () => {
			const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
			vi.mocked(window.maestro.agents.get).mockResolvedValueOnce(null as any);
			const tab = createMockTab({ id: 'tab-1', state: 'idle', logs: [] });
			const session = createMockSession({
				aiTabs: [tab],
				activeTabId: 'tab-1',
			});
			const deps = createDeps({
				activeSession: session,
				sessionsRef: { current: [session] },
				inputValue: 'start work',
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});
			await flushAsyncWork();

			expect(consoleErrorSpy).toHaveBeenCalledWith(
				'Failed to spawn agent batch process:',
				expect.objectContaining({ message: 'claude-code agent not found' })
			);
			const updatedSessions = applySetSessionCalls([session]);
			expect(updatedSessions[0].aiTabs[0].logs.at(-1)?.text).toBe(
				'Error: Failed to spawn agent process - claude-code agent not found'
			);
			consoleErrorSpy.mockRestore();
		});

		it('records batch spawn errors without AI tabs when fresh store state is tabless', async () => {
			const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
			vi.mocked(window.maestro.agents.get).mockResolvedValueOnce(null as any);
			const activeTab = createMockTab({ id: 'tab-1', state: 'idle', logs: [] });
			const activeSession = createMockSession({
				aiTabs: [activeTab],
				activeTabId: 'tab-1',
			});
			const tablessSession = createMockSession({
				id: activeSession.id,
				aiTabs: [],
				activeTabId: 'missing-tab',
			});
			const deps = createDeps({
				activeSession,
				sessionsRef: { current: [tablessSession] },
				inputValue: 'start work',
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});
			await flushAsyncWork();

			const updatedSessions = applySetSessionCalls([tablessSession]);
			expect(updatedSessions[0].state).toBe('idle');
			expect(updatedSessions[0].aiTabs).toEqual([]);
			expect(consoleErrorSpy).toHaveBeenCalledWith(
				'Failed to spawn agent batch process:',
				expect.objectContaining({ message: 'claude-code agent not found' })
			);
			consoleErrorSpy.mockRestore();
		});

		it('records a system error when fresh session state is missing before batch spawn', async () => {
			const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
			const tab = createMockTab({ id: 'tab-1', state: 'idle', logs: [] });
			const session = createMockSession({
				aiTabs: [tab],
				activeTabId: 'tab-1',
			});
			const deps = createDeps({
				activeSession: session,
				sessionsRef: { current: [] },
				inputValue: 'start work',
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});
			await flushAsyncWork();

			expect(consoleErrorSpy).toHaveBeenCalledWith(
				'Failed to spawn agent batch process:',
				expect.objectContaining({ message: 'Session not found' })
			);
			const updatedSessions = applySetSessionCalls([session]);
			expect(updatedSessions[0].aiTabs[0].logs.at(-1)?.text).toBe(
				'Error: Failed to spawn agent process - Session not found'
			);
			consoleErrorSpy.mockRestore();
		});

		it('resets AI tab state and appends a system log when batch spawn fails', async () => {
			const error = new Error('spawn failed');
			const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
			vi.mocked(window.maestro.process.spawn).mockRejectedValueOnce(error);
			const tab = createMockTab({ id: 'tab-1', state: 'idle', logs: [] });
			const siblingTab = createMockTab({ id: 'tab-2', state: 'idle', logs: [] });
			const session = createMockSession({
				aiTabs: [tab, siblingTab],
				activeTabId: 'tab-1',
				aiPid: 0,
			});
			const inactiveSession = createMockSession({ id: 'inactive-session', name: 'Inactive' });
			const deps = createDeps({
				activeSession: session,
				sessionsRef: { current: [inactiveSession, session] },
				inputValue: 'start work',
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});
			await flushAsyncWork();

			expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to spawn agent batch process:', error);
			const updatedSessions = applySetSessionCalls([inactiveSession, session]);
			expect(updatedSessions[0]).toBe(inactiveSession);
			expect(updatedSessions[1].state).toBe('idle');
			expect(updatedSessions[1].busySource).toBeUndefined();
			expect(updatedSessions[1].aiTabs[0].state).toBe('idle');
			expect(updatedSessions[1].aiTabs[0].thinkingStartTime).toBeUndefined();
			expect(updatedSessions[1].aiTabs[1]).toEqual(siblingTab);
			expect(updatedSessions[1].aiTabs[0].logs.at(-1)).toEqual(
				expect.objectContaining({
					source: 'system',
					text: 'Error: Failed to spawn agent process - spawn failed',
				})
			);
			consoleErrorSpy.mockRestore();
		});

		it('does not write stdin for non-batch AI sessions without a target pid', async () => {
			const tab = createMockTab({ id: 'tab-1', agentSessionId: 'agent-session-1' });
			const session = createMockSession({
				toolType: 'custom-agent' as any,
				aiTabs: [tab],
				activeTabId: 'tab-1',
				aiPid: 0,
			});
			const deps = createDeps({
				activeSession: session,
				sessionsRef: { current: [session] },
				inputValue: 'continue work',
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});

			expect(window.maestro.process.write).not.toHaveBeenCalled();
			expect(window.maestro.process.spawn).not.toHaveBeenCalled();
		});

		it('resets AI tab state and appends a system log when stdin write fails', async () => {
			const error = new Error('write failed');
			const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
			vi.mocked(window.maestro.process.write).mockRejectedValueOnce(error);
			const tab = createMockTab({ id: 'tab-1', state: 'idle', logs: [] });
			const siblingTab = createMockTab({ id: 'tab-2', state: 'idle', logs: [] });
			const session = createMockSession({
				toolType: 'custom-agent' as any,
				aiTabs: [tab, siblingTab],
				activeTabId: 'tab-1',
				aiPid: 999,
			});
			const inactiveSession = createMockSession({ id: 'inactive-session', name: 'Inactive' });
			const deps = createDeps({
				activeSession: session,
				sessionsRef: { current: [inactiveSession, session] },
				inputValue: 'continue work',
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});
			await flushAsyncWork();

			expect(window.maestro.process.write).toHaveBeenCalledWith(
				'session-1-ai-tab-1',
				'continue work'
			);
			expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to write to process:', error);
			const updatedSessions = applySetSessionCalls([inactiveSession, session]);
			expect(updatedSessions[0]).toBe(inactiveSession);
			expect(updatedSessions[1].state).toBe('idle');
			expect(updatedSessions[1].busySource).toBeUndefined();
			expect(updatedSessions[1].aiTabs[0].state).toBe('idle');
			expect(updatedSessions[1].aiTabs[1]).toEqual(siblingTab);
			expect(updatedSessions[1].aiTabs[0].logs.at(-1)).toEqual(
				expect.objectContaining({
					source: 'system',
					text: 'Error: Failed to write to process - write failed',
				})
			);
			consoleErrorSpy.mockRestore();
		});

		it('records stdin write errors without AI tabs in the reducer state', async () => {
			const error = new Error('write failed');
			const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
			vi.mocked(window.maestro.process.write).mockRejectedValueOnce(error);
			const tab = createMockTab({ id: 'tab-1', agentSessionId: 'agent-session-1' });
			const activeSession = createMockSession({
				toolType: 'custom-agent' as any,
				aiTabs: [tab],
				activeTabId: 'tab-1',
				aiPid: 999,
			});
			const tablessSession = createMockSession({
				id: activeSession.id,
				aiTabs: [],
				activeTabId: 'missing-tab',
			});
			const deps = createDeps({
				activeSession,
				sessionsRef: { current: [activeSession] },
				inputValue: 'continue work',
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});
			await flushAsyncWork();

			const updatedSessions = applySetSessionCalls([tablessSession]);
			expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to write to process:', error);
			expect(updatedSessions[0].state).toBe('idle');
			expect(updatedSessions[0].aiTabs).toEqual([]);
			consoleErrorSpy.mockRestore();
		});

		it('injects pending merged context into spawned AI prompt and clears it from the tab', async () => {
			const tab = createMockTab({
				id: 'tab-1',
				agentSessionId: 'agent-session-1',
				pendingMergedContext: 'Merged context from another tab',
			});
			const siblingTab = createMockTab({
				id: 'tab-2',
				agentSessionId: 'agent-session-2',
				pendingMergedContext: 'Sibling context',
			});
			const session = createMockSession({
				aiTabs: [tab, siblingTab],
				activeTabId: 'tab-1',
			});
			const inactiveSession = createMockSession({ id: 'inactive-session', name: 'Inactive' });
			const deps = createDeps({
				activeSession: session,
				sessionsRef: { current: [inactiveSession, session] },
				inputValue: 'use this context',
			});
			const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});
			await flushAsyncWork();

			expect(window.maestro.process.spawn).toHaveBeenCalledWith(
				expect.objectContaining({
					prompt: expect.stringContaining(
						'Merged context from another tab\n\n---\n\nuse this context'
					),
				})
			);
			const updatedSessions = applySetSessionCalls([inactiveSession, session]);
			expect(updatedSessions[0]).toBe(inactiveSession);
			expect(updatedSessions[1].aiTabs[0].pendingMergedContext).toBeUndefined();
			expect(updatedSessions[1].aiTabs[1].pendingMergedContext).toBe('Sibling context');
			expect(consoleLogSpy).toHaveBeenCalledWith(
				'[InputProcessing] Injected merged context into message:',
				expect.objectContaining({
					contextLength: 'Merged context from another tab'.length,
				})
			);
			consoleLogSpy.mockRestore();
		});
	});

	describe('command history tracking', () => {
		it('adds slash command to aiCommandHistory', async () => {
			vi.useFakeTimers();
			const customCommands: CustomAICommand[] = [
				{ id: 'test', command: '/test', description: 'Test', prompt: 'Test prompt.' },
			];
			const session = createMockSession();
			const deps = createDeps({
				activeSession: session,
				inputValue: '/test',
				customAICommands: customCommands,
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});

			// Verify command history is updated
			expect(mockSetSessions).toHaveBeenCalled();
			const setSessionsCall = mockSetSessions.mock.calls[0][0];
			const updatedSessions = setSessionsCall([session]);
			expect(updatedSessions[0].aiCommandHistory).toContain('/test');
			vi.useRealTimers();
		});

		it('does not append duplicate consecutive AI command history entries', async () => {
			const tab = createMockTab({ agentSessionId: 'agent-session-1' });
			const session = createMockSession({
				aiTabs: [tab],
				activeTabId: tab.id,
				aiCommandHistory: ['repeat me'],
			});
			const deps = createDeps({
				activeSession: session,
				sessionsRef: { current: [session] },
				inputValue: 'repeat me',
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});

			const updatedSessions = applySetSessionCalls([session]);
			expect(updatedSessions[0].aiCommandHistory).toEqual(['repeat me']);
		});
	});

	describe('automatic tab naming', () => {
		const mockGenerateTabName = vi.fn();

		beforeEach(() => {
			mockGenerateTabName.mockClear();
			mockGenerateTabName.mockResolvedValue('Generated Tab Name');

			// Add tabNaming mock to window.maestro
			window.maestro = {
				...window.maestro,
				tabNaming: {
					generateTabName: mockGenerateTabName,
				},
			} as typeof window.maestro;
		});

		it('triggers tab naming for new AI session with text message', async () => {
			// Tab with no agentSessionId (new session) and no custom name
			const newTab = createMockTab({
				agentSessionId: null,
				name: null,
			});
			const session = createMockSession({
				aiTabs: [newTab],
				activeTabId: newTab.id,
			});
			const deps = createDeps({
				activeSession: session,
				sessionsRef: { current: [session] },
				inputValue: 'Help me implement a new feature',
				automaticTabNamingEnabled: true,
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});

			// Should call generateTabName
			expect(mockGenerateTabName).toHaveBeenCalledTimes(1);
			expect(mockGenerateTabName).toHaveBeenCalledWith({
				userMessage: 'Help me implement a new feature',
				agentType: 'claude-code',
				cwd: '/test/project',
				sessionSshRemoteConfig: undefined,
			});
		});

		it('does not trigger tab naming when setting is disabled', async () => {
			const newTab = createMockTab({
				agentSessionId: null,
				name: null,
			});
			const session = createMockSession({
				aiTabs: [newTab],
				activeTabId: newTab.id,
			});
			const deps = createDeps({
				activeSession: session,
				sessionsRef: { current: [session] },
				inputValue: 'Help me with something',
				automaticTabNamingEnabled: false,
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});

			// Should NOT call generateTabName
			expect(mockGenerateTabName).not.toHaveBeenCalled();
		});

		it('does not trigger tab naming for existing session (has agentSessionId)', async () => {
			const existingTab = createMockTab({
				agentSessionId: 'existing-session-123',
				name: null,
			});
			const session = createMockSession({
				aiTabs: [existingTab],
				activeTabId: existingTab.id,
			});
			const deps = createDeps({
				activeSession: session,
				sessionsRef: { current: [session] },
				inputValue: 'Follow up question',
				automaticTabNamingEnabled: true,
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});

			// Should NOT call generateTabName for existing sessions
			expect(mockGenerateTabName).not.toHaveBeenCalled();
		});

		it('does not trigger tab naming when tab already has custom name', async () => {
			const namedTab = createMockTab({
				agentSessionId: null,
				name: 'My Custom Tab Name',
			});
			const session = createMockSession({
				aiTabs: [namedTab],
				activeTabId: namedTab.id,
			});
			const deps = createDeps({
				activeSession: session,
				sessionsRef: { current: [session] },
				inputValue: 'New message',
				automaticTabNamingEnabled: true,
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});

			// Should NOT call generateTabName when tab already has a name
			expect(mockGenerateTabName).not.toHaveBeenCalled();
		});

		it('does not trigger tab naming in terminal mode', async () => {
			const newTab = createMockTab({
				agentSessionId: null,
				name: null,
			});
			const session = createMockSession({
				inputMode: 'terminal',
				aiTabs: [newTab],
				activeTabId: newTab.id,
			});
			const deps = createDeps({
				activeSession: session,
				sessionsRef: { current: [session] },
				inputValue: 'ls -la',
				isAiMode: false,
				automaticTabNamingEnabled: true,
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});

			// Should NOT call generateTabName in terminal mode
			expect(mockGenerateTabName).not.toHaveBeenCalled();
		});

		it('does not trigger tab naming for empty/whitespace-only message', async () => {
			const newTab = createMockTab({
				agentSessionId: null,
				name: null,
			});
			const session = createMockSession({
				aiTabs: [newTab],
				activeTabId: newTab.id,
			});
			const deps = createDeps({
				activeSession: session,
				sessionsRef: { current: [session] },
				inputValue: '',
				stagedImages: ['base64-image-data'], // Only images, no text
				automaticTabNamingEnabled: true,
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});

			// Should NOT call generateTabName for image-only messages
			expect(mockGenerateTabName).not.toHaveBeenCalled();
		});

		it('sets isGeneratingName flag while naming is in progress', async () => {
			// Use a promise that doesn't resolve immediately
			let resolveNaming: (value: string) => void;
			const namingPromise = new Promise<string>((resolve) => {
				resolveNaming = resolve;
			});
			mockGenerateTabName.mockReturnValue(namingPromise);

			const newTab = createMockTab({
				agentSessionId: null,
				name: null,
			});
			const session = createMockSession({
				aiTabs: [newTab],
				activeTabId: newTab.id,
			});
			const inactiveSession = createMockSession({ id: 'inactive-session', name: 'Inactive' });
			const deps = createDeps({
				activeSession: session,
				sessionsRef: { current: [inactiveSession, session] },
				inputValue: 'Test message',
				automaticTabNamingEnabled: true,
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});

			// Should have called setSessions to set isGeneratingName: true
			expect(mockSetSessions).toHaveBeenCalled();
			const pendingSessions = applySetSessionCalls([inactiveSession, session]);
			expect(pendingSessions[0]).toBe(inactiveSession);
			expect(pendingSessions[1].aiTabs[0].isGeneratingName).toBe(true);

			// Resolve the naming promise
			await act(async () => {
				resolveNaming!('Generated Name');
			});
		});

		it('applies generated tab names only to the active unnamed tab', async () => {
			mockGenerateTabName.mockResolvedValue('Generated Name');
			const newTab = createMockTab({
				id: 'tab-1',
				agentSessionId: null,
				name: null,
			});
			const siblingTab = createMockTab({ id: 'tab-2', agentSessionId: null, name: null });
			const session = createMockSession({
				aiTabs: [newTab, siblingTab],
				activeTabId: newTab.id,
			});
			const inactiveSession = createMockSession({
				id: 'inactive-session',
				aiTabs: [createMockTab({ id: 'inactive-tab', name: null })],
				activeTabId: 'inactive-tab',
			});
			const deps = createDeps({
				activeSession: session,
				sessionsRef: { current: [inactiveSession, session] },
				inputValue: 'Name this work',
				automaticTabNamingEnabled: true,
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});
			await flushAsyncWork();

			const updatedSessions = applySetSessionCalls([inactiveSession, session]);
			expect(updatedSessions[0]).toBe(inactiveSession);
			expect(updatedSessions[1].aiTabs.find((tab) => tab.id === 'tab-1')?.name).toBe(
				'Generated Name'
			);
			expect(updatedSessions[1].aiTabs.find((tab) => tab.id === 'tab-1')?.isGeneratingName).toBe(
				false
			);
			expect(updatedSessions[1].aiTabs.find((tab) => tab.id === 'tab-2')?.name).toBeNull();
		});

		it('uses quick-path naming for GitHub PR URLs without spawning agent', async () => {
			const newTab = createMockTab({
				agentSessionId: null,
				name: null,
			});
			const session = createMockSession({
				aiTabs: [newTab],
				activeTabId: newTab.id,
			});
			const deps = createDeps({
				activeSession: session,
				sessionsRef: { current: [session] },
				inputValue: 'https://github.com/RunMaestro/Maestro/pull/380 review this PR',
				automaticTabNamingEnabled: true,
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});

			// Should NOT call generateTabName (quick-path handles it)
			expect(mockGenerateTabName).not.toHaveBeenCalled();

			// Should have called setSessions to set the name directly
			expect(mockSetSessions).toHaveBeenCalled();
		});

		it('applies quick-path tab names only to the active session and tab', async () => {
			const newTab = createMockTab({
				id: 'tab-1',
				agentSessionId: null,
				name: null,
			});
			const siblingTab = createMockTab({ id: 'tab-2', name: null });
			const inactiveSession = createMockSession({
				id: 'inactive-session',
				aiTabs: [createMockTab({ id: 'inactive-tab', name: null })],
				activeTabId: 'inactive-tab',
			});
			const session = createMockSession({
				aiTabs: [newTab, siblingTab],
				activeTabId: newTab.id,
			});
			const deps = createDeps({
				activeSession: session,
				sessionsRef: { current: [session, inactiveSession] },
				inputValue: 'https://github.com/RunMaestro/Maestro/pull/380 review this PR',
				automaticTabNamingEnabled: true,
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});

			const updatedSessions = applySetSessionCalls([session, inactiveSession]);
			expect(updatedSessions[0].aiTabs.find((tab) => tab.id === 'tab-1')?.name).toContain(
				'PR #380'
			);
			expect(updatedSessions[0].aiTabs.find((tab) => tab.id === 'tab-2')?.name).toBeNull();
			expect(updatedSessions[1].aiTabs[0].name).toBeNull();
		});

		it('uses quick-path naming for GitHub issue URLs without spawning agent', async () => {
			const newTab = createMockTab({
				agentSessionId: null,
				name: null,
			});
			const session = createMockSession({
				aiTabs: [newTab],
				activeTabId: newTab.id,
			});
			const deps = createDeps({
				activeSession: session,
				sessionsRef: { current: [session] },
				inputValue: 'thoughts on this issue? https://github.com/RunMaestro/Maestro/issues/381',
				automaticTabNamingEnabled: true,
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});

			// Should NOT call generateTabName (quick-path handles it)
			expect(mockGenerateTabName).not.toHaveBeenCalled();
		});

		it('clears generating state and logs when automatic tab naming returns null', async () => {
			mockGenerateTabName.mockResolvedValue(null);
			const loggerSpy = vi.spyOn(window.maestro.logger, 'log');
			const newTab = createMockTab({
				id: 'tab-1',
				agentSessionId: null,
				name: null,
			});
			const session = createMockSession({
				aiTabs: [newTab],
				activeTabId: newTab.id,
			});
			const deps = createDeps({
				activeSession: session,
				sessionsRef: { current: [session] },
				inputValue: 'Name this work',
				automaticTabNamingEnabled: true,
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});
			await flushAsyncWork();

			const updatedSessions = applySetSessionCalls([session]);
			expect(updatedSessions[0].aiTabs[0].isGeneratingName).toBe(false);
			expect(updatedSessions[0].aiTabs[0].name).toBeNull();
			expect(loggerSpy).toHaveBeenCalledWith('warn', 'Auto tab naming returned null', 'TabNaming', {
				tabId: 'tab-1',
				sessionId: 'session-1',
			});
			loggerSpy.mockRestore();
		});

		it('skips applying generated tab name if the tab was renamed before completion', async () => {
			mockGenerateTabName.mockResolvedValue('Generated Name');
			const loggerSpy = vi.spyOn(window.maestro.logger, 'log');
			const newTab = createMockTab({
				id: 'tab-1',
				agentSessionId: null,
				name: null,
			});
			const session = createMockSession({
				aiTabs: [newTab],
				activeTabId: newTab.id,
			});
			const deps = createDeps({
				activeSession: session,
				sessionsRef: { current: [session] },
				inputValue: 'Name this work',
				automaticTabNamingEnabled: true,
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});
			await flushAsyncWork();

			const nameUpdate = mockSetSessions.mock.calls.at(-1)?.[0];
			const renamedSession = {
				...session,
				aiTabs: [{ ...newTab, name: 'Manual Name' }],
			};
			const updatedSessions =
				typeof nameUpdate === 'function' ? nameUpdate([renamedSession]) : [renamedSession];
			expect(updatedSessions[0].aiTabs[0].name).toBe('Manual Name');
			expect(loggerSpy).toHaveBeenCalledWith(
				'info',
				'Auto tab naming skipped (tab already named)',
				'TabNaming',
				expect.objectContaining({
					tabId: 'tab-1',
					generatedName: 'Generated Name',
					existingName: 'Manual Name',
				})
			);
			loggerSpy.mockRestore();
		});

		it('handles tab naming failure gracefully', async () => {
			mockGenerateTabName.mockRejectedValue(new Error('Tab naming failed'));

			const newTab = createMockTab({
				id: 'tab-1',
				agentSessionId: null,
				name: null,
			});
			const siblingTab = createMockTab({
				id: 'tab-2',
				agentSessionId: null,
				name: null,
				isGeneratingName: true,
			});
			const session = createMockSession({
				aiTabs: [newTab, siblingTab],
				activeTabId: newTab.id,
			});
			const inactiveSession = createMockSession({ id: 'inactive-session', name: 'Inactive' });
			const deps = createDeps({
				activeSession: session,
				sessionsRef: { current: [inactiveSession, session] },
				inputValue: 'Test message',
				automaticTabNamingEnabled: true,
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			// Should not throw
			await act(async () => {
				await result.current.processInput();
			});

			// Tab naming was attempted
			expect(mockGenerateTabName).toHaveBeenCalled();
			await flushAsyncWork();
			const updatedSessions = applySetSessionCalls([inactiveSession, session]);
			expect(updatedSessions[0]).toBe(inactiveSession);
			expect(updatedSessions[1].aiTabs[0].isGeneratingName).toBe(false);
			expect(updatedSessions[1].aiTabs[1].isGeneratingName).toBe(true);
		});
	});
});

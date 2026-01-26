import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useInputProcessing } from '../../../renderer/hooks/input/useInputProcessing';
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
			const updatedSessions = setSessionsCall([busySession]);
			expect(updatedSessions[0].executionQueue.length).toBe(1);
			expect(updatedSessions[0].executionQueue[0].type).toBe('command');
			expect(updatedSessions[0].executionQueue[0].command).toBe('/test');
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
		});

		it('matches speckit.constitution command', async () => {
			const deps = createDeps({
				inputValue: '/speckit.constitution',
				customAICommands: speckitCommands,
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});

			expect(mockSetInputValue).toHaveBeenCalledWith('');
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
			const deps = createDeps({
				inputValue: '/commit',
				customAICommands: combinedCommands,
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});

			expect(mockSetInputValue).toHaveBeenCalledWith('');
		});

		it('matches speckit command when both types present', async () => {
			const deps = createDeps({
				inputValue: '/speckit.help',
				customAICommands: combinedCommands,
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});

			expect(mockSetInputValue).toHaveBeenCalledWith('');
		});
	});

	describe('slash commands with arguments', () => {
		const speckitCommandsWithArgs: CustomAICommand[] = [
			{
				id: 'speckit-plan',
				command: '/speckit.plan',
				description: 'Plan a feature',
				prompt: '## User Input\n\n```text\n$ARGUMENTS\n```\n\nYou must plan based on the above input.',
				isBuiltIn: true,
			},
			{
				id: 'speckit-specify',
				command: '/speckit.specify',
				description: 'Create a feature spec',
				prompt: 'Create a spec for: $ARGUMENTS',
				isBuiltIn: true,
			},
		];

		it('matches command with arguments and stores args in queued item', async () => {
			vi.useFakeTimers();

			const deps = createDeps({
				inputValue: '/speckit.plan Blah blah blah',
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
			expect(queuedItem.command).toBe('/speckit.plan');
			expect(queuedItem.commandArgs).toBe('Blah blah blah');

			vi.useRealTimers();
		});

		it('handles command without arguments (empty args)', async () => {
			vi.useFakeTimers();

			const deps = createDeps({
				inputValue: '/speckit.plan',
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
			expect(queuedItem.command).toBe('/speckit.plan');
			expect(queuedItem.commandArgs).toBe('');

			vi.useRealTimers();
		});

		it('preserves multi-word arguments with spaces', async () => {
			vi.useFakeTimers();

			const deps = createDeps({
				inputValue: '/speckit.specify Add user authentication with OAuth 2.0 support',
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
			expect(queuedItem.command).toBe('/speckit.specify');
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
				inputValue: '/speckit.plan create a new feature',
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
			expect(updatedSessions[0].executionQueue[0].command).toBe('/speckit.plan');
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
			const session = createMockSession({ state: 'idle' });
			const deps = createDeps({
				activeSession: session,
				inputValue: 'regular message',
				activeBatchRunState: runningBatchState,
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});

			// Should add to queue, NOT process immediately
			expect(mockSetSessions).toHaveBeenCalled();
			const setSessionsCall = mockSetSessions.mock.calls[0][0];
			const updatedSessions = setSessionsCall([session]);
			expect(updatedSessions[0].state).toBe('idle'); // Session stays idle
			expect(updatedSessions[0].executionQueue.length).toBe(1); // Message is queued
			expect(updatedSessions[0].executionQueue[0].text).toBe('regular message');
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
	});

	describe('command history tracking', () => {
		it('adds slash command to aiCommandHistory', async () => {
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
		});
	});
});

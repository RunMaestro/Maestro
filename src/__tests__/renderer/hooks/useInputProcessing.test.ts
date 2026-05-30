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
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import type {
	Session,
	AITab,
	CustomAICommand,
	BatchRunState,
	QueuedItem,
} from '../../../renderer/types';
import { createMockAITab } from '../../helpers/mockTab';
import { createMockSession as baseCreateMockSession } from '../../helpers/mockSession';

// Create a mock AITab
const createMockTab = (overrides: Partial<AITab> = {}): AITab =>
	createMockAITab({
		createdAt: 1700000000000,
		saveToHistory: true,
		...overrides,
	});

// Thin wrapper: pre-populates an AI tab so input processing has a tab
// to route messages to.
const createMockSession = (overrides: Partial<Session> = {}): Session => {
	const baseTab = createMockTab();
	return baseCreateMockSession({
		aiPid: 1234,
		terminalPid: 5678,
		aiTabs: [baseTab],
		activeTabId: baseTab.id,
		...overrides,
	});
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

		describe('forced parallel for slash commands', () => {
			afterEach(() => {
				useSettingsStore.setState({ forcedParallelExecution: false } as any);
			});

			it('processes slash command immediately when this tab is idle but another tab is busy', async () => {
				vi.useFakeTimers();
				useSettingsStore.setState({ forcedParallelExecution: true } as any);

				// Session busy because tab-2 is running, but the active tab-1 is idle.
				const session = createMockSession({
					state: 'busy',
					aiTabs: [
						createMockTab({ id: 'tab-1', state: 'idle' }),
						createMockTab({ id: 'tab-2', state: 'busy' }),
					],
					activeTabId: 'tab-1',
				});
				const deps = createDeps({
					activeSession: session,
					sessionsRef: { current: [session] },
					inputValue: '/test',
					customAICommands: customCommands,
				});
				const { result } = renderHook(() => useInputProcessing(deps));

				await act(async () => {
					await result.current.processInput(undefined, { forceParallel: true });
				});

				await act(async () => {
					vi.advanceTimersByTime(100);
				});

				// Should dispatch via processQueuedItem, NOT just enqueue
				expect(mockProcessQueuedItemRef.current).toHaveBeenCalled();
				vi.useRealTimers();
			});

			it('tags queued slash command with forceParallel when this tab is busy', async () => {
				useSettingsStore.setState({ forcedParallelExecution: true } as any);

				const busyTab = createMockTab({ state: 'busy' });
				const session = createMockSession({
					state: 'busy',
					aiTabs: [busyTab],
					activeTabId: busyTab.id,
				});
				const deps = createDeps({
					activeSession: session,
					sessionsRef: { current: [session] },
					inputValue: '/test',
					customAICommands: customCommands,
				});
				const { result } = renderHook(() => useInputProcessing(deps));

				await act(async () => {
					await result.current.processInput(undefined, { forceParallel: true });
				});

				expect(mockSetSessions).toHaveBeenCalled();
				const setSessionsCall = mockSetSessions.mock.calls[0][0];
				const updatedSessions = setSessionsCall([session]);
				expect(updatedSessions[0].executionQueue.length).toBe(1);
				expect(updatedSessions[0].executionQueue[0].command).toBe('/test');
				expect(updatedSessions[0].executionQueue[0].forceParallel).toBe(true);
			});

			it('queues slash command normally when forcedParallelExecution setting is disabled', async () => {
				useSettingsStore.setState({ forcedParallelExecution: false } as any);

				// Session busy via another tab; active tab idle. Without the setting on,
				// this should fall through the original sessionIsIdle check (false) and queue.
				const session = createMockSession({
					state: 'busy',
					aiTabs: [
						createMockTab({ id: 'tab-1', state: 'idle' }),
						createMockTab({ id: 'tab-2', state: 'busy' }),
					],
					activeTabId: 'tab-1',
				});
				const deps = createDeps({
					activeSession: session,
					sessionsRef: { current: [session] },
					inputValue: '/test',
					customAICommands: customCommands,
				});
				const { result } = renderHook(() => useInputProcessing(deps));

				await act(async () => {
					await result.current.processInput(undefined, { forceParallel: true });
				});

				// Should enqueue, not dispatch — setting gate prevents the override.
				expect(mockSetSessions).toHaveBeenCalled();
				const setSessionsCall = mockSetSessions.mock.calls[0][0];
				const updatedSessions = setSessionsCall([session]);
				expect(updatedSessions[0].executionQueue.length).toBe(1);
				expect(updatedSessions[0].executionQueue[0].forceParallel).toBeUndefined();
			});
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

	describe('forced parallel execution', () => {
		it('queues with forceParallel flag when tab is busy', async () => {
			useSettingsStore.setState({ forcedParallelExecution: true } as any);

			const busySession = createMockSession({
				state: 'busy',
				aiTabs: [createMockTab({ state: 'busy' })],
			});
			const deps = createDeps({
				activeSession: busySession,
				sessionsRef: { current: [busySession] },
				inputValue: 'forced message',
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput(undefined, { forceParallel: true });
			});

			// Should queue (tab is busy) but with forceParallel flag
			expect(mockSetSessions).toHaveBeenCalled();
			const setSessionsCall = mockSetSessions.mock.calls[0][0];
			const updatedSessions = setSessionsCall([busySession]);
			expect(updatedSessions[0].executionQueue.length).toBe(1);
			expect(updatedSessions[0].executionQueue[0].forceParallel).toBe(true);
		});

		it('sends immediately when tab is idle even if session is busy', async () => {
			useSettingsStore.setState({ forcedParallelExecution: true } as any);

			// Session busy (another tab running), but active tab is idle
			const busySession = createMockSession({
				state: 'busy',
				aiTabs: [
					createMockTab({ id: 'tab-1', state: 'idle' }),
					createMockTab({ id: 'tab-2', state: 'busy' }),
				],
				activeTabId: 'tab-1',
			});
			const deps = createDeps({
				activeSession: busySession,
				sessionsRef: { current: [busySession] },
				inputValue: 'forced message',
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput(undefined, { forceParallel: true });
			});

			// Tab is idle — should send immediately, skipping cross-tab wait
			expect(window.maestro.process.spawn).toHaveBeenCalled();
		});

		it('sends immediately when forceParallel and AutoRun is active but tab is idle', async () => {
			useSettingsStore.setState({ forcedParallelExecution: true } as any);

			const runningBatchState: BatchRunState = {
				...defaultBatchState,
				isRunning: true,
			};
			mockGetBatchState.mockReturnValue(runningBatchState);

			const session = createMockSession({ state: 'busy' });
			const deps = createDeps({
				activeSession: session,
				sessionsRef: { current: [session] },
				inputValue: 'forced during autorun',
				activeBatchRunState: runningBatchState,
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput(undefined, { forceParallel: true });
			});

			// Tab is idle — should send immediately, skipping AutoRun wait
			expect(window.maestro.process.spawn).toHaveBeenCalled();
		});

		it('still queues when forceParallel is true but setting is disabled', async () => {
			useSettingsStore.setState({ forcedParallelExecution: false } as any);

			const busySession = createMockSession({
				state: 'busy',
				aiTabs: [createMockTab({ state: 'busy' })],
			});
			const deps = createDeps({
				activeSession: busySession,
				inputValue: 'should be queued',
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput(undefined, { forceParallel: true });
			});

			// Should add to execution queue because setting is off
			expect(mockSetSessions).toHaveBeenCalled();
			const setSessionsCall = mockSetSessions.mock.calls[0][0];
			const updatedSessions = setSessionsCall([busySession]);
			expect(updatedSessions[0].executionQueue.length).toBe(1);
		});

		it('queues normally when forceParallel is absent and session is busy', async () => {
			useSettingsStore.setState({ forcedParallelExecution: true } as any);

			const busySession = createMockSession({
				state: 'busy',
				aiTabs: [createMockTab({ state: 'busy' })],
			});
			const deps = createDeps({
				activeSession: busySession,
				inputValue: 'regular message',
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput(); // No forceParallel option
			});

			// Should queue normally
			expect(mockSetSessions).toHaveBeenCalled();
			const setSessionsCall = mockSetSessions.mock.calls[0][0];
			const updatedSessions = setSessionsCall([busySession]);
			expect(updatedSessions[0].executionQueue.length).toBe(1);
		});

		// Force Send replays a queued item by passing its images via options.images
		// (avoids a stale-closure race with stagedImages). These tests pin that
		// contract so the spawn payload actually carries the images.
		describe('options.images override (Force Send path)', () => {
			it('spawn payload includes images from options when text + image', async () => {
				useSettingsStore.setState({ forcedParallelExecution: true } as any);

				// Active tab idle, another tab busy — Force Send dispatches now.
				const session = createMockSession({
					state: 'busy',
					aiTabs: [
						createMockTab({ id: 'tab-1', state: 'idle' }),
						createMockTab({ id: 'tab-2', state: 'busy' }),
					],
					activeTabId: 'tab-1',
				});
				const deps = createDeps({
					activeSession: session,
					sessionsRef: { current: [session] },
					inputValue: '', // input is empty — staged images must come from options
					stagedImages: [], // active tab has no staged images at click time
				});
				const { result } = renderHook(() => useInputProcessing(deps));

				const queuedImage = 'data:image/png;base64,AAAA';

				await act(async () => {
					await result.current.processInput('look at this', {
						forceParallel: true,
						images: [queuedImage],
					});
				});

				expect(window.maestro.process.spawn).toHaveBeenCalled();
				const spawnArg = (window.maestro.process.spawn as ReturnType<typeof vi.fn>).mock
					.calls[0][0];
				expect(spawnArg.images).toEqual([queuedImage]);
				expect(spawnArg.prompt).toBe('look at this');
			});

			it('spawn payload includes images for image-only message (empty text)', async () => {
				useSettingsStore.setState({ forcedParallelExecution: true } as any);

				const session = createMockSession({
					state: 'busy',
					aiTabs: [
						createMockTab({ id: 'tab-1', state: 'idle' }),
						createMockTab({ id: 'tab-2', state: 'busy' }),
					],
					activeTabId: 'tab-1',
				});
				const deps = createDeps({
					activeSession: session,
					sessionsRef: { current: [session] },
					inputValue: '',
					stagedImages: [],
				});
				const { result } = renderHook(() => useInputProcessing(deps));

				const queuedImage = 'data:image/png;base64,BBBB';

				// Empty text + image-only — must not bail, must still spawn with images.
				await act(async () => {
					await result.current.processInput('', {
						forceParallel: true,
						images: [queuedImage],
					});
				});

				expect(window.maestro.process.spawn).toHaveBeenCalled();
				const spawnArg = (window.maestro.process.spawn as ReturnType<typeof vi.fn>).mock
					.calls[0][0];
				expect(spawnArg.images).toEqual([queuedImage]);
			});

			it('options.images takes precedence over stagedImages', async () => {
				useSettingsStore.setState({ forcedParallelExecution: true } as any);

				const session = createMockSession({
					state: 'busy',
					aiTabs: [
						createMockTab({ id: 'tab-1', state: 'idle' }),
						createMockTab({ id: 'tab-2', state: 'busy' }),
					],
					activeTabId: 'tab-1',
				});
				const deps = createDeps({
					activeSession: session,
					sessionsRef: { current: [session] },
					inputValue: 'hello',
					// Tab has a different staged image — Force Send should use the
					// queued item's images, not whatever's currently staged on the tab.
					stagedImages: ['data:image/png;base64,STAGED'],
				});
				const { result } = renderHook(() => useInputProcessing(deps));

				const queuedImage = 'data:image/png;base64,QUEUED';

				await act(async () => {
					await result.current.processInput('hello', {
						forceParallel: true,
						images: [queuedImage],
					});
				});

				const spawnArg = (window.maestro.process.spawn as ReturnType<typeof vi.fn>).mock
					.calls[0][0];
				expect(spawnArg.images).toEqual([queuedImage]);
				expect(spawnArg.images).not.toContain('data:image/png;base64,STAGED');
			});

			it('does not clear stagedImages when caller passes options.images', async () => {
				useSettingsStore.setState({ forcedParallelExecution: true } as any);

				const session = createMockSession({
					state: 'busy',
					aiTabs: [
						createMockTab({ id: 'tab-1', state: 'idle' }),
						createMockTab({ id: 'tab-2', state: 'busy' }),
					],
					activeTabId: 'tab-1',
				});
				const deps = createDeps({
					activeSession: session,
					sessionsRef: { current: [session] },
					inputValue: 'hi',
					stagedImages: ['data:image/png;base64,DRAFT'],
				});
				const { result } = renderHook(() => useInputProcessing(deps));

				await act(async () => {
					await result.current.processInput('hi', {
						forceParallel: true,
						images: ['data:image/png;base64,QUEUED'],
					});
				});

				// User's draft staged image must NOT be cleared by Force Send.
				expect(mockSetStagedImages).not.toHaveBeenCalledWith([]);
			});
		});

		afterEach(() => {
			useSettingsStore.setState({ forcedParallelExecution: false } as any);
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

		it('does NOT force read-only when Auto Run is active AND user force-sends (Cmd+Shift+Enter / Force Send)', async () => {
			useSettingsStore.setState({ forcedParallelExecution: true } as any);

			const runningBatchState: BatchRunState = {
				...defaultBatchState,
				isRunning: true,
				worktreeActive: false,
			};
			mockGetBatchState.mockReturnValue(runningBatchState);

			// Idle write tab with an existing agent session so the prompt is sent verbatim.
			const writeTab = createMockTab({
				readOnlyMode: false,
				agentSessionId: 'existing-session-456',
				state: 'idle',
			});
			const session = createMockSession({
				aiTabs: [writeTab],
				activeTabId: writeTab.id,
				state: 'idle',
			});
			const deps = createDeps({
				activeSession: session,
				sessionsRef: { current: [session] },
				inputValue: 'fix the migration',
				activeBatchRunState: runningBatchState,
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput(undefined, { forceParallel: true });
			});

			// Auto Run normally forces read-only; Force Send must override that.
			expect(window.maestro.process.spawn).toHaveBeenCalled();
			const spawnCall = (window.maestro.process.spawn as ReturnType<typeof vi.fn>).mock.calls[0][0];
			expect(spawnCall.prompt).toBe('fix the migration');
			expect(spawnCall.prompt).not.toContain('read-only/plan mode');
			expect(spawnCall.readOnlyMode).toBeFalsy();

			useSettingsStore.setState({ forcedParallelExecution: false } as any);
			mockGetBatchState.mockReturnValue(defaultBatchState);
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

		it('retries tab naming for existing session that still has no name', async () => {
			// An existing session whose first naming attempt failed/timed out: agentSessionId is
			// set but name is still null. Subsequent sends should keep retrying so the tab
			// isn't permanently stuck unnamed.
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

			expect(mockGenerateTabName).toHaveBeenCalledTimes(1);
		});

		it('does not trigger tab naming when a previous attempt is still in flight', async () => {
			const inFlightTab = createMockTab({
				agentSessionId: 'session-456',
				name: null,
				isGeneratingName: true,
			});
			const session = createMockSession({
				aiTabs: [inFlightTab],
				activeTabId: inFlightTab.id,
			});
			const deps = createDeps({
				activeSession: session,
				sessionsRef: { current: [session] },
				inputValue: 'Another message',
				automaticTabNamingEnabled: true,
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});

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
			const deps = createDeps({
				activeSession: session,
				sessionsRef: { current: [session] },
				inputValue: 'Test message',
				automaticTabNamingEnabled: true,
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});

			// Should have called setSessions to set isGeneratingName: true
			expect(mockSetSessions).toHaveBeenCalled();

			// Resolve the naming promise
			await act(async () => {
				resolveNaming!('Generated Name');
			});
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

		it('handles tab naming failure gracefully', async () => {
			mockGenerateTabName.mockRejectedValue(new Error('Tab naming failed'));

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
		});
	});

	describe('retry after agent error', () => {
		// Regression: on retry, thinking pill stayed hidden because session-level
		// agentError was still set. That pinned session.state to 'error' via the
		// `state === 'error' && agentError` branch in useAgentListeners (onExit:703,
		// onData:548), even though processInput flipped state to 'busy'.
		it('clears session and tab agent error state on AI retry', async () => {
			const priorError = {
				type: 'unknown' as const,
				message: 'Agent exited with code 143',
				timestamp: Date.now(),
				raw: 'Agent exited with code 143',
			};
			const erroredTab = createMockTab({
				state: 'idle',
				agentError: priorError,
			});
			const erroredSession = createMockSession({
				state: 'error',
				busySource: undefined,
				agentError: priorError,
				agentErrorTabId: erroredTab.id,
				agentErrorPaused: true,
				aiTabs: [erroredTab],
				activeTabId: erroredTab.id,
			});

			const deps = createDeps({
				activeSession: erroredSession,
				sessionsRef: { current: [erroredSession] },
				inputValue: 'retry after crash',
			});
			const { result } = renderHook(() => useInputProcessing(deps));

			await act(async () => {
				await result.current.processInput();
			});

			expect(mockSetSessions).toHaveBeenCalled();
			const updater = mockSetSessions.mock.calls[0][0];
			const [updated] = updater([erroredSession]);

			// Session transitions to busy with AI source — required by thinking pill
			expect(updated.state).toBe('busy');
			expect(updated.busySource).toBe('ai');
			// Prior error fields are wiped so late onAgentError/onExit branches
			// can't re-enter the 'error' state path
			expect(updated.agentError).toBeUndefined();
			expect(updated.agentErrorTabId).toBeUndefined();
			expect(updated.agentErrorPaused).toBe(false);
			// Active tab transitions to busy and its banner error is cleared too
			expect(updated.aiTabs[0].state).toBe('busy');
			expect(updated.aiTabs[0].agentError).toBeUndefined();
		});
	});
});

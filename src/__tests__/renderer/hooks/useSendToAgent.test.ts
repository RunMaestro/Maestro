import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import {
	useSendToAgent,
	useSendToAgentWithSessions,
	type TransferRequest,
} from '../../../renderer/hooks';
import type { Session, AITab, LogEntry, ToolType } from '../../../renderer/types';
import type { SendToAgentOptions } from '../../../renderer/components/SendToAgentModal';
import * as contextGroomer from '../../../renderer/services/contextGroomer';

// Mock the context grooming service
vi.mock('../../../renderer/services/contextGroomer', async () => {
	const actual = await vi.importActual('../../../renderer/services/contextGroomer');
	return {
		...actual,
		contextGroomingService: {
			groomContexts: vi.fn(),
			cancelGrooming: vi.fn(),
			isGroomingActive: vi.fn(() => false),
		},
	};
});

// Mock extractTabContext
vi.mock('../../../renderer/utils/contextExtractor', () => ({
	extractTabContext: vi.fn((tab, name, session) => ({
		type: 'tab',
		sessionId: session.id,
		tabId: tab.id,
		projectRoot: session.projectRoot,
		name: `${name} / ${tab.name || 'Tab'}`,
		logs: tab.logs,
		agentType: session.toolType,
	})),
}));

// Mock createMergedSession
vi.mock('../../../renderer/utils/tabHelpers', () => ({
	createMergedSession: vi.fn(({ name, projectRoot, toolType, mergedLogs }) => ({
		session: {
			id: 'new-session-id',
			name,
			projectRoot,
			toolType,
			state: 'idle',
			cwd: projectRoot,
			fullPath: projectRoot,
			aiTabs: [
				{
					id: 'new-tab-id',
					name: null,
					logs: mergedLogs,
					inputValue: '',
					stagedImages: [],
					createdAt: Date.now(),
					state: 'idle',
					// New fields for context transfer
					pendingMergedContext: undefined,
				},
			],
			activeTabId: 'new-tab-id',
			shellLogs: [],
			workLog: [],
			contextUsage: 0,
			inputMode: 'ai',
			isGitRepo: false,
			aiLogs: [],
			aiPid: 0,
			terminalPid: 0,
			port: 0,
			isLive: false,
			changedFiles: [],
			fileTree: [],
			fileExplorerExpanded: [],
			fileExplorerScrollPos: 0,
			activeTimeMs: 0,
			executionQueue: [],
			closedTabHistory: [],
		},
		tabId: 'new-tab-id',
	})),
	getActiveTab: vi.fn(),
}));

// Create a mock tab
function createMockTab(id: string, logs: LogEntry[] = []): AITab {
	return {
		id,
		name: `Tab ${id}`,
		agentSessionId: `session-${id}`,
		starred: false,
		logs,
		inputValue: '',
		stagedImages: [],
		createdAt: Date.now(),
		state: 'idle',
		saveToHistory: true,
	};
}

// Create a minimal session for testing
function createMockSession(
	id: string,
	toolType: ToolType = 'claude-code',
	state: 'idle' | 'busy' | 'error' | 'connecting' = 'idle'
): Session {
	const tab = createMockTab('tab-1', [
		{ id: 'log-1', timestamp: Date.now(), source: 'user', text: 'Hello' },
		{ id: 'log-2', timestamp: Date.now() + 100, source: 'ai', text: 'Hi there!' },
	]);

	return {
		id,
		name: `Session ${id}`,
		toolType,
		state,
		cwd: '/test/project',
		fullPath: '/test/project',
		projectRoot: '/test/project',
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
		isGitRepo: false,
		fileTree: [],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		activeTimeMs: 0,
		executionQueue: [],
		aiTabs: [tab],
		activeTabId: tab.id,
		closedTabHistory: [],
	};
}

describe('useSendToAgent', () => {
	beforeEach(() => {
		vi.clearAllMocks();

		// Default mock for successful grooming
		vi.mocked(contextGroomer.contextGroomingService.groomContexts).mockResolvedValue({
			groomedLogs: [
				{ id: 'groomed-1', timestamp: Date.now(), source: 'ai', text: 'Groomed context summary' },
			],
			tokensSaved: 50,
			success: true,
		});
	});

	describe('initial state', () => {
		it('starts in idle state', () => {
			const { result } = renderHook(() => useSendToAgent());

			expect(result.current.transferState).toBe('idle');
			expect(result.current.progress).toBeNull();
			expect(result.current.error).toBeNull();
		});

		it('provides startTransfer, cancelTransfer, and reset functions', () => {
			const { result } = renderHook(() => useSendToAgent());

			expect(typeof result.current.startTransfer).toBe('function');
			expect(typeof result.current.cancelTransfer).toBe('function');
			expect(typeof result.current.reset).toBe('function');
		});
	});

	describe('startTransfer', () => {
		it('transitions through grooming and creating states', async () => {
			const { result } = renderHook(() => useSendToAgent());
			const sourceSession = createMockSession('source-1', 'claude-code');
			const request: TransferRequest = {
				sourceSession,
				sourceTabId: 'tab-1',
				targetAgent: 'opencode',
				options: { groomContext: true, createNewSession: true },
			};

			let transferResult;
			await act(async () => {
				transferResult = await result.current.startTransfer(request);
			});

			expect(transferResult).toEqual({
				success: true,
				newSessionId: 'new-session-id',
				newTabId: 'new-tab-id',
				tokensSaved: 50,
			});
		});

		it('returns error when source tab is not found', async () => {
			const { result } = renderHook(() => useSendToAgent());
			const sourceSession = createMockSession('source-1', 'claude-code');
			const request: TransferRequest = {
				sourceSession,
				sourceTabId: 'non-existent-tab',
				targetAgent: 'opencode',
				options: { groomContext: true, createNewSession: true },
			};

			let transferResult;
			await act(async () => {
				transferResult = await result.current.startTransfer(request);
			});

			expect(transferResult.success).toBe(false);
			expect(transferResult.error).toBe('Source tab not found');
			expect(result.current.transferState).toBe('error');
		});

		it('skips grooming when groomContext is false', async () => {
			const { result } = renderHook(() => useSendToAgent());
			const sourceSession = createMockSession('source-1', 'claude-code');
			const request: TransferRequest = {
				sourceSession,
				sourceTabId: 'tab-1',
				targetAgent: 'opencode',
				options: { groomContext: false, createNewSession: true },
			};

			await act(async () => {
				await result.current.startTransfer(request);
			});

			// Should not call grooming service when disabled
			expect(contextGroomer.contextGroomingService.groomContexts).not.toHaveBeenCalled();
			expect(result.current.transferState).toBe('complete');
		});

		it('uses buildContextTransferPrompt for agent-specific grooming', async () => {
			const spy = vi.spyOn(contextGroomer, 'buildContextTransferPrompt');
			const { result } = renderHook(() => useSendToAgent());
			const sourceSession = createMockSession('source-1', 'claude-code');
			const request: TransferRequest = {
				sourceSession,
				sourceTabId: 'tab-1',
				targetAgent: 'gemini-cli',
				options: { groomContext: true, createNewSession: true },
			};

			await act(async () => {
				await result.current.startTransfer(request);
			});

			expect(spy).toHaveBeenCalledWith('claude-code', 'gemini-cli');
		});

		it('handles grooming failure gracefully', async () => {
			vi.mocked(contextGroomer.contextGroomingService.groomContexts).mockResolvedValue({
				groomedLogs: [],
				tokensSaved: 0,
				success: false,
				error: 'Grooming timeout',
			});

			const { result } = renderHook(() => useSendToAgent());
			const sourceSession = createMockSession('source-1', 'claude-code');
			const request: TransferRequest = {
				sourceSession,
				sourceTabId: 'tab-1',
				targetAgent: 'opencode',
				options: { groomContext: true, createNewSession: true },
			};

			let transferResult;
			await act(async () => {
				transferResult = await result.current.startTransfer(request);
			});

			expect(transferResult.success).toBe(false);
			expect(transferResult.error).toBe('Grooming timeout');
			expect(result.current.transferState).toBe('error');
			expect(result.current.error).toBe('Grooming timeout');
		});

		it('updates progress during transfer', async () => {
			let progressCallback: ((p: any) => void) | undefined;
			vi.mocked(contextGroomer.contextGroomingService.groomContexts).mockImplementation(
				async (request, onProgress) => {
					progressCallback = onProgress;
					// Simulate progress updates
					onProgress({ stage: 'grooming', progress: 50, message: 'Processing...' });
					return {
						groomedLogs: [{ id: 'log', timestamp: Date.now(), source: 'ai', text: 'Done' }],
						tokensSaved: 30,
						success: true,
					};
				}
			);

			const { result } = renderHook(() => useSendToAgent());
			const sourceSession = createMockSession('source-1', 'claude-code');

			await act(async () => {
				await result.current.startTransfer({
					sourceSession,
					sourceTabId: 'tab-1',
					targetAgent: 'opencode',
					options: { groomContext: true, createNewSession: true },
				});
			});

			// Progress should be at complete after finish
			expect(result.current.progress?.stage).toBe('complete');
			expect(result.current.progress?.progress).toBe(100);
		});
	});

	describe('cancelTransfer', () => {
		it('cancels an active transfer and resets state', async () => {
			// Set up a slow grooming operation
			vi.mocked(contextGroomer.contextGroomingService.groomContexts).mockImplementation(
				() =>
					new Promise((resolve) =>
						setTimeout(
							() =>
								resolve({
									groomedLogs: [],
									tokensSaved: 0,
									success: true,
								}),
							1000
						)
					)
			);

			const { result } = renderHook(() => useSendToAgent());
			const sourceSession = createMockSession('source-1', 'claude-code');

			// Start transfer without awaiting
			const transferPromise = result.current.startTransfer({
				sourceSession,
				sourceTabId: 'tab-1',
				targetAgent: 'opencode',
				options: { groomContext: true, createNewSession: true },
			});

			// Cancel immediately
			act(() => {
				result.current.cancelTransfer();
			});

			expect(result.current.transferState).toBe('idle');
			expect(result.current.error).toBe('Transfer cancelled by user');
			expect(contextGroomer.contextGroomingService.cancelGrooming).toHaveBeenCalled();
		});
	});

	describe('reset', () => {
		it('resets state to idle', async () => {
			const { result } = renderHook(() => useSendToAgent());
			const sourceSession = createMockSession('source-1', 'claude-code');

			// Complete a transfer
			await act(async () => {
				await result.current.startTransfer({
					sourceSession,
					sourceTabId: 'tab-1',
					targetAgent: 'opencode',
					options: { groomContext: true, createNewSession: true },
				});
			});

			expect(result.current.transferState).toBe('complete');

			// Reset
			act(() => {
				result.current.reset();
			});

			expect(result.current.transferState).toBe('idle');
			expect(result.current.progress).toBeNull();
			expect(result.current.error).toBeNull();
		});
	});

	describe('session name generation', () => {
		it('generates name with arrow format: Source → Target', async () => {
			const { result } = renderHook(() => useSendToAgent());
			const sourceSession = createMockSession('source-1', 'claude-code');
			sourceSession.name = 'My Project';

			await act(async () => {
				await result.current.startTransfer({
					sourceSession,
					sourceTabId: 'tab-1',
					targetAgent: 'opencode',
					options: { groomContext: true, createNewSession: true },
				});
			});

			// The createMergedSession mock captures the name
			const { createMergedSession } = await import('../../../renderer/utils/tabHelpers');
			expect(createMergedSession).toHaveBeenCalledWith(
				expect.objectContaining({
					name: expect.stringContaining('→'),
				})
			);
		});
	});
});

describe('useSendToAgentWithSessions', () => {
	const mockSetSessions = vi.fn();
	const mockOnSessionCreated = vi.fn();
	const mockOnNavigateToSession = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();

		vi.mocked(contextGroomer.contextGroomingService.groomContexts).mockResolvedValue({
			groomedLogs: [
				{ id: 'groomed-1', timestamp: Date.now(), source: 'ai', text: 'Groomed context' },
			],
			tokensSaved: 25,
			success: true,
		});
	});

	it('adds new session to sessions state', async () => {
		const sessions = [createMockSession('existing-1')];

		const { result } = renderHook(() =>
			useSendToAgentWithSessions({
				sessions,
				setSessions: mockSetSessions,
				onSessionCreated: mockOnSessionCreated,
				onNavigateToSession: mockOnNavigateToSession,
			})
		);

		const sourceSession = createMockSession('source-1', 'claude-code');

		await act(async () => {
			await result.current.executeTransfer(sourceSession, 'tab-1', 'opencode', {
				groomContext: true,
				createNewSession: true,
			});
		});

		expect(mockSetSessions).toHaveBeenCalled();
	});

	it('sets autoSendOnActivate flag on new session tab for automatic context injection', async () => {
		const sessions = [createMockSession('existing-1')];

		const { result } = renderHook(() =>
			useSendToAgentWithSessions({
				sessions,
				setSessions: mockSetSessions,
				onSessionCreated: mockOnSessionCreated,
				onNavigateToSession: mockOnNavigateToSession,
			})
		);

		const sourceSession = createMockSession('source-1', 'claude-code');

		await act(async () => {
			await result.current.executeTransfer(sourceSession, 'tab-1', 'opencode', {
				groomContext: true,
				createNewSession: true,
			});
		});

		// Get the session that was added via setSessions
		const setSessionsCall = mockSetSessions.mock.calls.find(
			(call) => typeof call[0] === 'function'
		);
		expect(setSessionsCall).toBeDefined();
		const updateFn = setSessionsCall![0] as (prev: Session[]) => Session[];
		const updatedSessions = updateFn(sessions);
		const newSession = updatedSessions.find((s) => s.id !== 'existing-1');

		expect(newSession).toBeDefined();
		expect(newSession!.aiTabs[0].autoSendOnActivate).toBe(true);
		expect(newSession!.aiTabs[0].pendingMergedContext).toBeDefined();
		expect(newSession!.aiTabs[0].inputValue).toContain('transferring context');
	});

	it('calls onSessionCreated callback with new session info', async () => {
		const sessions = [createMockSession('existing-1')];

		const { result } = renderHook(() =>
			useSendToAgentWithSessions({
				sessions,
				setSessions: mockSetSessions,
				onSessionCreated: mockOnSessionCreated,
				onNavigateToSession: mockOnNavigateToSession,
			})
		);

		const sourceSession = createMockSession('source-1', 'claude-code');
		sourceSession.name = 'Test Project';

		await act(async () => {
			await result.current.executeTransfer(sourceSession, 'tab-1', 'opencode', {
				groomContext: true,
				createNewSession: true,
			});
		});

		expect(mockOnSessionCreated).toHaveBeenCalledWith(
			expect.any(String),
			expect.stringContaining('→')
		);
	});

	it('calls onNavigateToSession when provided', async () => {
		const sessions = [createMockSession('existing-1')];

		const { result } = renderHook(() =>
			useSendToAgentWithSessions({
				sessions,
				setSessions: mockSetSessions,
				onSessionCreated: mockOnSessionCreated,
				onNavigateToSession: mockOnNavigateToSession,
			})
		);

		const sourceSession = createMockSession('source-1', 'claude-code');

		await act(async () => {
			await result.current.executeTransfer(sourceSession, 'tab-1', 'opencode', {
				groomContext: true,
				createNewSession: true,
			});
		});

		expect(mockOnNavigateToSession).toHaveBeenCalled();
	});

	it('returns error when source tab not found', async () => {
		const sessions = [createMockSession('existing-1')];

		const { result } = renderHook(() =>
			useSendToAgentWithSessions({
				sessions,
				setSessions: mockSetSessions,
			})
		);

		const sourceSession = createMockSession('source-1', 'claude-code');

		let transferResult;
		await act(async () => {
			transferResult = await result.current.executeTransfer(
				sourceSession,
				'non-existent-tab',
				'opencode',
				{ groomContext: true, createNewSession: true }
			);
		});

		expect(transferResult.success).toBe(false);
		expect(transferResult.error).toBe('Source tab not found');
		expect(mockSetSessions).not.toHaveBeenCalled();
	});

	it('skips session creation when createNewSession is false', async () => {
		const sessions = [createMockSession('existing-1')];

		const { result } = renderHook(() =>
			useSendToAgentWithSessions({
				sessions,
				setSessions: mockSetSessions,
				onSessionCreated: mockOnSessionCreated,
			})
		);

		const sourceSession = createMockSession('source-1', 'claude-code');

		await act(async () => {
			await result.current.executeTransfer(sourceSession, 'tab-1', 'opencode', {
				groomContext: true,
				createNewSession: false,
			});
		});

		// Should not add session when createNewSession is false
		expect(mockOnSessionCreated).not.toHaveBeenCalled();
	});
});

describe('error handling', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('provides transferError with structured error info', async () => {
		vi.mocked(contextGroomer.contextGroomingService.groomContexts).mockResolvedValue({
			groomedLogs: [],
			tokensSaved: 0,
			success: false,
			error: 'Grooming timed out',
		});

		const { result } = renderHook(() => useSendToAgent());
		const sourceSession = createMockSession('source-1', 'claude-code');

		await act(async () => {
			await result.current.startTransfer({
				sourceSession,
				sourceTabId: 'tab-1',
				targetAgent: 'opencode',
				options: { groomContext: true, createNewSession: true },
			});
		});

		expect(result.current.transferError).not.toBeNull();
		expect(result.current.transferError?.type).toBe('grooming_timeout');
		expect(result.current.transferError?.recoverable).toBe(true);
		expect(result.current.transferError?.sourceAgent).toBe('claude-code');
		expect(result.current.transferError?.targetAgent).toBe('opencode');
	});

	it('stores lastRequest for retry functionality', async () => {
		vi.mocked(contextGroomer.contextGroomingService.groomContexts).mockResolvedValue({
			groomedLogs: [],
			tokensSaved: 0,
			success: false,
			error: 'Network error',
		});

		const { result } = renderHook(() => useSendToAgent());
		const sourceSession = createMockSession('source-1', 'claude-code');
		const options = { groomContext: true, createNewSession: true };

		await act(async () => {
			await result.current.startTransfer({
				sourceSession,
				sourceTabId: 'tab-1',
				targetAgent: 'opencode',
				options,
			});
		});

		expect(result.current.lastRequest).not.toBeNull();
		expect(result.current.lastRequest?.sourceSession.id).toBe('source-1');
		expect(result.current.lastRequest?.targetAgent).toBe('opencode');
		expect(result.current.lastRequest?.options.groomContext).toBe(true);
	});

	it('retryTransfer reuses the last request', async () => {
		// First call fails
		vi.mocked(contextGroomer.contextGroomingService.groomContexts).mockResolvedValueOnce({
			groomedLogs: [],
			tokensSaved: 0,
			success: false,
			error: 'Network error',
		});

		const { result } = renderHook(() => useSendToAgent());
		const sourceSession = createMockSession('source-1', 'claude-code');

		await act(async () => {
			await result.current.startTransfer({
				sourceSession,
				sourceTabId: 'tab-1',
				targetAgent: 'opencode',
				options: { groomContext: true, createNewSession: true },
			});
		});

		expect(result.current.transferState).toBe('error');

		// Mock success for retry
		vi.mocked(contextGroomer.contextGroomingService.groomContexts).mockResolvedValueOnce({
			groomedLogs: [{ id: 'log', timestamp: Date.now(), source: 'ai', text: 'Success!' }],
			tokensSaved: 10,
			success: true,
		});

		let retryResult;
		await act(async () => {
			retryResult = await result.current.retryTransfer();
		});

		expect(retryResult.success).toBe(true);
		expect(result.current.transferState).toBe('complete');
	});

	it('retryWithoutGrooming disables grooming on retry', async () => {
		// First call fails during grooming
		vi.mocked(contextGroomer.contextGroomingService.groomContexts).mockResolvedValueOnce({
			groomedLogs: [],
			tokensSaved: 0,
			success: false,
			error: 'Grooming timeout',
		});

		const { result } = renderHook(() => useSendToAgent());
		const sourceSession = createMockSession('source-1', 'claude-code');

		await act(async () => {
			await result.current.startTransfer({
				sourceSession,
				sourceTabId: 'tab-1',
				targetAgent: 'opencode',
				options: { groomContext: true, createNewSession: true },
			});
		});

		expect(result.current.transferState).toBe('error');

		// Retry without grooming
		let retryResult;
		await act(async () => {
			retryResult = await result.current.retryWithoutGrooming();
		});

		// Should succeed since grooming is skipped
		expect(retryResult.success).toBe(true);
		// Grooming service should not be called again since we skipped it
		expect(contextGroomer.contextGroomingService.groomContexts).toHaveBeenCalledTimes(1);
	});

	it('retryTransfer returns error when no previous request exists', async () => {
		const { result } = renderHook(() => useSendToAgent());

		let retryResult;
		await act(async () => {
			retryResult = await result.current.retryTransfer();
		});

		expect(retryResult.success).toBe(false);
		expect(retryResult.error).toBe('No previous transfer to retry');
	});

	it('retryWithoutGrooming returns error when no previous request exists', async () => {
		const { result } = renderHook(() => useSendToAgent());

		let retryResult;
		await act(async () => {
			retryResult = await result.current.retryWithoutGrooming();
		});

		expect(retryResult.success).toBe(false);
		expect(retryResult.error).toBe('No previous transfer to retry');
	});

	it('classifies source tab not found as source_not_found error', async () => {
		const { result } = renderHook(() => useSendToAgent());
		const sourceSession = createMockSession('source-1', 'claude-code');

		await act(async () => {
			await result.current.startTransfer({
				sourceSession,
				sourceTabId: 'non-existent-tab',
				targetAgent: 'opencode',
				options: { groomContext: true, createNewSession: true },
			});
		});

		expect(result.current.transferError?.type).toBe('source_not_found');
		expect(result.current.transferError?.recoverable).toBe(false);
	});

	it('clears transferError on reset', async () => {
		vi.mocked(contextGroomer.contextGroomingService.groomContexts).mockResolvedValue({
			groomedLogs: [],
			tokensSaved: 0,
			success: false,
			error: 'Some error',
		});

		const { result } = renderHook(() => useSendToAgent());
		const sourceSession = createMockSession('source-1', 'claude-code');

		await act(async () => {
			await result.current.startTransfer({
				sourceSession,
				sourceTabId: 'tab-1',
				targetAgent: 'opencode',
				options: { groomContext: true, createNewSession: true },
			});
		});

		expect(result.current.transferError).not.toBeNull();

		act(() => {
			result.current.reset();
		});

		expect(result.current.transferError).toBeNull();
	});

	it('clears transferError on cancelTransfer', async () => {
		vi.mocked(contextGroomer.contextGroomingService.groomContexts).mockImplementation(
			() => new Promise(() => {}) // Never resolves
		);

		const { result } = renderHook(() => useSendToAgent());
		const sourceSession = createMockSession('source-1', 'claude-code');

		// Start transfer (it will hang)
		result.current.startTransfer({
			sourceSession,
			sourceTabId: 'tab-1',
			targetAgent: 'opencode',
			options: { groomContext: true, createNewSession: true },
		});

		// Cancel
		act(() => {
			result.current.cancelTransfer();
		});

		expect(result.current.transferError).toBeNull();
	});
});

describe('transfer edge cases', () => {
	beforeEach(() => {
		vi.clearAllMocks();

		vi.mocked(contextGroomer.contextGroomingService.groomContexts).mockResolvedValue({
			groomedLogs: [{ id: 'groomed-1', timestamp: Date.now(), source: 'ai', text: 'Groomed' }],
			tokensSaved: 10,
			success: true,
		});
	});

	it('handles transfer to same agent type (should still work)', async () => {
		const { result } = renderHook(() => useSendToAgent());
		const sourceSession = createMockSession('source-1', 'claude-code');

		let transferResult;
		await act(async () => {
			transferResult = await result.current.startTransfer({
				sourceSession,
				sourceTabId: 'tab-1',
				targetAgent: 'claude-code', // Same as source
				options: { groomContext: true, createNewSession: true },
			});
		});

		// Should still succeed - user may want to create a "clean" version
		expect(transferResult.success).toBe(true);
	});

	it('handles session with empty logs', async () => {
		const { result } = renderHook(() => useSendToAgent());
		const sourceSession = createMockSession('source-1', 'claude-code');
		sourceSession.aiTabs[0].logs = []; // Empty logs

		let transferResult;
		await act(async () => {
			transferResult = await result.current.startTransfer({
				sourceSession,
				sourceTabId: 'tab-1',
				targetAgent: 'opencode',
				options: { groomContext: false, createNewSession: true },
			});
		});

		// Transfer should fail for empty context
		expect(transferResult.success).toBe(false);
		expect(transferResult.error).toContain('Cannot transfer empty context');
	});

	it('handles session with long session name', async () => {
		const { result } = renderHook(() => useSendToAgent());
		const sourceSession = createMockSession('source-1', 'claude-code');
		sourceSession.name = 'A'.repeat(200); // Very long name

		let transferResult;
		await act(async () => {
			transferResult = await result.current.startTransfer({
				sourceSession,
				sourceTabId: 'tab-1',
				targetAgent: 'opencode',
				options: { groomContext: false, createNewSession: true },
			});
		});

		expect(transferResult.success).toBe(true);
	});

	it('handles all supported agent types as targets', async () => {
		const targetAgents: ToolType[] = ['opencode', 'factory-droid', 'codex'];

		for (const targetAgent of targetAgents) {
			vi.clearAllMocks();
			vi.mocked(contextGroomer.contextGroomingService.groomContexts).mockResolvedValue({
				groomedLogs: [{ id: 'log', timestamp: Date.now(), source: 'ai', text: 'OK' }],
				tokensSaved: 5,
				success: true,
			});

			const { result } = renderHook(() => useSendToAgent());
			const sourceSession = createMockSession('source-1', 'claude-code');

			let transferResult;
			await act(async () => {
				transferResult = await result.current.startTransfer({
					sourceSession,
					sourceTabId: 'tab-1',
					targetAgent,
					options: { groomContext: true, createNewSession: true },
				});
			});

			expect(transferResult.success).toBe(true);
		}
	});
});

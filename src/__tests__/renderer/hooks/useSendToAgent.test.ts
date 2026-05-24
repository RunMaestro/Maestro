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
import { extractTabContext } from '../../../renderer/utils/contextExtractor';
import { createMergedSession } from '../../../renderer/utils/tabHelpers';
import { useOperationStore } from '../../../renderer/stores/operationStore';

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

beforeEach(() => {
	useOperationStore.getState().resetAll();
	vi.mocked(window.maestro.agents.get).mockResolvedValue({
		available: true,
	} as Awaited<ReturnType<typeof window.maestro.agents.get>>);
	Object.assign(window.maestro, {
		history: {
			add: vi.fn().mockResolvedValue(true),
		},
	});
});

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

		it('handles missing log text while estimating context size', async () => {
			const { result } = renderHook(() => useSendToAgent());
			const sourceSession = createMockSession('source-1', 'claude-code');
			sourceSession.aiTabs[0].logs = [
				{ id: 'missing-text', timestamp: Date.now(), source: 'user', text: undefined as any },
				{ id: 'log-2', timestamp: Date.now() + 1, source: 'ai', text: 'Still transferable' },
			];

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
			expect(createMergedSession).toHaveBeenCalledWith(
				expect.objectContaining({
					mergedLogs: sourceSession.aiTabs[0].logs,
				})
			);
		});

		it('uses the project folder name when the session name is missing', async () => {
			const { result } = renderHook(() => useSendToAgent());
			const sourceSession = createMockSession('source-1', 'claude-code');
			sourceSession.name = '';
			sourceSession.projectRoot = '/workspace/fallback-project';

			await act(async () => {
				await result.current.startTransfer({
					sourceSession,
					sourceTabId: 'tab-1',
					targetAgent: 'opencode',
					options: { groomContext: false, createNewSession: true },
				});
			});

			expect(createMergedSession).toHaveBeenCalledWith(
				expect.objectContaining({
					name: expect.stringContaining('fallback-project'),
				})
			);
		});

		it('uses an unnamed session label when both name and project folder are missing', async () => {
			const { result } = renderHook(() => useSendToAgent());
			const sourceSession = createMockSession('source-1', 'claude-code');
			sourceSession.name = '';
			sourceSession.projectRoot = '';

			await act(async () => {
				await result.current.startTransfer({
					sourceSession,
					sourceTabId: 'tab-1',
					targetAgent: 'opencode',
					options: { groomContext: false, createNewSession: true },
				});
			});

			expect(createMergedSession).toHaveBeenCalledWith(
				expect.objectContaining({
					name: expect.stringContaining('Unnamed Session'),
				})
			);
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

		it('uses a generic grooming error when grooming fails without a message', async () => {
			vi.mocked(contextGroomer.contextGroomingService.groomContexts).mockResolvedValue({
				groomedLogs: [],
				tokensSaved: 0,
				success: false,
			});

			const { result } = renderHook(() => useSendToAgent());
			const sourceSession = createMockSession('source-1', 'claude-code');

			let transferResult;
			await act(async () => {
				transferResult = await result.current.startTransfer({
					sourceSession,
					sourceTabId: 'tab-1',
					targetAgent: 'opencode',
					options: { groomContext: true, createNewSession: true },
				});
			});

			expect(transferResult).toEqual({
				success: false,
				error: 'Context grooming failed',
			});
			expect(result.current.error).toBe('Context grooming failed');
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

		it('preserves non-grooming progress messages from the grooming service', async () => {
			const setTransferStateSpy = vi.spyOn(useOperationStore.getState(), 'setTransferState');
			vi.mocked(contextGroomer.contextGroomingService.groomContexts).mockImplementation(
				async (request, onProgress) => {
					onProgress({ stage: 'collecting', progress: 35, message: 'Collecting source data' });
					return {
						groomedLogs: [{ id: 'log', timestamp: Date.now(), source: 'ai', text: 'Done' }],
						tokensSaved: 5,
						success: true,
					};
				}
			);

			try {
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

				expect(setTransferStateSpy).toHaveBeenCalledWith(
					expect.objectContaining({
						progress: expect.objectContaining({
							stage: 'collecting',
							progress: 35,
							message: 'Collecting source data',
						}),
					})
				);
			} finally {
				setTransferStateSpy.mockRestore();
			}
		});
	});

	describe('cancelTransfer', () => {
		it('cancels an active transfer and resets state', async () => {
			let resolveGrooming!: (value: {
				groomedLogs: LogEntry[];
				tokensSaved: number;
				success: true;
			}) => void;

			vi.mocked(contextGroomer.contextGroomingService.groomContexts).mockImplementation(
				() =>
					new Promise((resolve) => {
						resolveGrooming = resolve;
					})
			);

			const { result } = renderHook(() => useSendToAgent());
			const sourceSession = createMockSession('source-1', 'claude-code');

			let transferPromise!: Promise<unknown>;
			act(() => {
				transferPromise = result.current.startTransfer({
					sourceSession,
					sourceTabId: 'tab-1',
					targetAgent: 'opencode',
					options: { groomContext: true, createNewSession: true },
				});
			});

			await waitFor(() =>
				expect(contextGroomer.contextGroomingService.groomContexts).toHaveBeenCalled()
			);

			// Cancel immediately
			act(() => {
				result.current.cancelTransfer();
			});
			resolveGrooming({ groomedLogs: [], tokensSaved: 0, success: true });
			await act(async () => {
				await transferPromise;
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

	it('handles filtered context and missing active tab when callbacks are omitted', async () => {
		const defaultCreateMergedSession = vi.mocked(createMergedSession).getMockImplementation();
		expect(defaultCreateMergedSession).toBeDefined();
		vi.mocked(createMergedSession).mockImplementationOnce(defaultCreateMergedSession!);
		vi.mocked(createMergedSession).mockImplementationOnce((args) => {
			const created = defaultCreateMergedSession!(args);
			return {
				...created,
				session: {
					...created.session,
					aiTabs: [],
					activeTabId: '',
				},
			};
		});

		const sessions = [createMockSession('existing-1')];
		const sourceSession = createMockSession('source-1', 'claude-code');
		sourceSession.aiTabs[0].logs = [
			{ id: 'system-only', timestamp: Date.now(), source: 'system', text: 'Internal note' },
			{ id: 'blank-user', timestamp: Date.now() + 1, source: 'user', text: '   ' },
		];

		const { result } = renderHook(() =>
			useSendToAgentWithSessions({
				sessions,
				setSessions: mockSetSessions,
			})
		);

		let transferResult;
		await act(async () => {
			transferResult = await result.current.executeTransfer(sourceSession, 'tab-1', 'opencode', {
				groomContext: false,
				createNewSession: true,
			});
		});

		expect(transferResult).toEqual(
			expect.objectContaining({
				success: true,
				newSessionId: 'new-session-id',
				newTabId: '',
			})
		);
		expect(contextGroomer.contextGroomingService.groomContexts).not.toHaveBeenCalled();
		const updateFn = mockSetSessions.mock.calls.at(-1)?.[0] as (prev: Session[]) => Session[];
		const updatedSessions = updateFn(sessions);
		const newSession = updatedSessions.find((s) => s.id === 'new-session-id');
		expect(newSession?.aiTabs).toEqual([]);
	});

	it('logs history failures without failing session creation', async () => {
		const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const historyError = new Error('history unavailable');
		vi.mocked(window.maestro.history.add).mockRejectedValueOnce(historyError);

		try {
			const sessions = [createMockSession('existing-1')];

			const { result } = renderHook(() =>
				useSendToAgentWithSessions({
					sessions,
					setSessions: mockSetSessions,
					onSessionCreated: mockOnSessionCreated,
				})
			);

			const sourceSession = createMockSession('source-1', 'claude-code');

			let transferResult;
			await act(async () => {
				transferResult = await result.current.executeTransfer(sourceSession, 'tab-1', 'opencode', {
					groomContext: true,
					createNewSession: true,
				});
			});

			expect(transferResult.success).toBe(true);
			expect(mockSetSessions).toHaveBeenCalled();
			expect(consoleWarn).toHaveBeenCalledWith(
				'Failed to log transfer operation to history:',
				historyError
			);
		} finally {
			consoleWarn.mockRestore();
		}
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
		let resolveGrooming!: (value: {
			groomedLogs: LogEntry[];
			tokensSaved: number;
			success: true;
		}) => void;
		vi.mocked(contextGroomer.contextGroomingService.groomContexts).mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveGrooming = resolve;
				})
		);

		const { result } = renderHook(() => useSendToAgent());
		const sourceSession = createMockSession('source-1', 'claude-code');

		let transferPromise!: Promise<unknown>;
		act(() => {
			transferPromise = result.current.startTransfer({
				sourceSession,
				sourceTabId: 'tab-1',
				targetAgent: 'opencode',
				options: { groomContext: true, createNewSession: true },
			});
		});

		await waitFor(() =>
			expect(contextGroomer.contextGroomingService.groomContexts).toHaveBeenCalled()
		);

		// Cancel
		act(() => {
			result.current.cancelTransfer();
		});
		resolveGrooming({ groomedLogs: [], tokensSaved: 0, success: true });
		await act(async () => {
			await transferPromise;
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

	it('returns an error without starting when another transfer is already in progress', async () => {
		useOperationStore.getState().setGlobalTransferInProgress(true);

		const { result } = renderHook(() => useSendToAgent());
		const sourceSession = createMockSession('source-1', 'claude-code');

		let transferResult;
		await act(async () => {
			transferResult = await result.current.startTransfer({
				sourceSession,
				sourceTabId: 'tab-1',
				targetAgent: 'opencode',
				options: { groomContext: false, createNewSession: true },
			});
		});

		expect(transferResult).toEqual({
			success: false,
			error: 'A transfer operation is already in progress. Please wait for it to complete.',
		});
		expect(createMergedSession).not.toHaveBeenCalled();
	});

	it('warns but continues when transferring very large context', async () => {
		const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

		try {
			const { result } = renderHook(() => useSendToAgent());
			const sourceSession = createMockSession('source-1', 'claude-code');
			sourceSession.aiTabs[0].logs = [
				{
					id: 'large-log',
					timestamp: Date.now(),
					source: 'user',
					text: 'x'.repeat(400004),
				},
			];

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
			expect(consoleWarn).toHaveBeenCalledWith(expect.stringContaining('Large context transfer'));
		} finally {
			consoleWarn.mockRestore();
		}
	});

	it('warns but continues when agent availability cannot be verified', async () => {
		const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		vi.mocked(window.maestro.agents.get).mockResolvedValueOnce(null);

		try {
			const { result } = renderHook(() => useSendToAgent());
			const sourceSession = createMockSession('source-1', 'claude-code');

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
			expect(consoleWarn).toHaveBeenCalledWith(
				'Could not verify agent availability:',
				expect.any(Error)
			);
		} finally {
			consoleWarn.mockRestore();
		}
	});

	it('returns cancellation when cancelled after agent availability check', async () => {
		const { result } = renderHook(() => useSendToAgent());
		const sourceSession = createMockSession('source-1', 'claude-code');

		vi.mocked(window.maestro.agents.get).mockImplementationOnce(async () => {
			result.current.cancelTransfer();
			return {
				available: true,
			} as Awaited<ReturnType<typeof window.maestro.agents.get>>;
		});

		let transferResult;
		await act(async () => {
			transferResult = await result.current.startTransfer({
				sourceSession,
				sourceTabId: 'tab-1',
				targetAgent: 'opencode',
				options: { groomContext: false, createNewSession: true },
			});
		});

		expect(transferResult).toEqual({ success: false, error: 'Transfer cancelled' });
		expect(extractTabContext).not.toHaveBeenCalled();
	});

	it('returns cancellation when cancelled after context extraction', async () => {
		const { result } = renderHook(() => useSendToAgent());
		const sourceSession = createMockSession('source-1', 'claude-code');

		vi.mocked(extractTabContext).mockImplementationOnce((tab, name, session) => {
			result.current.cancelTransfer();
			return {
				type: 'tab',
				sessionId: session.id,
				tabId: tab.id,
				projectRoot: session.projectRoot,
				name: `${name} / ${tab.name || 'Tab'}`,
				logs: tab.logs,
				agentType: session.toolType,
			};
		});

		let transferResult;
		await act(async () => {
			transferResult = await result.current.startTransfer({
				sourceSession,
				sourceTabId: 'tab-1',
				targetAgent: 'opencode',
				options: { groomContext: false, createNewSession: true },
			});
		});

		expect(transferResult).toEqual({ success: false, error: 'Transfer cancelled' });
		expect(createMergedSession).not.toHaveBeenCalled();
	});

	it('returns cancellation when cancelled while preparing raw context', async () => {
		const { result } = renderHook(() => useSendToAgent());
		const sourceSession = createMockSession('source-1', 'claude-code');

		vi.mocked(extractTabContext).mockImplementationOnce((tab, name, session) => ({
			type: 'tab',
			sessionId: session.id,
			tabId: tab.id,
			projectRoot: session.projectRoot,
			name: `${name} / ${tab.name || 'Tab'}`,
			get logs() {
				result.current.cancelTransfer();
				return tab.logs;
			},
			agentType: session.toolType,
		}));

		let transferResult;
		await act(async () => {
			transferResult = await result.current.startTransfer({
				sourceSession,
				sourceTabId: 'tab-1',
				targetAgent: 'opencode',
				options: { groomContext: false, createNewSession: true },
			});
		});

		expect(transferResult).toEqual({ success: false, error: 'Transfer cancelled' });
		expect(createMergedSession).not.toHaveBeenCalled();
	});

	it('returns cancellation when cancelled after grooming completes', async () => {
		vi.mocked(contextGroomer.contextGroomingService.groomContexts).mockImplementationOnce(
			async () => {
				result.current.cancelTransfer();
				return {
					groomedLogs: [{ id: 'log', timestamp: Date.now(), source: 'ai', text: 'Done' }],
					tokensSaved: 5,
					success: true,
				};
			}
		);

		const { result } = renderHook(() => useSendToAgent());
		const sourceSession = createMockSession('source-1', 'claude-code');

		let transferResult;
		await act(async () => {
			transferResult = await result.current.startTransfer({
				sourceSession,
				sourceTabId: 'tab-1',
				targetAgent: 'opencode',
				options: { groomContext: true, createNewSession: true },
			});
		});

		expect(transferResult).toEqual({ success: false, error: 'Transfer cancelled' });
		expect(createMergedSession).not.toHaveBeenCalled();
	});

	it('classifies non-Error transfer failures with the fallback message', async () => {
		vi.mocked(createMergedSession).mockImplementationOnce(() => {
			throw 'non-error failure';
		});

		const { result } = renderHook(() => useSendToAgent());
		const sourceSession = createMockSession('source-1', 'claude-code');

		let transferResult;
		await act(async () => {
			transferResult = await result.current.startTransfer({
				sourceSession,
				sourceTabId: 'tab-1',
				targetAgent: 'opencode',
				options: { groomContext: false, createNewSession: true },
			});
		});

		expect(transferResult).toEqual({
			success: false,
			error: 'Unknown error during transfer',
		});
		expect(result.current.transferState).toBe('error');
		expect(result.current.error).toBe('Unknown error during transfer');
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

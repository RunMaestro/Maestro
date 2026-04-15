/**
 * Integration tests for useMergeTransferHandlers.ts - Windows stdin transport flags
 *
 * These tests verify that the handleSendToAgent spawn path correctly passes
 * stdin transport flags to window.maestro.process.spawn on Windows, avoiding
 * command line length limits (~8KB cmd.exe).
 *
 * Context transfer prompts include the full conversation history from the
 * source tab, which can easily exceed the ~8KB cmd.exe limit on Windows.
 *
 * Unlike unit tests that call getStdinFlags in isolation, these tests exercise
 * the real hook handler and assert on the actual spawn call arguments.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import type { Session } from '../../../renderer/types';

// ============================================================================
// Mock modules BEFORE importing the hook
// ============================================================================

// Mock useMergeSessionWithSessions (required by hook)
const mockExecuteMerge = vi.fn().mockResolvedValue({ success: true });
vi.mock('../../../renderer/hooks/agent/useMergeSession', () => ({
	useMergeSessionWithSessions: vi.fn((deps: any) => ({
		mergeState: 'idle',
		progress: null,
		error: null,
		startTime: 0,
		sourceName: undefined,
		targetName: undefined,
		executeMerge: mockExecuteMerge,
		cancelTab: vi.fn(),
		cancelMerge: vi.fn(),
		clearTabState: vi.fn(),
		reset: vi.fn(),
		isMergeInProgress: false,
		getTabMergeState: vi.fn(),
		isAnyMerging: false,
		startMerge: vi.fn(),
	})),
}));

// Mock useSendToAgentWithSessions (required by hook)
vi.mock('../../../renderer/hooks/agent/useSendToAgent', () => ({
	useSendToAgentWithSessions: vi.fn((deps: any) => ({
		transferState: 'idle',
		progress: null,
		error: null,
		transferError: null,
		isTransferInProgress: false,
		executeTransfer: vi.fn(),
		cancelTransfer: vi.fn(),
		reset: vi.fn(),
		startTransfer: vi.fn(),
		retryTransfer: vi.fn(),
		retryWithoutGrooming: vi.fn(),
	})),
}));

// Mock modalStore
vi.mock('../../../renderer/stores/modalStore', () => ({
	getModalActions: () => ({
		setMergeSessionModalOpen: vi.fn(),
		setSendToAgentModalOpen: vi.fn(),
	}),
}));

// Mock notificationStore
vi.mock('../../../renderer/stores/notificationStore', () => ({
	notifyToast: vi.fn(),
}));

// Mock other dependencies
vi.mock('../../../renderer/utils/templateVariables', () => ({
	substituteTemplateVariables: vi.fn((prompt: string) => prompt),
}));

vi.mock('../../../renderer/services/git', () => ({
	gitService: {
		getStatus: vi.fn().mockResolvedValue({ branch: 'main' }),
	},
}));

vi.mock('../../../prompts', () => ({
	maestroSystemPrompt: 'Mock system prompt',
	commitCommandPrompt: 'Mock commit prompt',
	autorunSynopsisPrompt: 'Mock synopsis prompt',
}));

vi.mock('../../../renderer/utils/sentry', () => ({
	captureException: vi.fn(),
}));

// ============================================================================
// Now import the hook and stores
// ============================================================================

import {
	useMergeTransferHandlers,
	type UseMergeTransferHandlersDeps,
} from '../../../renderer/hooks/agent/useMergeTransferHandlers';
import { useSessionStore } from '../../../renderer/stores/sessionStore';

// ============================================================================
// Helpers
// ============================================================================

function createMockSession(overrides: Partial<Session> = {}): Session {
	return {
		id: 'session-1',
		name: 'Test Agent',
		state: 'idle',
		busySource: undefined,
		toolType: 'claude-code',
		aiTabs: [
			{
				id: 'tab-1',
				name: 'Tab 1',
				inputValue: '',
				data: [],
				logs: [
					{ id: 'log-1', timestamp: Date.now(), source: 'user', text: 'Hello' },
					{ id: 'log-2', timestamp: Date.now(), source: 'ai', text: 'Hi there' },
				],
				stagedImages: [],
				agentSessionId: 'agent-1',
				starred: false,
				createdAt: Date.now(),
			},
		],
		activeTabId: 'tab-1',
		inputMode: 'ai',
		isGitRepo: false,
		cwd: '/test',
		projectRoot: '/test/project',
		shellLogs: [],
		shellCwd: '/test',
		terminalTabs: [],
		activeTerminalTabId: null,
		...overrides,
	} as unknown as Session;
}

// Stable deps to avoid reference changes between renders
const stableDeps: UseMergeTransferHandlersDeps = {
	sessionsRef: { current: [] },
	activeSessionIdRef: { current: 'session-1' },
	setActiveSessionId: vi.fn(),
};

function createMockDeps(
	overrides: Partial<UseMergeTransferHandlersDeps> = {}
): UseMergeTransferHandlersDeps {
	return {
		...stableDeps,
		...overrides,
	};
}

// ============================================================================
// Setup & Teardown
// ============================================================================

beforeEach(() => {
	vi.clearAllMocks();

	const sourceSession = createMockSession();
	const targetSession = createMockSession({
		id: 'target-session',
		name: 'Target Agent',
		toolType: 'claude-code',
	});

	useSessionStore.setState({
		sessions: [sourceSession, targetSession],
		activeSessionId: 'session-1',
		sessionsLoaded: true,
	});

	stableDeps.sessionsRef.current = [sourceSession, targetSession];
	stableDeps.activeSessionIdRef.current = 'session-1';
	(stableDeps.setActiveSessionId as ReturnType<typeof vi.fn>).mockReset();

	// Mock window.maestro APIs with platform set to win32 for stdin tests
	(window as any).maestro = {
		platform: 'win32',
		notification: { show: vi.fn() },
		agents: {
			get: vi.fn().mockResolvedValue({
				id: 'claude-code',
				command: 'claude',
				args: [],
				path: '/usr/bin/claude',
				capabilities: { supportsStreamJsonInput: true },
			}),
		},
		process: {
			spawn: vi.fn().mockResolvedValue(undefined),
		},
		prompts: {
			get: vi.fn().mockResolvedValue({
				success: true,
				content: 'Maestro System Context: {{AGENT_NAME}}',
			}),
		},
		history: {
			getFilePath: vi.fn().mockResolvedValue(null),
		},
	};
});

afterEach(() => {
	cleanup();
	// Restore platform to default
	if ((window as any).maestro) {
		(window as any).maestro.platform = 'darwin';
	}
});

// ============================================================================
// Tests
// ============================================================================

describe('useMergeTransferHandlers - context transfer stdin flags (integration)', () => {
	it('should pass sendPromptViaStdinRaw=true in spawn call on Windows without SSH', async () => {
		const deps = createMockDeps();
		const { result } = renderHook(() => useMergeTransferHandlers(deps));

		await act(async () => {
			const sendResult = await result.current.handleSendToAgent('target-session', {
				groomContext: false,
			} as any);
			expect(sendResult.success).toBe(true);
		});

		// Wait for the fire-and-forget async IIFE spawn to execute
		await vi.waitFor(() => {
			expect((window as any).maestro.process.spawn).toHaveBeenCalled();
		});

		const spawnCall = (window as any).maestro.process.spawn.mock.calls[0][0];

		// On Windows without SSH, text-only prompts use raw stdin
		expect(spawnCall.sendPromptViaStdinRaw).toBe(true);
		expect(spawnCall.sendPromptViaStdin).toBe(false);
	});

	it('should pass both stdin flags as false for SSH sessions on Windows', async () => {
		// Configure target session with SSH
		const sourceSession = createMockSession();
		const targetSession = createMockSession({
			id: 'target-session',
			name: 'Remote Agent',
			toolType: 'claude-code',
			sessionSshRemoteConfig: {
				enabled: true,
				remoteId: 'test-remote',
			},
		});

		useSessionStore.setState({
			sessions: [sourceSession, targetSession],
			activeSessionId: 'session-1',
			sessionsLoaded: true,
		});
		stableDeps.sessionsRef.current = [sourceSession, targetSession];

		const deps = createMockDeps();
		const { result } = renderHook(() => useMergeTransferHandlers(deps));

		await act(async () => {
			const sendResult = await result.current.handleSendToAgent('target-session', {
				groomContext: false,
			} as any);
			expect(sendResult.success).toBe(true);
		});

		await vi.waitFor(() => {
			expect((window as any).maestro.process.spawn).toHaveBeenCalled();
		});

		const spawnCall = (window as any).maestro.process.spawn.mock.calls[0][0];

		// SSH sessions must NOT use stdin flags
		expect(spawnCall.sendPromptViaStdin).toBe(false);
		expect(spawnCall.sendPromptViaStdinRaw).toBe(false);
	});

	it('should pass both stdin flags as false on non-Windows platforms', async () => {
		(window as any).maestro.platform = 'darwin';

		const deps = createMockDeps();
		const { result } = renderHook(() => useMergeTransferHandlers(deps));

		await act(async () => {
			const sendResult = await result.current.handleSendToAgent('target-session', {
				groomContext: false,
			} as any);
			expect(sendResult.success).toBe(true);
		});

		await vi.waitFor(() => {
			expect((window as any).maestro.process.spawn).toHaveBeenCalled();
		});

		const spawnCall = (window as any).maestro.process.spawn.mock.calls[0][0];

		expect(spawnCall.sendPromptViaStdin).toBe(false);
		expect(spawnCall.sendPromptViaStdinRaw).toBe(false);
	});

	it('should pass sendPromptViaStdinRaw for agents without stream-json support', async () => {
		(window as any).maestro.agents.get.mockResolvedValue({
			id: 'codex',
			command: 'codex',
			args: [],
			path: '/usr/bin/codex',
			capabilities: { supportsStreamJsonInput: false },
		});

		const deps = createMockDeps();
		const { result } = renderHook(() => useMergeTransferHandlers(deps));

		await act(async () => {
			const sendResult = await result.current.handleSendToAgent('target-session', {
				groomContext: false,
			} as any);
			expect(sendResult.success).toBe(true);
		});

		await vi.waitFor(() => {
			expect((window as any).maestro.process.spawn).toHaveBeenCalled();
		});

		const spawnCall = (window as any).maestro.process.spawn.mock.calls[0][0];

		// Agents without stream-json always use raw stdin on Windows
		expect(spawnCall.sendPromptViaStdinRaw).toBe(true);
		expect(spawnCall.sendPromptViaStdin).toBe(false);
	});

	it('should always pass hasImages=false for context transfer (sendPromptViaStdin is false)', async () => {
		// Context transfer never sends images, so sendPromptViaStdin should always be false
		// even when the agent supports stream-json input
		(window as any).maestro.agents.get.mockResolvedValue({
			id: 'claude-code',
			command: 'claude',
			args: [],
			path: '/usr/bin/claude',
			capabilities: { supportsStreamJsonInput: true },
		});

		const deps = createMockDeps();
		const { result } = renderHook(() => useMergeTransferHandlers(deps));

		await act(async () => {
			const sendResult = await result.current.handleSendToAgent('target-session', {
				groomContext: false,
			} as any);
			expect(sendResult.success).toBe(true);
		});

		await vi.waitFor(() => {
			expect((window as any).maestro.process.spawn).toHaveBeenCalled();
		});

		const spawnCall = (window as any).maestro.process.spawn.mock.calls[0][0];

		// sendPromptViaStdin requires hasImages=true, which context transfer never sets
		expect(spawnCall.sendPromptViaStdin).toBe(false);
		// Raw stdin should be used instead on Windows
		expect(spawnCall.sendPromptViaStdinRaw).toBe(true);
	});
});

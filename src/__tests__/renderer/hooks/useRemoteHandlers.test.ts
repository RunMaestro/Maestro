/**
 * Tests for useRemoteHandlers hook (Phase 2K extraction from App.tsx)
 *
 * Tests cover:
 * - Hook initialization and return shape
 * - sessionSshRemoteNames memo (SSH name mapping)
 * - handleQuickActionsToggleRemoteControl (live mode toggle)
 * - handleRemoteCommand event listener (terminal + AI dispatching)
 * - Remote slash command handling
 * - Error handling in remote commands
 * - Return value stability
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import type { Session, CustomAICommand } from '../../../renderer/types';

// ============================================================================
// Mock modules BEFORE importing the hook
// ============================================================================

vi.mock('../../../renderer/utils/ids', () => ({
	generateId: vi.fn(() => 'mock-id-' + Math.random().toString(36).slice(2, 8)),
}));

vi.mock('../../../renderer/utils/templateVariables', () => ({
	substituteTemplateVariables: vi.fn((prompt: string) => prompt),
}));

vi.mock('../../../renderer/services/git', () => ({
	gitService: {
		getStatus: vi.fn().mockResolvedValue({ branch: 'main' }),
		getDiff: vi.fn().mockResolvedValue({ diff: '' }),
	},
}));

vi.mock('../../../renderer/utils/tabHelpers', () => ({
	getActiveTab: vi.fn((session: Session) => {
		if (!session?.aiTabs?.length) return null;
		return session.aiTabs.find((t: any) => t.id === session.activeTabId) || session.aiTabs[0];
	}),
}));

// ============================================================================
// Now import the hook and stores
// ============================================================================

import {
	useRemoteHandlers,
	type UseRemoteHandlersDeps,
} from '../../../renderer/hooks/remote/useRemoteHandlers';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { useUIStore } from '../../../renderer/stores/uiStore';

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
				logs: [],
				stagedImages: [],
			},
		],
		activeTabId: 'tab-1',
		inputMode: 'ai',
		isGitRepo: false,
		cwd: '/test',
		projectRoot: '/test',
		shellLogs: [],
		shellCwd: '/test',
		terminalDraftInput: '',
		terminalTabs: [],
		activeTerminalTabId: null,
		...overrides,
	} as Session;
}

function createMockDeps(overrides: Partial<UseRemoteHandlersDeps> = {}): UseRemoteHandlersDeps {
	return {
		sessionsRef: { current: [createMockSession()] },
		customAICommandsRef: { current: [] },
		speckitCommandsRef: { current: [] },
		openspecCommandsRef: { current: [] },
		toggleGlobalLive: vi.fn().mockResolvedValue(undefined),
		isLiveMode: false,
		sshRemoteConfigs: [],
		...overrides,
	};
}

// ============================================================================
// Setup / Teardown
// ============================================================================

beforeEach(() => {
	vi.clearAllMocks();

	// Reset stores
	const session = createMockSession();
	useSessionStore.setState({
		sessions: [session],
		activeSessionId: 'session-1',
	} as any);

	useSettingsStore.setState({
		conductorProfile: 'default',
	} as any);

	useUIStore.setState({
		setSuccessFlashNotification: vi.fn(),
	} as any);

	// Mock window.maestro APIs
	(window as any).maestro = {
		process: {
			spawn: vi.fn().mockResolvedValue(undefined),
			runCommand: vi.fn().mockResolvedValue(undefined),
		},
		agents: {
			get: vi.fn().mockResolvedValue({
				command: 'claude',
				path: '/usr/local/bin/claude',
				args: [],
			}),
		},
	};

	// Spy on addEventListener/removeEventListener for event listener tests
	vi.spyOn(window, 'addEventListener');
	vi.spyOn(window, 'removeEventListener');
});

afterEach(() => {
	cleanup();
});

// ============================================================================
// Tests
// ============================================================================

describe('useRemoteHandlers', () => {
	// ========================================================================
	// Initialization & return shape
	// ========================================================================

	describe('initialization', () => {
		it('returns all expected properties', () => {
			const { result } = renderHook(() => useRemoteHandlers(createMockDeps()));

			expect(result.current).toHaveProperty('handleQuickActionsToggleRemoteControl');
			expect(result.current).toHaveProperty('sessionSshRemoteNames');
		});

		it('handleQuickActionsToggleRemoteControl is a function', () => {
			const { result } = renderHook(() => useRemoteHandlers(createMockDeps()));
			expect(typeof result.current.handleQuickActionsToggleRemoteControl).toBe('function');
		});

		it('sessionSshRemoteNames is a Map', () => {
			const { result } = renderHook(() => useRemoteHandlers(createMockDeps()));
			expect(result.current.sessionSshRemoteNames).toBeInstanceOf(Map);
		});
	});

	// ========================================================================
	// sessionSshRemoteNames
	// ========================================================================

	describe('sessionSshRemoteNames', () => {
		it('returns empty map when no sessions have SSH config', () => {
			const { result } = renderHook(() => useRemoteHandlers(createMockDeps()));
			expect(result.current.sessionSshRemoteNames.size).toBe(0);
		});

		it('maps session names to SSH remote config names', () => {
			const session = createMockSession({
				name: 'My Agent',
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: 'remote-1',
				},
			});

			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'session-1',
			} as any);

			const deps = createMockDeps({
				sshRemoteConfigs: [{ id: 'remote-1', name: 'Production Server' }],
			});

			const { result } = renderHook(() => useRemoteHandlers(deps));

			expect(result.current.sessionSshRemoteNames.size).toBe(1);
			expect(result.current.sessionSshRemoteNames.get('My Agent')).toBe('Production Server');
		});

		it('skips sessions without enabled SSH config', () => {
			const session = createMockSession({
				name: 'Local Agent',
				sessionSshRemoteConfig: {
					enabled: false,
					remoteId: 'remote-1',
				},
			});

			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'session-1',
			} as any);

			const deps = createMockDeps({
				sshRemoteConfigs: [{ id: 'remote-1', name: 'Server' }],
			});

			const { result } = renderHook(() => useRemoteHandlers(deps));
			expect(result.current.sessionSshRemoteNames.size).toBe(0);
		});

		it('skips sessions with no matching SSH config', () => {
			const session = createMockSession({
				name: 'My Agent',
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: 'nonexistent',
				},
			});

			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'session-1',
			} as any);

			const deps = createMockDeps({
				sshRemoteConfigs: [{ id: 'remote-1', name: 'Server' }],
			});

			const { result } = renderHook(() => useRemoteHandlers(deps));
			expect(result.current.sessionSshRemoteNames.size).toBe(0);
		});

		it('maps multiple sessions to their SSH configs', () => {
			const sessions = [
				createMockSession({
					id: 's1',
					name: 'Agent A',
					sessionSshRemoteConfig: { enabled: true, remoteId: 'r1' },
				}),
				createMockSession({
					id: 's2',
					name: 'Agent B',
					sessionSshRemoteConfig: { enabled: true, remoteId: 'r2' },
				}),
				createMockSession({
					id: 's3',
					name: 'Local Agent',
				}),
			];

			useSessionStore.setState({
				sessions,
				activeSessionId: 's1',
			} as any);

			const deps = createMockDeps({
				sshRemoteConfigs: [
					{ id: 'r1', name: 'Prod' },
					{ id: 'r2', name: 'Staging' },
				],
			});

			const { result } = renderHook(() => useRemoteHandlers(deps));

			expect(result.current.sessionSshRemoteNames.size).toBe(2);
			expect(result.current.sessionSshRemoteNames.get('Agent A')).toBe('Prod');
			expect(result.current.sessionSshRemoteNames.get('Agent B')).toBe('Staging');
		});
	});

	// ========================================================================
	// handleQuickActionsToggleRemoteControl
	// ========================================================================

	describe('handleQuickActionsToggleRemoteControl', () => {
		it('calls toggleGlobalLive', async () => {
			const mockToggle = vi.fn().mockResolvedValue(undefined);
			const deps = createMockDeps({ toggleGlobalLive: mockToggle });

			const { result } = renderHook(() => useRemoteHandlers(deps));

			await act(async () => {
				await result.current.handleQuickActionsToggleRemoteControl();
			});

			expect(mockToggle).toHaveBeenCalledOnce();
		});

		it('shows LIVE notification when enabling', async () => {
			const mockSetFlash = vi.fn();
			useUIStore.setState({ setSuccessFlashNotification: mockSetFlash } as any);

			const deps = createMockDeps({ isLiveMode: false });
			const { result } = renderHook(() => useRemoteHandlers(deps));

			await act(async () => {
				await result.current.handleQuickActionsToggleRemoteControl();
			});

			expect(mockSetFlash).toHaveBeenCalledWith(expect.stringContaining('LIVE'));
		});

		it('shows OFFLINE notification when disabling', async () => {
			const mockSetFlash = vi.fn();
			useUIStore.setState({ setSuccessFlashNotification: mockSetFlash } as any);

			const deps = createMockDeps({ isLiveMode: true });
			const { result } = renderHook(() => useRemoteHandlers(deps));

			await act(async () => {
				await result.current.handleQuickActionsToggleRemoteControl();
			});

			expect(mockSetFlash).toHaveBeenCalledWith(expect.stringContaining('OFFLINE'));
		});
	});

	// ========================================================================
	// handleRemoteCommand event listener
	// ========================================================================

	describe('handleRemoteCommand event listener', () => {
		it('registers event listener on mount and removes on unmount', () => {
			const { unmount } = renderHook(() => useRemoteHandlers(createMockDeps()));

			expect(window.addEventListener).toHaveBeenCalledWith(
				'maestro:remoteCommand',
				expect.any(Function)
			);

			unmount();

			expect(window.removeEventListener).toHaveBeenCalledWith(
				'maestro:remoteCommand',
				expect.any(Function)
			);
		});

		it('dispatches terminal commands via runCommand', async () => {
			const session = createMockSession({ inputMode: 'terminal' });
			const deps = createMockDeps({
				sessionsRef: { current: [session] },
			});

			renderHook(() => useRemoteHandlers(deps));

			// Get the registered event handler
			const addListenerCall = (window.addEventListener as any).mock.calls.find(
				(call: any[]) => call[0] === 'maestro:remoteCommand'
			);
			const handler = addListenerCall[1];

			// Dispatch a terminal command
			await act(async () => {
				await handler(
					new CustomEvent('maestro:remoteCommand', {
						detail: {
							sessionId: 'session-1',
							command: 'ls -la',
							inputMode: 'terminal',
						},
					})
				);
			});

			expect(window.maestro.process.runCommand).toHaveBeenCalledWith(
				expect.objectContaining({
					sessionId: 'session-1',
					command: 'ls -la',
				})
			);
		});

		it('dispatches AI commands via spawn', async () => {
			const session = createMockSession({ inputMode: 'ai' });
			const deps = createMockDeps({
				sessionsRef: { current: [session] },
			});

			renderHook(() => useRemoteHandlers(deps));

			const addListenerCall = (window.addEventListener as any).mock.calls.find(
				(call: any[]) => call[0] === 'maestro:remoteCommand'
			);
			const handler = addListenerCall[1];

			await act(async () => {
				await handler(
					new CustomEvent('maestro:remoteCommand', {
						detail: {
							sessionId: 'session-1',
							command: 'explain this code',
							inputMode: 'ai',
						},
					})
				);
			});

			expect(window.maestro.process.spawn).toHaveBeenCalledWith(
				expect.objectContaining({
					prompt: 'explain this code',
				})
			);
		});

		it('ignores command when session not found', async () => {
			const deps = createMockDeps({
				sessionsRef: { current: [] },
			});

			renderHook(() => useRemoteHandlers(deps));

			const addListenerCall = (window.addEventListener as any).mock.calls.find(
				(call: any[]) => call[0] === 'maestro:remoteCommand'
			);
			const handler = addListenerCall[1];

			await act(async () => {
				await handler(
					new CustomEvent('maestro:remoteCommand', {
						detail: {
							sessionId: 'nonexistent',
							command: 'test',
						},
					})
				);
			});

			expect(window.maestro.process.spawn).not.toHaveBeenCalled();
			expect(window.maestro.process.runCommand).not.toHaveBeenCalled();
		});

		it('skips AI commands for busy sessions', async () => {
			const session = createMockSession({ state: 'busy', inputMode: 'ai' });
			const deps = createMockDeps({
				sessionsRef: { current: [session] },
			});

			renderHook(() => useRemoteHandlers(deps));

			const addListenerCall = (window.addEventListener as any).mock.calls.find(
				(call: any[]) => call[0] === 'maestro:remoteCommand'
			);
			const handler = addListenerCall[1];

			await act(async () => {
				await handler(
					new CustomEvent('maestro:remoteCommand', {
						detail: {
							sessionId: 'session-1',
							command: 'test',
							inputMode: 'ai',
						},
					})
				);
			});

			expect(window.maestro.process.spawn).not.toHaveBeenCalled();
		});

		it('skips unsupported agent types for AI mode', async () => {
			const session = createMockSession({
				inputMode: 'ai',
				toolType: 'terminal' as any,
			});
			const deps = createMockDeps({
				sessionsRef: { current: [session] },
			});

			renderHook(() => useRemoteHandlers(deps));

			const addListenerCall = (window.addEventListener as any).mock.calls.find(
				(call: any[]) => call[0] === 'maestro:remoteCommand'
			);
			const handler = addListenerCall[1];

			await act(async () => {
				await handler(
					new CustomEvent('maestro:remoteCommand', {
						detail: {
							sessionId: 'session-1',
							command: 'test',
							inputMode: 'ai',
						},
					})
				);
			});

			expect(window.maestro.process.spawn).not.toHaveBeenCalled();
		});

		it('handles slash commands by looking up custom commands', async () => {
			const customCommand: CustomAICommand = {
				command: '/deploy',
				description: 'Deploy the app',
				prompt: 'Deploy the application to production',
			};

			const session = createMockSession({ inputMode: 'ai' });
			const deps = createMockDeps({
				sessionsRef: { current: [session] },
				customAICommandsRef: { current: [customCommand] },
			});

			renderHook(() => useRemoteHandlers(deps));

			const addListenerCall = (window.addEventListener as any).mock.calls.find(
				(call: any[]) => call[0] === 'maestro:remoteCommand'
			);
			const handler = addListenerCall[1];

			await act(async () => {
				await handler(
					new CustomEvent('maestro:remoteCommand', {
						detail: {
							sessionId: 'session-1',
							command: '/deploy',
							inputMode: 'ai',
						},
					})
				);
			});

			expect(window.maestro.process.spawn).toHaveBeenCalledWith(
				expect.objectContaining({
					prompt: 'Deploy the application to production',
				})
			);
		});

		it('uses SSH remote CWD for terminal commands on remote sessions', async () => {
			const session = createMockSession({
				inputMode: 'terminal',
				sshRemoteId: 'remote-1',
				remoteCwd: '/remote/path',
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: 'remote-1',
				},
			});
			const deps = createMockDeps({
				sessionsRef: { current: [session] },
			});

			renderHook(() => useRemoteHandlers(deps));

			const addListenerCall = (window.addEventListener as any).mock.calls.find(
				(call: any[]) => call[0] === 'maestro:remoteCommand'
			);
			const handler = addListenerCall[1];

			await act(async () => {
				await handler(
					new CustomEvent('maestro:remoteCommand', {
						detail: {
							sessionId: 'session-1',
							command: 'pwd',
							inputMode: 'terminal',
						},
					})
				);
			});

			expect(window.maestro.process.runCommand).toHaveBeenCalledWith(
				expect.objectContaining({
					cwd: '/remote/path',
				})
			);
		});

		it('sets session state to busy when dispatching terminal command', async () => {
			const session = createMockSession({ inputMode: 'terminal' });
			const deps = createMockDeps({
				sessionsRef: { current: [session] },
			});

			renderHook(() => useRemoteHandlers(deps));

			const addListenerCall = (window.addEventListener as any).mock.calls.find(
				(call: any[]) => call[0] === 'maestro:remoteCommand'
			);
			const handler = addListenerCall[1];

			await act(async () => {
				await handler(
					new CustomEvent('maestro:remoteCommand', {
						detail: {
							sessionId: 'session-1',
							command: 'ls',
							inputMode: 'terminal',
						},
					})
				);
			});

			const sessions = useSessionStore.getState().sessions;
			const updatedSession = sessions.find((s) => s.id === 'session-1');
			expect(updatedSession?.state).toBe('busy');
			expect(updatedSession?.busySource).toBe('terminal');
		});

		it('handles terminal command errors gracefully', async () => {
			(window.maestro.process.runCommand as any).mockRejectedValue(new Error('Connection refused'));

			const session = createMockSession({ inputMode: 'terminal' });
			const deps = createMockDeps({
				sessionsRef: { current: [session] },
			});

			renderHook(() => useRemoteHandlers(deps));

			const addListenerCall = (window.addEventListener as any).mock.calls.find(
				(call: any[]) => call[0] === 'maestro:remoteCommand'
			);
			const handler = addListenerCall[1];

			await act(async () => {
				await handler(
					new CustomEvent('maestro:remoteCommand', {
						detail: {
							sessionId: 'session-1',
							command: 'ls',
							inputMode: 'terminal',
						},
					})
				);
			});

			// Session should be reset to idle
			const sessions = useSessionStore.getState().sessions;
			const updatedSession = sessions.find((s) => s.id === 'session-1');
			expect(updatedSession?.state).toBe('idle');
			// Error should be in shell logs
			const lastLog = updatedSession?.shellLogs[updatedSession.shellLogs.length - 1];
			expect(lastLog?.text).toContain('Connection refused');
		});
	});

	// ========================================================================
	// Return stability
	// ========================================================================

	describe('return stability', () => {
		it('maintains stable handler references when deps are stable', () => {
			const deps = createMockDeps();
			const { result, rerender } = renderHook(() => useRemoteHandlers(deps));

			const first = result.current.handleQuickActionsToggleRemoteControl;
			rerender();
			expect(result.current.handleQuickActionsToggleRemoteControl).toBe(first);
		});
	});

	// ========================================================================
	// handleRemoteCommand – Terminal mode edge cases
	// ========================================================================

	describe('handleRemoteCommand – terminal mode edge cases', () => {
		/** Helper: extract the maestro:remoteCommand event handler from addEventListener mock */
		function getRemoteCommandHandler() {
			const call = (window.addEventListener as any).mock.calls.find(
				(c: any[]) => c[0] === 'maestro:remoteCommand'
			);
			return call[1] as (event: Event) => Promise<void>;
		}

		it('appends user command text to shellLogs', async () => {
			const session = createMockSession({ inputMode: 'terminal', shellLogs: [] });
			const deps = createMockDeps({ sessionsRef: { current: [session] } });

			renderHook(() => useRemoteHandlers(deps));
			const handler = getRemoteCommandHandler();

			await act(async () => {
				await handler(
					new CustomEvent('maestro:remoteCommand', {
						detail: { sessionId: 'session-1', command: 'echo hello', inputMode: 'terminal' },
					})
				);
			});

			const updated = useSessionStore.getState().sessions.find((s) => s.id === 'session-1');
			// First shellLog entry should be the user command
			expect(updated?.shellLogs.length).toBeGreaterThanOrEqual(1);
			expect(updated?.shellLogs[0].text).toBe('echo hello');
			expect(updated?.shellLogs[0].source).toBe('user');
		});

		it('falls back to workingDirOverride when remoteCwd is undefined on SSH session', async () => {
			const session = createMockSession({
				inputMode: 'terminal',
				sshRemoteId: 'remote-1',
				remoteCwd: undefined,
				cwd: '/local/path',
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: 'remote-1',
					workingDirOverride: '/override/path',
				},
			});
			const deps = createMockDeps({ sessionsRef: { current: [session] } });

			renderHook(() => useRemoteHandlers(deps));
			const handler = getRemoteCommandHandler();

			await act(async () => {
				await handler(
					new CustomEvent('maestro:remoteCommand', {
						detail: { sessionId: 'session-1', command: 'pwd', inputMode: 'terminal' },
					})
				);
			});

			expect(window.maestro.process.runCommand).toHaveBeenCalledWith(
				expect.objectContaining({ cwd: '/override/path' })
			);
		});

		it('falls back to session.cwd when no SSH config and no shellCwd', async () => {
			const session = createMockSession({
				inputMode: 'terminal',
				cwd: '/my/project',
				shellCwd: undefined,
			} as any);
			const deps = createMockDeps({ sessionsRef: { current: [session] } });

			renderHook(() => useRemoteHandlers(deps));
			const handler = getRemoteCommandHandler();

			await act(async () => {
				await handler(
					new CustomEvent('maestro:remoteCommand', {
						detail: { sessionId: 'session-1', command: 'ls', inputMode: 'terminal' },
					})
				);
			});

			expect(window.maestro.process.runCommand).toHaveBeenCalledWith(
				expect.objectContaining({ cwd: '/my/project' })
			);
		});

		it('handles non-Error thrown value in terminal command error path', async () => {
			(window.maestro.process.runCommand as any).mockRejectedValue('string error value');

			const session = createMockSession({ inputMode: 'terminal' });
			const deps = createMockDeps({ sessionsRef: { current: [session] } });

			renderHook(() => useRemoteHandlers(deps));
			const handler = getRemoteCommandHandler();

			await act(async () => {
				await handler(
					new CustomEvent('maestro:remoteCommand', {
						detail: { sessionId: 'session-1', command: 'bad-cmd', inputMode: 'terminal' },
					})
				);
			});

			const updated = useSessionStore.getState().sessions.find((s) => s.id === 'session-1');
			expect(updated?.state).toBe('idle');
			// The error message should use "Unknown error" because it's not an Error instance
			const errorLog = updated?.shellLogs.find((l) => l.source === 'system');
			expect(errorLog?.text).toContain('Unknown error');
		});

		it('passes sessionSshRemoteConfig to runCommand', async () => {
			const sshConfig = { enabled: true, remoteId: 'remote-1' };
			const session = createMockSession({
				inputMode: 'terminal',
				sshRemoteId: 'remote-1',
				remoteCwd: '/remote',
				sessionSshRemoteConfig: sshConfig,
			});
			const deps = createMockDeps({ sessionsRef: { current: [session] } });

			renderHook(() => useRemoteHandlers(deps));
			const handler = getRemoteCommandHandler();

			await act(async () => {
				await handler(
					new CustomEvent('maestro:remoteCommand', {
						detail: { sessionId: 'session-1', command: 'ls', inputMode: 'terminal' },
					})
				);
			});

			expect(window.maestro.process.runCommand).toHaveBeenCalledWith(
				expect.objectContaining({ sessionSshRemoteConfig: sshConfig })
			);
		});
	});

	// ========================================================================
	// handleRemoteCommand – AI mode edge cases
	// ========================================================================

	describe('handleRemoteCommand – AI mode edge cases', () => {
		function getRemoteCommandHandler() {
			const call = (window.addEventListener as any).mock.calls.find(
				(c: any[]) => c[0] === 'maestro:remoteCommand'
			);
			return call[1] as (event: Event) => Promise<void>;
		}

		it('supports codex agent type for AI mode', async () => {
			const session = createMockSession({ inputMode: 'ai', toolType: 'codex' as any });
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' } as any);
			const deps = createMockDeps({ sessionsRef: { current: [session] } });

			renderHook(() => useRemoteHandlers(deps));
			const handler = getRemoteCommandHandler();

			await act(async () => {
				await handler(
					new CustomEvent('maestro:remoteCommand', {
						detail: { sessionId: 'session-1', command: 'help me', inputMode: 'ai' },
					})
				);
			});

			expect(window.maestro.process.spawn).toHaveBeenCalledWith(
				expect.objectContaining({ prompt: 'help me', toolType: 'codex' })
			);
		});

		it('supports opencode agent type for AI mode', async () => {
			const session = createMockSession({ inputMode: 'ai', toolType: 'opencode' as any });
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' } as any);
			const deps = createMockDeps({ sessionsRef: { current: [session] } });

			renderHook(() => useRemoteHandlers(deps));
			const handler = getRemoteCommandHandler();

			await act(async () => {
				await handler(
					new CustomEvent('maestro:remoteCommand', {
						detail: { sessionId: 'session-1', command: 'explain', inputMode: 'ai' },
					})
				);
			});

			expect(window.maestro.process.spawn).toHaveBeenCalledWith(
				expect.objectContaining({ prompt: 'explain', toolType: 'opencode' })
			);
		});

		it('rejects factory-droid agent type (not in supportedBatchAgents)', async () => {
			const session = createMockSession({ inputMode: 'ai', toolType: 'factory-droid' as any });
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' } as any);
			const deps = createMockDeps({ sessionsRef: { current: [session] } });

			renderHook(() => useRemoteHandlers(deps));
			const handler = getRemoteCommandHandler();

			await act(async () => {
				await handler(
					new CustomEvent('maestro:remoteCommand', {
						detail: { sessionId: 'session-1', command: 'test', inputMode: 'ai' },
					})
				);
			});

			expect(window.maestro.process.spawn).not.toHaveBeenCalled();
		});

		it('logs error and returns early for unknown slash commands', async () => {
			const session = createMockSession({ inputMode: 'ai' });
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' } as any);
			const deps = createMockDeps({
				sessionsRef: { current: [session] },
				customAICommandsRef: { current: [] },
				speckitCommandsRef: { current: [] },
				openspecCommandsRef: { current: [] },
			});

			renderHook(() => useRemoteHandlers(deps));
			const handler = getRemoteCommandHandler();

			await act(async () => {
				await handler(
					new CustomEvent('maestro:remoteCommand', {
						detail: { sessionId: 'session-1', command: '/nonexistent', inputMode: 'ai' },
					})
				);
			});

			// Should NOT spawn — unknown slash command is early-returned
			expect(window.maestro.process.spawn).not.toHaveBeenCalled();

			// addLogToTab should have been called with system error about unknown command
			const updated = useSessionStore.getState().sessions.find((s) => s.id === 'session-1');
			const activeTab = updated?.aiTabs.find((t) => t.id === updated.activeTabId);
			const systemLog = activeTab?.logs.find(
				(l) => l.source === 'system' && l.text.includes('/nonexistent')
			);
			expect(systemLog).toBeTruthy();
		});

		it('uses speckitCommandsRef for slash command matching', async () => {
			const speckitCommand: CustomAICommand = {
				command: '/speckit-test',
				description: 'Speckit command',
				prompt: 'Speckit prompt text',
			};

			const session = createMockSession({ inputMode: 'ai' });
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' } as any);
			const deps = createMockDeps({
				sessionsRef: { current: [session] },
				customAICommandsRef: { current: [] },
				speckitCommandsRef: { current: [speckitCommand] },
				openspecCommandsRef: { current: [] },
			});

			renderHook(() => useRemoteHandlers(deps));
			const handler = getRemoteCommandHandler();

			await act(async () => {
				await handler(
					new CustomEvent('maestro:remoteCommand', {
						detail: { sessionId: 'session-1', command: '/speckit-test', inputMode: 'ai' },
					})
				);
			});

			expect(window.maestro.process.spawn).toHaveBeenCalledWith(
				expect.objectContaining({ prompt: 'Speckit prompt text' })
			);
		});

		it('uses openspecCommandsRef for slash command matching', async () => {
			const openspecCommand: CustomAICommand = {
				command: '/openspec-run',
				description: 'OpenSpec command',
				prompt: 'OpenSpec prompt text',
			};

			const session = createMockSession({ inputMode: 'ai' });
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' } as any);
			const deps = createMockDeps({
				sessionsRef: { current: [session] },
				customAICommandsRef: { current: [] },
				speckitCommandsRef: { current: [] },
				openspecCommandsRef: { current: [openspecCommand] },
			});

			renderHook(() => useRemoteHandlers(deps));
			const handler = getRemoteCommandHandler();

			await act(async () => {
				await handler(
					new CustomEvent('maestro:remoteCommand', {
						detail: { sessionId: 'session-1', command: '/openspec-run', inputMode: 'ai' },
					})
				);
			});

			expect(window.maestro.process.spawn).toHaveBeenCalledWith(
				expect.objectContaining({ prompt: 'OpenSpec prompt text' })
			);
		});

		it('returns early when agent config is not found', async () => {
			(window.maestro.agents.get as any).mockResolvedValue(null);

			const session = createMockSession({ inputMode: 'ai' });
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' } as any);
			const deps = createMockDeps({ sessionsRef: { current: [session] } });

			renderHook(() => useRemoteHandlers(deps));
			const handler = getRemoteCommandHandler();

			await act(async () => {
				await handler(
					new CustomEvent('maestro:remoteCommand', {
						detail: { sessionId: 'session-1', command: 'test', inputMode: 'ai' },
					})
				);
			});

			expect(window.maestro.process.spawn).not.toHaveBeenCalled();
		});

		it('resets session to idle and adds error log on spawn failure', async () => {
			(window.maestro.process.spawn as any).mockRejectedValue(new Error('Spawn failed'));

			const session = createMockSession({ inputMode: 'ai' });
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' } as any);
			const deps = createMockDeps({ sessionsRef: { current: [session] } });

			renderHook(() => useRemoteHandlers(deps));
			const handler = getRemoteCommandHandler();

			await act(async () => {
				await handler(
					new CustomEvent('maestro:remoteCommand', {
						detail: { sessionId: 'session-1', command: 'do something', inputMode: 'ai' },
					})
				);
			});

			const updated = useSessionStore.getState().sessions.find((s) => s.id === 'session-1');
			expect(updated?.state).toBe('idle');
			expect(updated?.busySource).toBeUndefined();
			const activeTab = updated?.aiTabs.find((t) => t.id === updated.activeTabId);
			const errorLog = activeTab?.logs.find(
				(l) => l.source === 'system' && l.text.includes('Spawn failed')
			);
			expect(errorLog).toBeTruthy();
		});

		it('filters --dangerously-skip-permissions from args in readOnly mode', async () => {
			(window.maestro.agents.get as any).mockResolvedValue({
				command: 'claude',
				path: '/usr/local/bin/claude',
				args: ['--dangerously-skip-permissions', '--verbose'],
			});

			const session = createMockSession({
				inputMode: 'ai',
				aiTabs: [
					{
						id: 'tab-1',
						name: 'Tab 1',
						inputValue: '',
						data: [],
						logs: [],
						stagedImages: [],
						readOnlyMode: true,
					},
				],
				activeTabId: 'tab-1',
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' } as any);
			const deps = createMockDeps({ sessionsRef: { current: [session] } });

			renderHook(() => useRemoteHandlers(deps));
			const handler = getRemoteCommandHandler();

			await act(async () => {
				await handler(
					new CustomEvent('maestro:remoteCommand', {
						detail: { sessionId: 'session-1', command: 'explain code', inputMode: 'ai' },
					})
				);
			});

			const spawnCall = (window.maestro.process.spawn as any).mock.calls[0][0];
			expect(spawnCall.args).toContain('--verbose');
			expect(spawnCall.args).not.toContain('--dangerously-skip-permissions');
		});

		it('filters --dangerously-bypass-approvals-and-sandbox from args in readOnly mode', async () => {
			(window.maestro.agents.get as any).mockResolvedValue({
				command: 'claude',
				path: '/usr/local/bin/claude',
				args: ['--dangerously-bypass-approvals-and-sandbox', '--json'],
			});

			const session = createMockSession({
				inputMode: 'ai',
				aiTabs: [
					{
						id: 'tab-1',
						name: 'Tab 1',
						inputValue: '',
						data: [],
						logs: [],
						stagedImages: [],
						readOnlyMode: true,
					},
				],
				activeTabId: 'tab-1',
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' } as any);
			const deps = createMockDeps({ sessionsRef: { current: [session] } });

			renderHook(() => useRemoteHandlers(deps));
			const handler = getRemoteCommandHandler();

			await act(async () => {
				await handler(
					new CustomEvent('maestro:remoteCommand', {
						detail: { sessionId: 'session-1', command: 'read file', inputMode: 'ai' },
					})
				);
			});

			const spawnCall = (window.maestro.process.spawn as any).mock.calls[0][0];
			expect(spawnCall.args).toContain('--json');
			expect(spawnCall.args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
		});

		it('sets session state to busy with busySource=ai for AI commands', async () => {
			const session = createMockSession({ inputMode: 'ai' });
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' } as any);
			const deps = createMockDeps({ sessionsRef: { current: [session] } });

			renderHook(() => useRemoteHandlers(deps));
			const handler = getRemoteCommandHandler();

			await act(async () => {
				await handler(
					new CustomEvent('maestro:remoteCommand', {
						detail: { sessionId: 'session-1', command: 'analyze code', inputMode: 'ai' },
					})
				);
			});

			const updated = useSessionStore.getState().sessions.find((s) => s.id === 'session-1');
			expect(updated?.state).toBe('busy');
			expect(updated?.busySource).toBe('ai');
		});

		it('adds user log entry to the active tab for AI commands', async () => {
			const session = createMockSession({ inputMode: 'ai' });
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' } as any);
			const deps = createMockDeps({ sessionsRef: { current: [session] } });

			renderHook(() => useRemoteHandlers(deps));
			const handler = getRemoteCommandHandler();

			await act(async () => {
				await handler(
					new CustomEvent('maestro:remoteCommand', {
						detail: { sessionId: 'session-1', command: 'explain this', inputMode: 'ai' },
					})
				);
			});

			const updated = useSessionStore.getState().sessions.find((s) => s.id === 'session-1');
			const activeTab = updated?.aiTabs.find((t) => t.id === updated.activeTabId);
			const userLog = activeTab?.logs.find((l) => l.source === 'user');
			expect(userLog).toBeTruthy();
			expect(userLog?.text).toBe('explain this');
		});

		it('uses web-provided inputMode over session inputMode', async () => {
			// Session is in terminal mode, but web sends AI mode
			const session = createMockSession({ inputMode: 'terminal' });
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' } as any);
			const deps = createMockDeps({ sessionsRef: { current: [session] } });

			renderHook(() => useRemoteHandlers(deps));
			const handler = getRemoteCommandHandler();

			await act(async () => {
				await handler(
					new CustomEvent('maestro:remoteCommand', {
						detail: { sessionId: 'session-1', command: 'explain this', inputMode: 'ai' },
					})
				);
			});

			// Should spawn (AI mode) instead of runCommand (terminal mode)
			expect(window.maestro.process.spawn).toHaveBeenCalled();
			expect(window.maestro.process.runCommand).not.toHaveBeenCalled();
		});

		it('falls back to session.inputMode when web inputMode is not provided', async () => {
			const session = createMockSession({ inputMode: 'terminal' });
			const deps = createMockDeps({ sessionsRef: { current: [session] } });

			renderHook(() => useRemoteHandlers(deps));
			const handler = getRemoteCommandHandler();

			await act(async () => {
				await handler(
					new CustomEvent('maestro:remoteCommand', {
						detail: { sessionId: 'session-1', command: 'ls' },
					})
				);
			});

			// Should use terminal mode (session's inputMode)
			expect(window.maestro.process.runCommand).toHaveBeenCalled();
			expect(window.maestro.process.spawn).not.toHaveBeenCalled();
		});

		it('passes sessionSshRemoteConfig to spawn for AI commands', async () => {
			const sshConfig = { enabled: true, remoteId: 'remote-1' };
			const session = createMockSession({
				inputMode: 'ai',
				sessionSshRemoteConfig: sshConfig,
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' } as any);
			const deps = createMockDeps({ sessionsRef: { current: [session] } });

			renderHook(() => useRemoteHandlers(deps));
			const handler = getRemoteCommandHandler();

			await act(async () => {
				await handler(
					new CustomEvent('maestro:remoteCommand', {
						detail: { sessionId: 'session-1', command: 'help', inputMode: 'ai' },
					})
				);
			});

			expect(window.maestro.process.spawn).toHaveBeenCalledWith(
				expect.objectContaining({ sessionSshRemoteConfig: sshConfig })
			);
		});

		it('passes custom session configuration to spawn', async () => {
			const session = createMockSession({
				inputMode: 'ai',
				customPath: '/custom/claude',
				customArgs: ['--custom-flag'],
				customEnvVars: { MY_VAR: 'value' },
				customModel: 'opus',
				customContextWindow: 200000,
			} as any);
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' } as any);
			const deps = createMockDeps({ sessionsRef: { current: [session] } });

			renderHook(() => useRemoteHandlers(deps));
			const handler = getRemoteCommandHandler();

			await act(async () => {
				await handler(
					new CustomEvent('maestro:remoteCommand', {
						detail: { sessionId: 'session-1', command: 'test', inputMode: 'ai' },
					})
				);
			});

			expect(window.maestro.process.spawn).toHaveBeenCalledWith(
				expect.objectContaining({
					sessionCustomPath: '/custom/claude',
					sessionCustomArgs: ['--custom-flag'],
					sessionCustomEnvVars: { MY_VAR: 'value' },
					sessionCustomModel: 'opus',
					sessionCustomContextWindow: 200000,
				})
			);
		});
	});

	// ========================================================================
	// handleQuickActionsToggleRemoteControl – edge cases
	// ========================================================================

	describe('handleQuickActionsToggleRemoteControl – edge cases', () => {
		it('clears notification after 4 seconds', async () => {
			vi.useFakeTimers();

			const mockSetFlash = vi.fn();
			useUIStore.setState({ setSuccessFlashNotification: mockSetFlash } as any);

			const deps = createMockDeps({ isLiveMode: false });
			const { result } = renderHook(() => useRemoteHandlers(deps));

			await act(async () => {
				await result.current.handleQuickActionsToggleRemoteControl();
			});

			// Should have been called once with the notification message
			expect(mockSetFlash).toHaveBeenCalledTimes(1);

			// Advance timer by 4 seconds
			act(() => {
				vi.advanceTimersByTime(4000);
			});

			// Should now have been called a second time with null to clear
			expect(mockSetFlash).toHaveBeenCalledTimes(2);
			expect(mockSetFlash).toHaveBeenLastCalledWith(null);

			vi.useRealTimers();
		});

		it('shows LIVE notification with QR code mention when enabling', async () => {
			const mockSetFlash = vi.fn();
			useUIStore.setState({ setSuccessFlashNotification: mockSetFlash } as any);

			const deps = createMockDeps({ isLiveMode: false });
			const { result } = renderHook(() => useRemoteHandlers(deps));

			await act(async () => {
				await result.current.handleQuickActionsToggleRemoteControl();
			});

			expect(mockSetFlash).toHaveBeenCalledWith(expect.stringContaining('QR code'));
		});

		it('shows OFFLINE notification with left panel mention when disabling', async () => {
			const mockSetFlash = vi.fn();
			useUIStore.setState({ setSuccessFlashNotification: mockSetFlash } as any);

			const deps = createMockDeps({ isLiveMode: true });
			const { result } = renderHook(() => useRemoteHandlers(deps));

			await act(async () => {
				await result.current.handleQuickActionsToggleRemoteControl();
			});

			expect(mockSetFlash).toHaveBeenCalledWith(expect.stringContaining('left panel'));
		});
	});

	// ========================================================================
	// sessionSshRemoteNames – edge cases
	// ========================================================================

	describe('sessionSshRemoteNames – edge cases', () => {
		it('skips session with null remoteId', () => {
			const session = createMockSession({
				name: 'Agent X',
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: null as any,
				},
			});

			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' } as any);

			const deps = createMockDeps({
				sshRemoteConfigs: [{ id: 'remote-1', name: 'Server' }],
			});

			const { result } = renderHook(() => useRemoteHandlers(deps));
			// null remoteId fails the truthy check, should be skipped
			expect(result.current.sessionSshRemoteNames.size).toBe(0);
		});

		it('skips session without sessionSshRemoteConfig', () => {
			const session = createMockSession({
				name: 'Agent Y',
				// sessionSshRemoteConfig not provided (undefined)
			});

			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' } as any);

			const deps = createMockDeps({
				sshRemoteConfigs: [{ id: 'remote-1', name: 'Server' }],
			});

			const { result } = renderHook(() => useRemoteHandlers(deps));
			expect(result.current.sessionSshRemoteNames.size).toBe(0);
		});

		it('recalculates when sessions change', () => {
			const session1 = createMockSession({
				id: 's1',
				name: 'Agent 1',
				sessionSshRemoteConfig: { enabled: true, remoteId: 'r1' },
			});

			useSessionStore.setState({ sessions: [session1], activeSessionId: 's1' } as any);

			const deps = createMockDeps({
				sshRemoteConfigs: [
					{ id: 'r1', name: 'Server 1' },
					{ id: 'r2', name: 'Server 2' },
				],
			});

			const { result } = renderHook(() => useRemoteHandlers(deps));
			expect(result.current.sessionSshRemoteNames.size).toBe(1);
			expect(result.current.sessionSshRemoteNames.get('Agent 1')).toBe('Server 1');

			// Add another session with SSH config
			const session2 = createMockSession({
				id: 's2',
				name: 'Agent 2',
				sessionSshRemoteConfig: { enabled: true, remoteId: 'r2' },
			});

			act(() => {
				useSessionStore.setState({
					sessions: [session1, session2],
					activeSessionId: 's1',
				} as any);
			});

			expect(result.current.sessionSshRemoteNames.size).toBe(2);
			expect(result.current.sessionSshRemoteNames.get('Agent 2')).toBe('Server 2');
		});
	});

	// ========================================================================
	// Event listener lifecycle
	// ========================================================================

	describe('event listener lifecycle', () => {
		it('uses the same function reference for addEventListener and removeEventListener', () => {
			const { unmount } = renderHook(() => useRemoteHandlers(createMockDeps()));

			const addCall = (window.addEventListener as any).mock.calls.find(
				(c: any[]) => c[0] === 'maestro:remoteCommand'
			);
			const addedFn = addCall[1];

			unmount();

			const removeCall = (window.removeEventListener as any).mock.calls.find(
				(c: any[]) => c[0] === 'maestro:remoteCommand'
			);
			const removedFn = removeCall[1];

			expect(addedFn).toBe(removedFn);
		});
	});
});

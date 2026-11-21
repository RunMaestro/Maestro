// Source: src/__tests__/web/hooks/useLongPressMenu.test.ts
// Source: src/__tests__/web/hooks/useMobileAutoReconnect.test.ts
// Source: src/__tests__/web/hooks/useMobileSessionManagement.test.ts
// Source: src/__tests__/web/hooks/useAutoRun.test.ts
// Source: src/__tests__/web/hooks/useMobileKeyboardHandler.test.ts
import { describe as describeSourceSuite } from 'vitest';
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { vi } from 'vitest';
import { beforeEach } from 'vitest';
import { afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { act } from '@testing-library/react';
import { useLongPressMenu } from '../../../web/hooks/useLongPressMenu';
import { useMobileAutoReconnect } from '../../../web/hooks/useMobileAutoReconnect';
import { useMobileSessionManagement } from '../../../web/hooks/useMobileSessionManagement';
import type { UseMobileSessionManagementDeps } from '../../../web/hooks/useMobileSessionManagement';
import type { Session } from '../../../web/hooks/useSessions';
import { useAutoRun } from '../../../web/hooks/useAutoRun';
import type { LaunchWorktreeConfig } from '../../../web/hooks/useAutoRun';
import { useMobileKeyboardHandler } from '../../../web/hooks/useMobileKeyboardHandler';
import type { MobileKeyboardSession } from '../../../web/hooks/useMobileKeyboardHandler';
import { WEB_DEFAULT_SHORTCUTS } from '../../../web/constants/webShortcuts';
import type { AITabData } from '../../../web/hooks/useWebSocket';
describeSourceSuite('useLongPressMenu', () => {
	function createTouchEvent(target: HTMLButtonElement): React.TouchEvent<HTMLButtonElement> {
		return {
			currentTarget: target,
			touches: [{ clientX: 0, clientY: 0 }],
			preventDefault: vi.fn(),
		} as unknown as React.TouchEvent<HTMLButtonElement>;
	}

	describe('useLongPressMenu', () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});

		afterEach(() => {
			vi.runOnlyPendingTimers();
			vi.useRealTimers();
			vi.restoreAllMocks();
		});

		it('triggers onOpenCommandPalette after long press', () => {
			const onOpenCommandPalette = vi.fn();
			const button = document.createElement('button');

			const { result } = renderHook(() =>
				useLongPressMenu({
					inputMode: 'ai',
					value: 'hello',
					onOpenCommandPalette,
				})
			);

			act(() => {
				result.current.sendButtonRef.current = button;
			});

			act(() => {
				result.current.handleTouchStart(createTouchEvent(button));
				vi.advanceTimersByTime(500);
			});

			expect(onOpenCommandPalette).toHaveBeenCalledTimes(1);
		});

		it('cancels long press on touch move', () => {
			const onOpenCommandPalette = vi.fn();
			const button = document.createElement('button');

			const { result } = renderHook(() =>
				useLongPressMenu({
					inputMode: 'ai',
					value: 'hello',
					onOpenCommandPalette,
				})
			);

			act(() => {
				result.current.sendButtonRef.current = button;
			});

			act(() => {
				result.current.handleTouchStart(createTouchEvent(button));
				result.current.handleTouchMove();
				vi.advanceTimersByTime(500);
			});

			expect(onOpenCommandPalette).not.toHaveBeenCalled();
		});

		it('does not trigger onOpenCommandPalette when touch ends before duration', () => {
			const onOpenCommandPalette = vi.fn();
			const button = document.createElement('button');

			const { result } = renderHook(() =>
				useLongPressMenu({
					inputMode: 'ai',
					value: 'hello',
					onOpenCommandPalette,
				})
			);

			act(() => {
				result.current.sendButtonRef.current = button;
			});

			act(() => {
				result.current.handleTouchStart(createTouchEvent(button));
				result.current.handleTouchEnd(createTouchEvent(button));
				vi.advanceTimersByTime(500);
			});

			expect(onOpenCommandPalette).not.toHaveBeenCalled();
		});

		it('returns expected handler functions', () => {
			const { result } = renderHook(() =>
				useLongPressMenu({
					inputMode: 'ai',
					value: 'hello',
				})
			);

			expect(typeof result.current.handleTouchStart).toBe('function');
			expect(typeof result.current.handleTouchEnd).toBe('function');
			expect(typeof result.current.handleTouchMove).toBe('function');
			expect(result.current.sendButtonRef).toBeDefined();
		});
	});
});
describeSourceSuite('useMobileAutoReconnect', () => {
	const DEFAULT_COUNTDOWN = 30;

	describe('useMobileAutoReconnect', () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});

		afterEach(() => {
			vi.useRealTimers();
			vi.clearAllMocks();
		});

		it('counts down and reconnects when disconnected and online', () => {
			const connect = vi.fn();

			const { result } = renderHook(
				({ connectionState, isOffline }) =>
					useMobileAutoReconnect({
						connectionState,
						isOffline,
						connect,
					}),
				{
					initialProps: { connectionState: 'disconnected', isOffline: false },
				}
			);

			expect(result.current.reconnectCountdown).toBe(DEFAULT_COUNTDOWN);

			act(() => {
				vi.advanceTimersByTime(1000);
			});

			expect(result.current.reconnectCountdown).toBe(DEFAULT_COUNTDOWN - 1);

			act(() => {
				vi.advanceTimersByTime(29000);
			});

			expect(connect).toHaveBeenCalledTimes(1);
			expect(result.current.reconnectCountdown).toBe(DEFAULT_COUNTDOWN);
		});

		it('does not reconnect while offline', () => {
			const connect = vi.fn();

			const { result } = renderHook(
				({ connectionState, isOffline }) =>
					useMobileAutoReconnect({
						connectionState,
						isOffline,
						connect,
					}),
				{
					initialProps: { connectionState: 'disconnected', isOffline: true },
				}
			);

			expect(result.current.reconnectCountdown).toBe(DEFAULT_COUNTDOWN);

			act(() => {
				vi.advanceTimersByTime(60000);
			});

			expect(connect).not.toHaveBeenCalled();
			expect(result.current.reconnectCountdown).toBe(DEFAULT_COUNTDOWN);
		});
	});
});
describeSourceSuite('useMobileSessionManagement', () => {
	const baseDeps: UseMobileSessionManagementDeps = {
		savedActiveSessionId: null,
		savedActiveTabId: null,
		isOffline: true,
		sendRef: { current: null },
		triggerHaptic: vi.fn(),
		hapticTapPattern: 10,
	};

	describe('useMobileSessionManagement', () => {
		beforeEach(() => {
			vi.clearAllMocks();
		});

		afterEach(() => {
			vi.restoreAllMocks();
		});

		it('selects a session and syncs active tab', () => {
			const sendSpy = vi.fn();
			const { result } = renderHook(() =>
				useMobileSessionManagement({
					...baseDeps,
					sendRef: { current: sendSpy },
				})
			);

			const session: Session = {
				id: 'session-1',
				name: 'Session 1',
				toolType: 'claude-code',
				state: 'idle',
				inputMode: 'ai',
				cwd: '/tmp',
				aiTabs: [],
				activeTabId: 'tab-1',
			} as Session;

			act(() => {
				result.current.setSessions([session]);
			});

			act(() => {
				result.current.handleSelectSession('session-1');
			});

			expect(result.current.activeSessionId).toBe('session-1');
			expect(result.current.activeTabId).toBe('tab-1');
			expect(sendSpy).toHaveBeenCalledWith({
				type: 'select_session',
				sessionId: 'session-1',
				tabId: 'tab-1',
			});
		});

		it('clears activeTabId when the active session is removed', () => {
			const { result } = renderHook(() =>
				useMobileSessionManagement({
					...baseDeps,
					savedActiveSessionId: 'session-1',
					savedActiveTabId: 'tab-1',
				})
			);

			act(() => {
				result.current.sessionsHandlers.onSessionRemoved('session-1');
			});

			expect(result.current.activeSessionId).toBeNull();
			expect(result.current.activeTabId).toBeNull();
		});

		it('adds output logs for the active session and tab', async () => {
			const { result } = renderHook(() =>
				useMobileSessionManagement({
					...baseDeps,
					savedActiveSessionId: 'session-1',
					savedActiveTabId: 'tab-1',
				})
			);

			// Refs should be initialized immediately with saved values (no race condition)
			expect(result.current.activeSessionIdRef.current).toBe('session-1');

			act(() => {
				result.current.sessionsHandlers.onSessionOutput('session-1', 'hello', 'ai', 'tab-1');
			});

			expect(result.current.sessionLogs.aiLogs).toHaveLength(1);
			expect(result.current.sessionLogs.aiLogs[0].text).toBe('hello');
		});

		it('keeps a confirmed remote tab rename through sync and reconnect reload', () => {
			const sendSpy = vi.fn();
			const tab = {
				id: 'tab-1',
				agentSessionId: 'agent-session-1',
				name: null,
				starred: false,
				inputValue: '',
				createdAt: 1700000000000,
				state: 'idle',
			};
			const session = {
				id: 'session-1',
				name: 'Session 1',
				toolType: 'claude-code',
				state: 'idle',
				inputMode: 'ai',
				cwd: '/tmp',
				aiTabs: [tab],
				activeTabId: 'tab-1',
			} as Session;
			const { result } = renderHook(() =>
				useMobileSessionManagement({
					...baseDeps,
					savedActiveSessionId: 'session-1',
					savedActiveTabId: 'tab-1',
					sendRef: { current: sendSpy },
				})
			);

			act(() => {
				result.current.setSessions([session]);
			});
			act(() => {
				result.current.handleRenameTab('tab-1', 'Client Plan');
			});
			act(() => {
				result.current.sessionsHandlers.onRenameTabResult(
					'session-1',
					'tab-1',
					true,
					'Client Plan'
				);
			});

			expect(sendSpy).toHaveBeenCalledWith({
				type: 'rename_tab',
				sessionId: 'session-1',
				tabId: 'tab-1',
				newName: 'Client Plan',
			});
			expect(result.current.sessions[0].aiTabs?.[0].name).toBe('Client Plan');

			const syncedTabs = [{ ...tab, name: 'Client Plan' }];
			act(() => {
				result.current.sessionsHandlers.onTabsChanged('session-1', syncedTabs, 'tab-1');
			});
			expect(result.current.sessions[0].aiTabs?.[0].name).toBe('Client Plan');

			act(() => {
				result.current.sessionsHandlers.onSessionsUpdate([{ ...session, aiTabs: syncedTabs }]);
			});
			expect(result.current.sessions[0].aiTabs?.[0].name).toBe('Client Plan');
		});

		it('does not leave a false tab name when remote rename fails', () => {
			const session = {
				id: 'session-1',
				name: 'Session 1',
				toolType: 'claude-code',
				state: 'idle',
				inputMode: 'ai',
				cwd: '/tmp',
				aiTabs: [
					{
						id: 'tab-1',
						agentSessionId: 'agent-session-1',
						name: 'Old Name',
						starred: false,
						inputValue: '',
						createdAt: 1700000000000,
						state: 'idle',
					},
				],
				activeTabId: 'tab-1',
			} as Session;
			const { result } = renderHook(() =>
				useMobileSessionManagement({
					...baseDeps,
					savedActiveSessionId: 'session-1',
					savedActiveTabId: 'tab-1',
				})
			);

			act(() => {
				result.current.setSessions([session]);
			});
			act(() => {
				result.current.sessionsHandlers.onRenameTabResult(
					'session-1',
					'tab-1',
					false,
					'False Name',
					'disk full'
				);
			});

			expect(result.current.sessions[0].aiTabs?.[0].name).toBe('Old Name');
		});
	});
});
describeSourceSuite('useAutoRun', () => {
	describe('useAutoRun (mobile/web)', () => {
		const send = vi.fn().mockReturnValue(true);
		const sendRequest = vi.fn();

		beforeEach(() => {
			send.mockClear();
			sendRequest.mockReset();
			sendRequest.mockResolvedValue({ success: true });
		});

		describe('launchAutoRun', () => {
			it('omits worktree when none is supplied and resolves with the server result', async () => {
				const { result } = renderHook(() => useAutoRun(sendRequest, send));

				let response: { success: boolean; error?: string } | undefined;
				await act(async () => {
					response = await result.current.launchAutoRun('s-1', {
						documents: [{ filename: 'doc.md' }],
						prompt: 'p',
					});
				});

				expect(sendRequest).toHaveBeenCalledTimes(1);
				expect(sendRequest).toHaveBeenCalledWith(
					'configure_auto_run',
					{
						sessionId: 's-1',
						documents: [{ filename: 'doc.md' }],
						prompt: 'p',
						loopEnabled: undefined,
						maxLoops: undefined,
						launch: true,
					},
					10_000
				);
				expect(response).toEqual({ success: true, error: undefined });
			});

			it('uses an extended timeout when worktree dispatch is enabled', async () => {
				const worktree: LaunchWorktreeConfig = {
					enabled: true,
					path: '/repo/worktrees/auto-run-main-0503',
					branchName: 'auto-run-main-0503',
					createPROnCompletion: false,
					prTargetBranch: 'main',
				};
				const { result } = renderHook(() => useAutoRun(sendRequest, send));
				await act(async () => {
					await result.current.launchAutoRun('s-1', {
						documents: [{ filename: 'doc.md' }],
						worktree,
					});
				});

				expect(sendRequest.mock.calls[0][2]).toBe(60_000);
			});

			it('uses the default timeout when worktree dispatch is disabled', async () => {
				const { result } = renderHook(() => useAutoRun(sendRequest, send));
				await act(async () => {
					await result.current.launchAutoRun('s-1', {
						documents: [{ filename: 'doc.md' }],
						worktree: {
							enabled: false,
							path: '/x',
							branchName: 'b',
							createPROnCompletion: false,
							prTargetBranch: 'main',
						},
					});
				});

				expect(sendRequest.mock.calls[0][2]).toBe(10_000);
			});

			it('forwards worktree config when enabled', async () => {
				const worktree: LaunchWorktreeConfig = {
					enabled: true,
					path: '/repo/worktrees/auto-run-main-0503',
					branchName: 'auto-run-main-0503',
					createPROnCompletion: true,
					prTargetBranch: 'main',
				};

				const { result } = renderHook(() => useAutoRun(sendRequest, send));
				await act(async () => {
					await result.current.launchAutoRun('s-1', {
						documents: [{ filename: 'doc.md' }],
						worktree,
					});
				});

				const payload = sendRequest.mock.calls[0][1];
				expect(payload.worktree).toEqual(worktree);
			});

			it('strips a disabled worktree config', async () => {
				const { result } = renderHook(() => useAutoRun(sendRequest, send));
				await act(async () => {
					await result.current.launchAutoRun('s-1', {
						documents: [{ filename: 'doc.md' }],
						worktree: {
							enabled: false,
							path: '/x',
							branchName: 'b',
							createPROnCompletion: false,
							prTargetBranch: 'main',
						},
					});
				});
				expect(sendRequest.mock.calls[0][1].worktree).toBeUndefined();
			});

			it('returns success=false when the server reports an error', async () => {
				sendRequest.mockResolvedValueOnce({ success: false, error: 'Bad request' });
				const { result } = renderHook(() => useAutoRun(sendRequest, send));

				let response: { success: boolean; error?: string } | undefined;
				await act(async () => {
					response = await result.current.launchAutoRun('s-1', {
						documents: [{ filename: 'doc.md' }],
					});
				});

				expect(response).toEqual({ success: false, error: 'Bad request' });
			});

			it('returns success=false when sendRequest rejects with a known transport error', async () => {
				sendRequest.mockRejectedValueOnce(new Error('Request timed out'));
				const { result } = renderHook(() => useAutoRun(sendRequest, send));

				let response: { success: boolean; error?: string } | undefined;
				await act(async () => {
					response = await result.current.launchAutoRun('s-1', {
						documents: [{ filename: 'doc.md' }],
					});
				});

				expect(response).toEqual({ success: false, error: 'Request timed out' });
			});

			it('also handles WebSocket-not-connected as a known transport failure', async () => {
				sendRequest.mockRejectedValueOnce(new Error('WebSocket not connected'));
				const { result } = renderHook(() => useAutoRun(sendRequest, send));

				let response: { success: boolean; error?: string } | undefined;
				await act(async () => {
					response = await result.current.launchAutoRun('s-1', {
						documents: [{ filename: 'doc.md' }],
					});
				});

				expect(response).toEqual({ success: false, error: 'WebSocket not connected' });
			});

			it('re-throws unexpected errors so they bubble to global handlers / Sentry', async () => {
				const unexpected = new Error('Some non-transport bug');
				sendRequest.mockRejectedValueOnce(unexpected);
				const { result } = renderHook(() => useAutoRun(sendRequest, send));

				await expect(
					result.current.launchAutoRun('s-1', { documents: [{ filename: 'doc.md' }] })
				).rejects.toBe(unexpected);
			});

			it('treats a missing success field as failure', async () => {
				sendRequest.mockResolvedValueOnce({});
				const { result } = renderHook(() => useAutoRun(sendRequest, send));

				let response: { success: boolean; error?: string } | undefined;
				await act(async () => {
					response = await result.current.launchAutoRun('s-1', {
						documents: [{ filename: 'doc.md' }],
					});
				});

				expect(response).toEqual({ success: false, error: undefined });
			});
		});

		describe('loadGitBranches', () => {
			it('sends get_git_branches and returns branches list', async () => {
				sendRequest.mockResolvedValueOnce({
					branches: ['main', 'feature/x'],
					currentBranch: 'main',
				});

				const { result } = renderHook(() => useAutoRun(sendRequest, send));
				const out = await result.current.loadGitBranches('s-1');

				expect(sendRequest).toHaveBeenCalledWith('get_git_branches', { sessionId: 's-1' });
				expect(out).toEqual({ branches: ['main', 'feature/x'], currentBranch: 'main' });
			});

			it('propagates transport errors to the caller', async () => {
				sendRequest.mockRejectedValueOnce(new Error('boom'));
				const { result } = renderHook(() => useAutoRun(sendRequest, send));
				await expect(result.current.loadGitBranches('s-1')).rejects.toThrow('boom');
			});
		});

		describe('listWorktrees', () => {
			it('sends list_worktrees and unwraps response', async () => {
				sendRequest.mockResolvedValueOnce({
					worktrees: [{ path: '/repo/wt-1', branch: 'feat/x', isBare: false }],
				});

				const { result } = renderHook(() => useAutoRun(sendRequest, send));
				const out = await result.current.listWorktrees('s-1');

				expect(sendRequest).toHaveBeenCalledWith('list_worktrees', { sessionId: 's-1' });
				expect(out).toEqual([{ path: '/repo/wt-1', branch: 'feat/x', isBare: false }]);
			});

			it('propagates transport errors to the caller', async () => {
				sendRequest.mockRejectedValueOnce(new Error('boom'));
				const { result } = renderHook(() => useAutoRun(sendRequest, send));
				await expect(result.current.listWorktrees('s-1')).rejects.toThrow('boom');
			});
		});
	});
});
describeSourceSuite('useMobileKeyboardHandler', () => {
	function createTabs(): AITabData[] {
		return [
			{
				id: 'tab-1',
				agentSessionId: null,
				name: 'One',
				starred: false,
				inputValue: '',
				createdAt: 0,
				state: 'idle',
			},
			{
				id: 'tab-2',
				agentSessionId: null,
				name: 'Two',
				starred: false,
				inputValue: '',
				createdAt: 1,
				state: 'idle',
			},
			{
				id: 'tab-3',
				agentSessionId: null,
				name: 'Three',
				starred: false,
				inputValue: '',
				createdAt: 2,
				state: 'idle',
			},
		];
	}

	describe('useMobileKeyboardHandler', () => {
		beforeEach(() => {
			vi.clearAllMocks();
		});

		afterEach(() => {
			vi.restoreAllMocks();
		});

		it('dispatches toggleMode on the configured shortcut (Cmd+J)', () => {
			const toggleMode = vi.fn();
			const activeSession: MobileKeyboardSession = { inputMode: 'ai' };

			renderHook(() =>
				useMobileKeyboardHandler({
					shortcuts: WEB_DEFAULT_SHORTCUTS,
					activeSession,
					actions: { toggleMode },
				})
			);

			const event = new KeyboardEvent('keydown', { key: 'j', metaKey: true, cancelable: true });

			act(() => {
				document.dispatchEvent(event);
			});

			expect(toggleMode).toHaveBeenCalledTimes(1);
		});

		it('dispatches prevTab/nextTab on Cmd+Shift+[ and Cmd+Shift+]', () => {
			const prevTab = vi.fn();
			const nextTab = vi.fn();
			const activeSession: MobileKeyboardSession = {
				inputMode: 'ai',
				aiTabs: createTabs(),
				activeTabId: 'tab-2',
			};

			renderHook(() =>
				useMobileKeyboardHandler({
					shortcuts: WEB_DEFAULT_SHORTCUTS,
					activeSession,
					actions: { prevTab, nextTab },
				})
			);

			act(() => {
				document.dispatchEvent(
					new KeyboardEvent('keydown', {
						key: '[',
						metaKey: true,
						shiftKey: true,
						cancelable: true,
					})
				);
			});
			expect(prevTab).toHaveBeenCalledTimes(1);

			act(() => {
				document.dispatchEvent(
					new KeyboardEvent('keydown', {
						key: ']',
						metaKey: true,
						shiftKey: true,
						cancelable: true,
					})
				);
			});
			expect(nextTab).toHaveBeenCalledTimes(1);
		});

		it('dispatches cyclePrev/cycleNext on Cmd+[ and Cmd+]', () => {
			const cyclePrev = vi.fn();
			const cycleNext = vi.fn();

			renderHook(() =>
				useMobileKeyboardHandler({
					shortcuts: WEB_DEFAULT_SHORTCUTS,
					activeSession: { inputMode: 'ai' },
					actions: { cyclePrev, cycleNext },
				})
			);

			act(() => {
				document.dispatchEvent(
					new KeyboardEvent('keydown', { key: '[', metaKey: true, cancelable: true })
				);
			});
			expect(cyclePrev).toHaveBeenCalledTimes(1);

			act(() => {
				document.dispatchEvent(
					new KeyboardEvent('keydown', { key: ']', metaKey: true, cancelable: true })
				);
			});
			expect(cycleNext).toHaveBeenCalledTimes(1);
		});

		it('closes the command palette on Escape when open', () => {
			const onCloseCommandPalette = vi.fn();

			renderHook(() =>
				useMobileKeyboardHandler({
					shortcuts: WEB_DEFAULT_SHORTCUTS,
					activeSession: null,
					isCommandPaletteOpen: true,
					onCloseCommandPalette,
					actions: {},
				})
			);

			act(() => {
				document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
			});

			expect(onCloseCommandPalette).toHaveBeenCalledTimes(1);
		});

		it('does not steal shortcuts from xterm when terminal is focused', () => {
			const toggleMode = vi.fn();

			renderHook(() =>
				useMobileKeyboardHandler({
					shortcuts: WEB_DEFAULT_SHORTCUTS,
					activeSession: { inputMode: 'terminal' },
					actions: { toggleMode },
				})
			);

			const xtermInput = document.createElement('textarea');
			xtermInput.className = 'xterm-helper-textarea';
			document.body.appendChild(xtermInput);

			const event = new KeyboardEvent('keydown', {
				key: 'j',
				metaKey: true,
				bubbles: true,
				cancelable: true,
			});

			act(() => {
				xtermInput.dispatchEvent(event);
			});

			expect(toggleMode).not.toHaveBeenCalled();
			xtermInput.remove();
		});

		it('ignores events when no handler is registered for the matched shortcut', () => {
			const quickAction = vi.fn();

			renderHook(() =>
				useMobileKeyboardHandler({
					shortcuts: WEB_DEFAULT_SHORTCUTS,
					activeSession: null,
					actions: { quickAction },
				})
			);

			// Cmd+J (toggleMode) should be a no-op since only quickAction is registered.
			act(() => {
				document.dispatchEvent(
					new KeyboardEvent('keydown', { key: 'j', metaKey: true, cancelable: true })
				);
			});

			expect(quickAction).not.toHaveBeenCalled();
		});

		it('skips plain typing inside an input field', () => {
			const newInstance = vi.fn();
			// Simulate a user-customized shortcut bound to a single bare key.
			const shortcuts = {
				...WEB_DEFAULT_SHORTCUTS,
				newInstance: { id: 'newInstance', label: 'New Agent', keys: ['n'] },
			};

			const input = document.createElement('input');
			document.body.appendChild(input);
			input.focus();

			renderHook(() =>
				useMobileKeyboardHandler({
					shortcuts,
					activeSession: null,
					actions: { newInstance },
				})
			);

			const event = new KeyboardEvent('keydown', { key: 'n', cancelable: true, bubbles: true });
			act(() => {
				input.dispatchEvent(event);
			});

			expect(newInstance).not.toHaveBeenCalled();
			input.remove();
		});

		it('still fires modifier shortcuts while an input field is focused', () => {
			const quickAction = vi.fn();

			const input = document.createElement('input');
			document.body.appendChild(input);
			input.focus();

			renderHook(() =>
				useMobileKeyboardHandler({
					shortcuts: WEB_DEFAULT_SHORTCUTS,
					activeSession: null,
					actions: { quickAction },
				})
			);

			const event = new KeyboardEvent('keydown', {
				key: 'k',
				metaKey: true,
				cancelable: true,
				bubbles: true,
			});
			act(() => {
				input.dispatchEvent(event);
			});

			expect(quickAction).toHaveBeenCalledTimes(1);
			input.remove();
		});

		it('does not match an empty or modifier-only shortcut definition', () => {
			const newInstance = vi.fn();
			const shortcuts = {
				newInstance: { id: 'newInstance', label: 'New Agent', keys: [] },
			};

			renderHook(() =>
				useMobileKeyboardHandler({
					shortcuts,
					activeSession: null,
					actions: { newInstance },
				})
			);

			act(() => {
				document.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', cancelable: true }));
			});

			expect(newInstance).not.toHaveBeenCalled();
		});
	});
});

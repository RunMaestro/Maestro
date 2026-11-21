// Source: src/__tests__/renderer/hooks/tabs/internal/useTerminalTabHandlers.test.ts
// Source: src/__tests__/renderer/hooks/tabs/internal/useScrollLogHandlers.test.ts
// Source: src/__tests__/renderer/hooks/tabs/internal/filePreviewTabHelpers.test.ts
// Source: src/__tests__/renderer/hooks/tabs/internal/unifiedCloseHelpers.test.ts
import { describe as describeSourceSuite } from 'vitest';
import { renderHook } from '@testing-library/react';
import { act } from '@testing-library/react';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import { beforeEach } from 'vitest';
import { describe } from 'vitest';
import { expect } from 'vitest';
import { it } from 'vitest';
import { vi } from 'vitest';
import { useTerminalTabHandlers } from '../../../../../renderer/hooks/tabs/internal/useTerminalTabHandlers';
import { useModalStore } from '../../../../../renderer/stores/modalStore';
import { createMockAITab } from './testUtils';
import { createMockTerminalTab } from './testUtils';
import { getSession } from './testUtils';
import { resetTabHandlerStores } from './testUtils';
import { setupSession } from './testUtils';
import { useScrollLogHandlers } from '../../../../../renderer/hooks/tabs/internal/useScrollLogHandlers';
import { resetStore } from '../../../../helpers/resetStores';
import { useNotificationStore } from '../../../../../renderer/stores/notificationStore';
import { useSessionStore } from '../../../../../renderer/stores/sessionStore';
import { switchTabProvider } from '../../../../../shared/maestro-lib/translation/session';
import { buildFileTabDisplayNames } from '../../../../../renderer/hooks/tabs/internal/filePreviewTabHelpers';
import { buildReplacementNavigationHistory } from '../../../../../renderer/hooks/tabs/internal/filePreviewTabHelpers';
import { getFileNameParts } from '../../../../../renderer/hooks/tabs/internal/filePreviewTabHelpers';
import { createMockFileTab } from './testUtils';
import { applyUnifiedTabClosures } from '../../../../../renderer/hooks/tabs/internal/unifiedCloseHelpers';
import { closeTabGroup } from '../../../../../renderer/hooks/tabs/internal/unifiedCloseHelpers';
import { excludeDraftRefs } from '../../../../../renderer/hooks/tabs/internal/unifiedCloseHelpers';
import { excludeHiddenAiRefs } from '../../../../../renderer/hooks/tabs/internal/unifiedCloseHelpers';
import { excludePreservedRefs } from '../../../../../renderer/hooks/tabs/internal/unifiedCloseHelpers';
import { getActiveUnifiedRef } from '../../../../../renderer/hooks/tabs/internal/unifiedCloseHelpers';
import { getRefsExceptActive } from '../../../../../renderer/hooks/tabs/internal/unifiedCloseHelpers';
import { getRefsLeftOfActive } from '../../../../../renderer/hooks/tabs/internal/unifiedCloseHelpers';
import { getRefsRightOfActive } from '../../../../../renderer/hooks/tabs/internal/unifiedCloseHelpers';
import { getTabGroupMemberRefs } from '../../../../../renderer/hooks/tabs/internal/unifiedCloseHelpers';
import { getTerminalTabIds } from '../../../../../renderer/hooks/tabs/internal/unifiedCloseHelpers';
import { getWizardTabIds } from '../../../../../renderer/hooks/tabs/internal/unifiedCloseHelpers';
import { createGroupFromTabRefs } from '../../../../../renderer/utils/panelLayout';
import { setLiveDraft } from '../../../../../renderer/utils/liveDraftStore';
import { createMockBrowserTab } from './testUtils';
describeSourceSuite('useTerminalTabHandlers', () => {
	describe('useTerminalTabHandlers', () => {
		beforeEach(() => {
			resetTabHandlerStores();
		});

		afterEach(() => {
			cleanup();
		});

		it('opens and selects terminal tabs through tabStore', () => {
			setupSession({ aiTabs: [createMockAITab({ id: 'ai-1' })] });
			const { result } = renderHook(() => useTerminalTabHandlers());

			act(() => {
				result.current.handleOpenTerminalTab({ shell: 'bash', cwd: '/repo', name: 'Local' });
			});

			const terminalTab = getSession().terminalTabs[0];
			expect(terminalTab).toMatchObject({ shellType: 'bash', cwd: '/repo', name: 'Local' });
			expect(getSession().activeTerminalTabId).toBe(terminalTab.id);
		});

		it('closes idle terminal tabs immediately', async () => {
			const terminalTab = createMockTerminalTab({ id: 'term-1' });
			setupSession({
				terminalTabs: [terminalTab],
				activeTerminalTabId: terminalTab.id,
				inputMode: 'terminal',
			});
			vi.mocked(window.maestro.process.isTerminalBusy).mockResolvedValue(false);
			const { result } = renderHook(() => useTerminalTabHandlers());

			await act(async () => {
				result.current.handleCloseTerminalTab('term-1');
				await Promise.resolve();
			});

			expect(window.maestro.process.isTerminalBusy).toHaveBeenCalledWith(
				'test-session-terminal-term-1'
			);
			expect(getSession().terminalTabs).toHaveLength(0);
		});

		it('opens a destructive confirmation when the terminal is busy', async () => {
			const terminalTab = createMockTerminalTab({ id: 'term-1' });
			setupSession({
				terminalTabs: [terminalTab],
				activeTerminalTabId: terminalTab.id,
				inputMode: 'terminal',
			});
			vi.mocked(window.maestro.process.isTerminalBusy).mockResolvedValue(true);
			const { result } = renderHook(() => useTerminalTabHandlers());

			await act(async () => {
				result.current.handleCloseTerminalTab('term-1');
				await Promise.resolve();
			});

			const modal = useModalStore.getState().modals.get('confirm');
			expect(modal?.data?.destructive).toBe(true);
			expect(getSession().terminalTabs).toHaveLength(1);

			act(() => {
				modal?.data?.onConfirm();
			});

			expect(getSession().terminalTabs).toHaveLength(0);
		});
	});
});
describeSourceSuite('useScrollLogHandlers', () => {
	describe('useScrollLogHandlers', () => {
		beforeEach(() => {
			resetTabHandlerStores();
		});

		afterEach(() => {
			cleanup();
		});

		it('updates active AI tab scroll and at-bottom unread state', () => {
			const tab = createMockAITab({ id: 'ai-1', hasUnread: true });
			setupSession({ aiTabs: [tab] });
			const { result } = renderHook(() => useScrollLogHandlers());

			act(() => {
				result.current.handleScrollPositionChange(123);
				result.current.handleAtBottomChange(true);
			});

			expect(getSession().aiTabs[0]).toMatchObject({
				scrollTop: 123,
				isAtBottom: true,
				hasUnread: false,
			});
		});

		it('updates terminal scroll when terminal mode is active', () => {
			setupSession({ inputMode: 'terminal' });
			const { result } = renderHook(() => useScrollLogHandlers());

			act(() => {
				result.current.handleScrollPositionChange(456);
			});

			expect(getSession().terminalScrollTop).toBe(456);
		});

		it('deletes an AI user message pair and command history entry', async () => {
			const tab = createMockAITab({
				id: 'ai-1',
				agentSessionId: 'agent-1',
				logs: [
					{ id: 'u1', source: 'user', text: 'run tests', timestamp: Date.now() },
					{ id: 'a1', source: 'claude', text: 'ok', timestamp: Date.now() },
					{ id: 'u2', source: 'user', text: 'next', timestamp: Date.now() },
				] as any,
			});
			setupSession({
				aiTabs: [tab],
				cwd: '/repo',
				aiCommandHistory: ['run tests', 'next'],
			});
			vi.mocked(window.maestro.agentSessions.deleteMessagePair).mockResolvedValue({
				success: true,
			});
			const { result } = renderHook(() => useScrollLogHandlers());

			let nextIndex: number | null = null;
			await act(async () => {
				nextIndex = await result.current.handleDeleteLog('u1');
			});

			expect(nextIndex).toBe(0);
			expect(getSession().aiTabs[0].logs.map((log) => log.id)).toEqual(['u2']);
			expect(getSession().aiCommandHistory).toEqual(['next']);
			// Routed to the agent's own provider, with its id so main resolves its account.
			expect(window.maestro.agentSessions.deleteMessagePair).toHaveBeenCalledWith(
				'claude-code',
				'/repo',
				'agent-1',
				'u1',
				'run tests',
				undefined,
				getSession().id
			);
			expect(window.maestro.claude.deleteMessagePair).not.toHaveBeenCalled();
		});

		describe('provider transcript deletion', () => {
			const pairLogs = () =>
				[
					{ id: 'u1', source: 'user', text: 'try again', timestamp: 1 },
					{ id: 'e1', source: 'error', text: 'Agent exited with code 1', timestamp: 2 },
				] as any;

			beforeEach(() => {
				resetStore(useNotificationStore);
				useNotificationStore.getState().setDefaultDuration(0);
				useNotificationStore.getState().setOsNotifications(false);
			});

			afterEach(() => {
				resetStore(useNotificationStore);
				vi.mocked(window.maestro.agentSessions.deleteMessagePair).mockResolvedValue({
					success: true,
				});
			});

			it('removes a message the provider never recorded (a turn that failed at start)', async () => {
				setupSession({
					toolType: 'codex',
					cwd: '/repo',
					aiTabs: [createMockAITab({ id: 'ai-1', agentSessionId: 'codex-1', logs: pairLogs() })],
				});
				vi.mocked(window.maestro.agentSessions.deleteMessagePair).mockResolvedValue({
					success: true,
					linesRemoved: 0,
					notInTranscript: true,
				});
				const { result } = renderHook(() => useScrollLogHandlers());

				await act(async () => {
					await result.current.handleDeleteLog('u1');
				});

				expect(getSession().aiTabs[0].logs).toEqual([]);
				expect(useNotificationStore.getState().toasts).toEqual([]);
			});

			it('keeps the message and says so when the provider cannot delete it', async () => {
				setupSession({
					toolType: 'codex',
					cwd: '/repo',
					aiTabs: [createMockAITab({ id: 'ai-1', agentSessionId: 'codex-1', logs: pairLogs() })],
				});
				vi.mocked(window.maestro.agentSessions.deleteMessagePair).mockResolvedValue({
					success: false,
					error: 'Session file not found',
				});
				const { result } = renderHook(() => useScrollLogHandlers());

				let nextIndex: number | null = 0;
				await act(async () => {
					nextIndex = await result.current.handleDeleteLog('u1');
				});

				expect(nextIndex).toBeNull();
				expect(getSession().aiTabs[0].logs.map((log) => log.id)).toEqual(['u1', 'e1']);
				expect(useNotificationStore.getState().toasts).toEqual([
					expect.objectContaining({
						color: 'red',
						title: 'Message was not deleted',
						message: expect.stringContaining('Session file not found'),
						tabId: 'ai-1',
					}),
				]);
			});

			it('keeps output that streamed in while the provider edit was pending', async () => {
				setupSession({
					toolType: 'codex',
					cwd: '/repo',
					aiTabs: [
						createMockAITab({
							id: 'ai-1',
							agentSessionId: 'codex-1',
							logs: [...pairLogs(), { id: 'u2', source: 'user', text: 'next', timestamp: 3 }],
						}),
					],
				});
				let finish: (value: { success: boolean }) => void = () => {};
				vi.mocked(window.maestro.agentSessions.deleteMessagePair).mockReturnValue(
					new Promise((resolve) => {
						finish = resolve;
					})
				);
				const { result } = renderHook(() => useScrollLogHandlers());

				let pending: Promise<number | null> = Promise.resolve(null);
				act(() => {
					pending = result.current.handleDeleteLog('u1');
				});
				act(() => {
					useSessionStore.getState().setSessions((prev) =>
						prev.map((session) => ({
							...session,
							aiTabs: session.aiTabs.map((tab) => ({
								...tab,
								logs: [...tab.logs, { id: 'a2', source: 'stdout', text: 'streamed', timestamp: 4 }],
							})),
						}))
					);
				});
				await act(async () => {
					finish({ success: true });
					await pending;
				});

				expect(getSession().aiTabs[0].logs.map((log) => log.id)).toEqual(['u2', 'a2']);
			});

			it('passes the remote working directory and remote id for an SSH agent', async () => {
				setupSession({
					toolType: 'claude-code',
					cwd: '/local/repo',
					projectRoot: '/local/repo',
					remoteCwd: '/home/me/repo',
					sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
					aiTabs: [createMockAITab({ id: 'ai-1', agentSessionId: 'claude-1', logs: pairLogs() })],
				});
				const { result } = renderHook(() => useScrollLogHandlers());

				await act(async () => {
					await result.current.handleDeleteLog('u1');
				});

				expect(window.maestro.agentSessions.deleteMessagePair).toHaveBeenCalledWith(
					'claude-code',
					'/home/me/repo',
					'claude-1',
					'u1',
					'try again',
					'remote-1',
					getSession().id
				);
			});

			it('removes a message from a tab that never reached a provider session', async () => {
				setupSession({
					toolType: 'codex',
					aiTabs: [createMockAITab({ id: 'ai-1', agentSessionId: null, logs: pairLogs() })],
				});
				const { result } = renderHook(() => useScrollLogHandlers());

				await act(async () => {
					await result.current.handleDeleteLog('u1');
				});

				expect(getSession().aiTabs[0].logs).toEqual([]);
				expect(window.maestro.agentSessions.deleteMessagePair).not.toHaveBeenCalled();
			});
		});

		describe('Grok native history mutation refusal', () => {
			beforeEach(() => {
				resetStore(useNotificationStore);
				useNotificationStore.getState().setDefaultDuration(0);
				useNotificationStore.getState().setOsNotifications(false);
				vi.mocked(window.maestro.claude.deleteMessagePair).mockReset();
				vi.mocked(window.maestro.agentSessions.deleteMessagePair).mockReset();
				// A failed persistence result must never be preceded by optimistic removal.
				vi.mocked(window.maestro.claude.deleteMessagePair).mockResolvedValue({
					success: false,
					error: 'Native mutation failed',
				});
			});

			afterEach(() => {
				resetStore(useNotificationStore);
				vi.mocked(window.maestro.claude.deleteMessagePair).mockResolvedValue({ success: true });
				vi.mocked(window.maestro.agentSessions.deleteMessagePair).mockResolvedValue({
					success: true,
				});
			});

			it.each([
				['current Grok', 'grok', 'grok', 'native-id', 'idle'],
				['legacy Grok', 'grok', undefined, 'native-id', 'idle'],
				['unallocated Grok', 'grok', 'grok', null, 'busy'],
				['active writer', 'grok', 'grok', 'native-id', 'busy'],
				['retained Grok turn', 'claude-code', 'grok', 'native-id', 'idle'],
			] as const)(
				'preserves %s before any persistence or UI success',
				async (_, toolType, turnProvider, agentSessionId, state) => {
					const tab = createMockAITab({
						id: 'ai-1',
						agentSessionId,
						turnProvider,
						state,
						awaitingSessionId: agentSessionId === null,
						inputValue: 'unfinished edit',
						logs: [
							{ id: 'u1', source: 'user', text: 'keep this prompt', timestamp: 1 },
							{ id: 'a1', source: 'stdout', text: 'retained answer', timestamp: 2 },
						],
					});
					setupSession({ toolType, aiTabs: [tab], aiCommandHistory: ['keep this prompt'] });
					const snapshot = structuredClone(getSession());
					const { result } = renderHook(() => useScrollLogHandlers());
					await act(async () => {
						await expect(result.current.handleDeleteLog('u1')).resolves.toBeNull();
					});
					expect(getSession()).toEqual(snapshot);
					expect(useNotificationStore.getState().toasts).toEqual([
						expect.objectContaining({
							color: 'yellow',
							type: 'warning',
							title: 'Grok history deletion unavailable',
							message: expect.stringContaining('This conversation is unchanged'),
							sessionId: snapshot.id,
							tabId: 'ai-1',
						}),
					]);
					await act(async () => {
						await Promise.resolve();
					});
					expect(getSession()).toEqual(snapshot);
					expect(window.maestro.claude.deleteMessagePair).not.toHaveBeenCalled();
					expect(window.maestro.agentSessions.deleteMessagePair).not.toHaveBeenCalled();
				}
			);

			it('keeps parked Grok history after a new Claude turn, account/host changes and reload', async () => {
				const original = createMockAITab({
					id: 'ai-1',
					agentSessionId: 'colliding-native-id',
					turnProvider: 'grok',
					nativeSessionBinding: {
						version: 1,
						state: 'bound',
						provider: 'grok',
						nativeSessionId: 'colliding-native-id',
						accountRef: 'account-a',
						host: { kind: 'ssh', identity: 'endpoint-a' },
						cwd: '/repo',
					},
					logs: [{ id: 'u1', source: 'user', text: 'Grok prompt', timestamp: 1 }],
				});
				const switched = switchTabProvider(original, 'grok', 'claude-code');
				const tab = createMockAITab({
					...switched,
					agentSessionId: 'claude-new-id',
					turnProvider: 'claude-code',
					logs: [
						...switched.logs,
						{ id: 'u2', source: 'user', text: 'Claude prompt', timestamp: 2 },
					],
				});
				const other = createMockAITab({
					...original,
					id: 'ai-2',
					nativeSessionBinding: {
						version: 1,
						state: 'bound',
						provider: 'grok',
						nativeSessionId: 'colliding-native-id',
						accountRef: 'account-b',
						host: { kind: 'local', identity: 'endpoint-b' },
						cwd: '/repo',
					},
				});
				setupSession({
					toolType: 'claude-code',
					aiTabs: [tab, switchTabProvider(other, 'grok', 'claude-code')],
					aiCommandHistory: ['Grok prompt', 'Claude prompt'],
				});
				const initial = renderHook(() => useScrollLogHandlers());
				await act(async () => {
					await expect(initial.result.current.handleDeleteLog('u1')).resolves.toBeNull();
				});
				const persisted = JSON.parse(JSON.stringify(getSession()));
				initial.unmount();
				resetTabHandlerStores();
				setupSession({
					...persisted,
					customEnvVars: { GROK_HOME: '/different-account' },
					sshRemoteId: 'different-host',
				});
				const snapshot = structuredClone(getSession());
				const { result } = renderHook(() => useScrollLogHandlers());
				for (const logId of ['u1', 'u2']) {
					await act(async () => {
						await expect(result.current.handleDeleteLog(logId)).resolves.toBeNull();
					});
				}
				await act(async () => {
					await Promise.resolve();
				});
				expect(getSession()).toEqual(snapshot);
				expect(getSession().aiTabs[0].providerSessions?.grok?.nativeSessionBinding).toEqual(
					original.nativeSessionBinding
				);
				expect(useNotificationStore.getState().toasts).toHaveLength(3);
				expect(
					useNotificationStore.getState().toasts.every((toast) => toast.type === 'warning')
				).toBe(true);
				expect(window.maestro.claude.deleteMessagePair).not.toHaveBeenCalled();
				expect(window.maestro.agentSessions.deleteMessagePair).not.toHaveBeenCalled();
			});

			it.each(['', '../u1', 'u1\0', 'missing'])(
				'ignores absent or malformed rendered ID %j without a mutation',
				async (logId) => {
					setupSession({
						toolType: 'grok',
						aiTabs: [
							createMockAITab({
								id: 'ai-1',
								logs: [{ id: 'u1', source: 'user', text: 'keep', timestamp: 1 }],
							}),
						],
					});
					const snapshot = structuredClone(useSessionStore.getState().sessions);
					const { result } = renderHook(() => useScrollLogHandlers());
					await act(async () => {
						await expect(result.current.handleDeleteLog(logId)).resolves.toBeNull();
					});
					expect(useSessionStore.getState().sessions).toEqual(snapshot);
					expect(useNotificationStore.getState().toasts).toEqual([]);
					expect(window.maestro.claude.deleteMessagePair).not.toHaveBeenCalled();
					expect(window.maestro.agentSessions.deleteMessagePair).not.toHaveBeenCalled();
				}
			);
		});

		describe('deleting a command-mode card', () => {
			function cardLog(id: string, command: string) {
				return {
					id,
					source: 'stdout',
					text: 'output',
					timestamp: Date.now(),
					shellCommand: { command, cwd: '/repo', status: 'finished', exitCode: 0 },
				};
			}

			it.each(['claude-code', 'grok'] as const)(
				'removes a local %s command card without mutating native history',
				async (toolType) => {
					const tab = createMockAITab({
						id: 'ai-1',
						agentSessionId: 'agent-1',
						logs: [
							{ id: 'u1', source: 'user', text: 'run tests', timestamp: Date.now() },
							cardLog('c1', 'npm test'),
							{ id: 'a1', source: 'claude', text: 'ok', timestamp: Date.now() },
						] as any,
					});
					setupSession({
						toolType,
						aiTabs: [tab],
						aiCommandHistory: ['!npm test', 'run tests'],
					});
					const { result } = renderHook(() => useScrollLogHandlers());

					let nextIndex: number | null = 0;
					await act(async () => {
						nextIndex = await result.current.handleDeleteLog('c1');
					});

					// Only the card goes; the surrounding conversation is untouched.
					expect(getSession().aiTabs[0].logs.map((log) => log.id)).toEqual(['u1', 'a1']);
					expect(getSession().aiCommandHistory).toEqual(['run tests']);
					// No scroll target - removing a card should not move the reader.
					expect(nextIndex).toBeNull();
					expect(window.maestro.claude.deleteMessagePair).not.toHaveBeenCalled();
					expect(window.maestro.agentSessions.deleteMessagePair).not.toHaveBeenCalled();
				}
			);

			it('never asks the provider to delete a message pair for it', () => {
				// The agent was bypassed entirely, so there is no pair in its session.
				const tab = createMockAITab({
					id: 'ai-1',
					agentSessionId: 'agent-1',
					logs: [cardLog('c1', 'npm test')] as any,
				});
				setupSession({ aiTabs: [tab], cwd: '/repo', aiCommandHistory: ['!npm test'] });
				const { result } = renderHook(() => useScrollLogHandlers());

				act(() => {
					result.current.handleDeleteLog('c1');
				});

				expect(window.maestro.claude.deleteMessagePair).not.toHaveBeenCalled();
			});

			it('keeps the recall entry while another card still shows that command', () => {
				// aiCommandHistory is per agent and deduplicated, so pruning on the
				// first delete would contradict the cards still on screen.
				const tab = createMockAITab({
					id: 'ai-1',
					logs: [cardLog('c1', 'ls'), cardLog('c2', 'ls')] as any,
				});
				setupSession({ aiTabs: [tab], aiCommandHistory: ['!ls'] });
				const { result } = renderHook(() => useScrollLogHandlers());

				act(() => {
					result.current.handleDeleteLog('c1');
				});
				expect(getSession().aiCommandHistory).toEqual(['!ls']);

				act(() => {
					result.current.handleDeleteLog('c2');
				});
				expect(getSession().aiCommandHistory).toEqual([]);
			});

			it('counts survivors across every tab, not just the active one', () => {
				const active = createMockAITab({ id: 'ai-1', logs: [cardLog('c1', 'ls')] as any });
				const other = createMockAITab({ id: 'ai-2', logs: [cardLog('c2', 'ls')] as any });
				setupSession({ aiTabs: [active, other], aiCommandHistory: ['!ls'] });
				const { result } = renderHook(() => useScrollLogHandlers());

				act(() => {
					result.current.handleDeleteLog('c1');
				});

				// Guard against a silent no-op passing this assertion: the card really
				// went, and the recall entry really survived because ai-2 still has one.
				expect(getSession().aiTabs[0].logs).toEqual([]);
				expect(getSession().aiCommandHistory).toEqual(['!ls']);
			});
		});

		it('deletes shell logs and returns null for non-user logs', async () => {
			setupSession({
				inputMode: 'terminal',
				shellLogs: [
					{ id: 's1', source: 'system', text: 'boot', timestamp: Date.now() },
					{ id: 'u1', source: 'user', text: 'pwd', timestamp: Date.now() },
					{ id: 'o1', source: 'stdout', text: '/repo', timestamp: Date.now() },
				] as any,
				shellCommandHistory: ['pwd'],
			});
			const { result } = renderHook(() => useScrollLogHandlers());

			await expect(result.current.handleDeleteLog('s1')).resolves.toBeNull();
			await act(async () => {
				await expect(result.current.handleDeleteLog('u1')).resolves.toBeNull();
			});

			expect(getSession().shellLogs.map((log) => log.id)).toEqual(['s1']);
			expect(getSession().shellCommandHistory).toEqual([]);
		});
	});
});
describeSourceSuite('filePreviewTabHelpers', () => {
	describe('filePreviewTabHelpers', () => {
		describe('getFileNameParts', () => {
			it('splits a normal filename into name and extension', () => {
				expect(getFileNameParts('index.test.ts')).toEqual({
					nameWithoutExtension: 'index.test',
					extension: '.ts',
				});
			});

			it('keeps extension empty when no dot exists', () => {
				expect(getFileNameParts('README')).toEqual({
					nameWithoutExtension: 'README',
					extension: '',
				});
			});

			it('preserves the legacy hidden-file behavior', () => {
				expect(getFileNameParts('.env')).toEqual({
					nameWithoutExtension: '',
					extension: '.env',
				});
			});
		});

		describe('buildReplacementNavigationHistory', () => {
			it('adds current file and replacement file when history is empty', () => {
				const tab = createMockFileTab({ path: '/old.ts', name: 'old', scrollTop: 42 });

				expect(
					buildReplacementNavigationHistory(
						tab,
						tab,
						{ path: '/new.ts', name: 'new.ts', content: 'new' },
						'new'
					)
				).toEqual([
					{ path: '/old.ts', name: 'old', scrollTop: 42 },
					{ path: '/new.ts', name: 'new', scrollTop: 0 },
				]);
			});

			it('truncates forward history before adding the replacement file', () => {
				const tab = createMockFileTab({
					path: '/b.ts',
					name: 'b',
					scrollTop: 10,
					navigationHistory: [
						{ path: '/a.ts', name: 'a', scrollTop: 1 },
						{ path: '/b.ts', name: 'b', scrollTop: 2 },
						{ path: '/c.ts', name: 'c', scrollTop: 3 },
					],
					navigationIndex: 1,
				});

				expect(
					buildReplacementNavigationHistory(
						tab,
						tab,
						{ path: '/d.ts', name: 'd.ts', content: 'd' },
						'd'
					)
				).toEqual([
					{ path: '/a.ts', name: 'a', scrollTop: 1 },
					{ path: '/b.ts', name: 'b', scrollTop: 2 },
					{ path: '/d.ts', name: 'd', scrollTop: 0 },
				]);
			});
		});

		describe('buildFileTabDisplayNames', () => {
			const tab = (id: string, path: string) => {
				const { nameWithoutExtension, extension } = getFileNameParts(
					path.split(/[/\\]+/).pop() ?? ''
				);
				return { id, path, name: nameWithoutExtension, extension };
			};

			it('leaves uniquely-named tabs as the bare filename', () => {
				const result = buildFileTabDisplayNames([tab('1', '/a/ioc.go'), tab('2', '/b/service.go')]);
				expect(result.get('1')).toBe('ioc');
				expect(result.get('2')).toBe('service');
			});

			it('prefixes the immediate folder when two filenames collide', () => {
				const result = buildFileTabDisplayNames([
					tab('1', '/proj/ioc/service.go'),
					tab('2', '/proj/api/service.go'),
				]);
				expect(result.get('1')).toBe('ioc/service');
				expect(result.get('2')).toBe('api/service');
			});

			it('deepens the prefix until labels are unique', () => {
				const result = buildFileTabDisplayNames([
					tab('1', '/proj/a/shared/service.go'),
					tab('2', '/proj/b/shared/service.go'),
				]);
				// One folder (shared) collides, so walk up another level.
				expect(result.get('1')).toBe('a/shared/service');
				expect(result.get('2')).toBe('b/shared/service');
			});

			it('does not prefix tabs that share a name but differ in extension', () => {
				const result = buildFileTabDisplayNames([
					tab('1', '/proj/service.go'),
					tab('2', '/proj/service.ts'),
				]);
				expect(result.get('1')).toBe('service');
				expect(result.get('2')).toBe('service');
			});

			it('handles paths of unequal depth without collisions', () => {
				const result = buildFileTabDisplayNames([
					tab('1', '/service.go'),
					tab('2', '/x/service.go'),
				]);
				expect(result.get('1')).toBe('service');
				expect(result.get('2')).toBe('x/service');
			});

			it('disambiguates three or more colliding files', () => {
				const result = buildFileTabDisplayNames([
					tab('1', '/proj/ioc/service.go'),
					tab('2', '/proj/api/service.go'),
					tab('3', '/proj/db/service.go'),
				]);
				expect(result.get('1')).toBe('ioc/service');
				expect(result.get('2')).toBe('api/service');
				expect(result.get('3')).toBe('db/service');
			});
		});
	});
});
describeSourceSuite('unifiedCloseHelpers', () => {
	describe('unifiedCloseHelpers', () => {
		beforeEach(() => {
			resetTabHandlerStores();
		});

		it('resolves the active unified ref using terminal only when terminal mode is active', () => {
			const aiTab = createMockAITab({ id: 'ai-1' });
			const terminalTab = createMockTerminalTab({ id: 'term-1' });
			setupSession({
				aiTabs: [aiTab],
				terminalTabs: [terminalTab],
				activeTerminalTabId: terminalTab.id,
				inputMode: 'ai',
			});

			expect(getActiveUnifiedRef(getSession())).toEqual({ type: 'ai', id: 'ai-1' });

			setupSession({
				aiTabs: [aiTab],
				terminalTabs: [terminalTab],
				activeTerminalTabId: terminalTab.id,
				inputMode: 'terminal',
			});

			expect(getActiveUnifiedRef(getSession())).toEqual({ type: 'terminal', id: 'term-1' });
		});

		it('returns refs left, right, and except active in unified order', () => {
			const ai1 = createMockAITab({ id: 'ai-1' });
			const ai2 = createMockAITab({ id: 'ai-2' });
			const fileTab = createMockFileTab({ id: 'file-1' });
			setupSession({
				aiTabs: [ai1, ai2],
				filePreviewTabs: [fileTab],
				activeFileTabId: fileTab.id,
				unifiedTabOrder: [
					{ type: 'ai', id: ai1.id },
					{ type: 'file', id: fileTab.id },
					{ type: 'ai', id: ai2.id },
				],
			});

			expect(getRefsLeftOfActive(getSession())).toEqual([{ type: 'ai', id: 'ai-1' }]);
			expect(getRefsRightOfActive(getSession())).toEqual([{ type: 'ai', id: 'ai-2' }]);
			expect(getRefsExceptActive(getSession())).toEqual([
				{ type: 'ai', id: 'ai-1' },
				{ type: 'ai', id: 'ai-2' },
			]);
		});

		it('pivots on an explicit clicked tab id, not the active tab', () => {
			const ai1 = createMockAITab({ id: 'ai-1' });
			const ai2 = createMockAITab({ id: 'ai-2' });
			const ai3 = createMockAITab({ id: 'ai-3' });
			setupSession({
				aiTabs: [ai1, ai2, ai3],
				// Active is the LAST tab - a naive "close right of active" would close nothing.
				activeTabId: ai3.id,
				unifiedTabOrder: [
					{ type: 'ai', id: ai1.id },
					{ type: 'ai', id: ai2.id },
					{ type: 'ai', id: ai3.id },
				],
			});

			// Pivot explicitly on the clicked middle tab (ai2).
			expect(getRefsRightOfActive(getSession(), 'ai-2')).toEqual([{ type: 'ai', id: 'ai-3' }]);
			expect(getRefsLeftOfActive(getSession(), 'ai-2')).toEqual([{ type: 'ai', id: 'ai-1' }]);
			expect(getRefsExceptActive(getSession(), 'ai-2')).toEqual([
				{ type: 'ai', id: 'ai-1' },
				{ type: 'ai', id: 'ai-3' },
			]);
		});

		it('computes close sets against the repaired order, ignoring stale unified refs', () => {
			// Raw unifiedTabOrder carries a stale ref ('ghost', no live tab) plus a
			// duplicate. The repaired order the tab bar renders is [ai-1, ai-2, ai-3].
			// Slicing the raw order (the old behavior) would mis-place the pivot and
			// could close the wrong set; the repaired order keeps it correct.
			const ai1 = createMockAITab({ id: 'ai-1' });
			const ai2 = createMockAITab({ id: 'ai-2' });
			const ai3 = createMockAITab({ id: 'ai-3' });
			setupSession({
				aiTabs: [ai1, ai2, ai3],
				activeTabId: ai1.id,
				unifiedTabOrder: [
					{ type: 'ai', id: 'ghost' },
					{ type: 'ai', id: ai1.id },
					{ type: 'ai', id: ai1.id }, // duplicate
					{ type: 'ai', id: ai2.id },
					{ type: 'ai', id: ai3.id },
				],
			});

			// Pivot ai-1 is visually first → close-right is everything else; close-left empty.
			expect(getRefsRightOfActive(getSession(), 'ai-1')).toEqual([
				{ type: 'ai', id: 'ai-2' },
				{ type: 'ai', id: 'ai-3' },
			]);
			expect(getRefsLeftOfActive(getSession(), 'ai-1')).toEqual([]);
			// Pivot ai-2 (visually middle) → exactly ai-3 to the right, ai-1 to the left.
			expect(getRefsRightOfActive(getSession(), 'ai-2')).toEqual([{ type: 'ai', id: 'ai-3' }]);
			expect(getRefsLeftOfActive(getSession(), 'ai-2')).toEqual([{ type: 'ai', id: 'ai-1' }]);
		});

		it('collects terminal and wizard tab ids from refs', () => {
			const wizardTab = createMockAITab({
				id: 'wizard',
				wizardState: { isActive: true } as any,
			});
			const terminalTab = createMockTerminalTab({ id: 'term-1' });
			setupSession({
				aiTabs: [wizardTab],
				terminalTabs: [terminalTab],
			});
			const refs = [
				{ type: 'ai' as const, id: 'wizard' },
				{ type: 'terminal' as const, id: 'term-1' },
			];

			expect(getTerminalTabIds(refs)).toEqual(['term-1']);
			expect(getWizardTabIds(getSession(), refs)).toEqual(['wizard']);
		});

		it('excludes only AI refs that hold an unsent draft from the close set', () => {
			const ai1 = createMockAITab({ id: 'ai-1' });
			const ai2 = createMockAITab({ id: 'ai-2' });
			const fileTab = createMockFileTab({ id: 'file-1' });
			setupSession({ aiTabs: [ai1, ai2], filePreviewTabs: [fileTab] });
			setLiveDraft('ai-2', 'pending text');

			const refs = [
				{ type: 'ai' as const, id: 'ai-1' },
				{ type: 'ai' as const, id: 'ai-2' },
				{ type: 'file' as const, id: 'file-1' },
			];

			// ai-2 (the draft tab) is preserved; ai-1 and the file tab still close.
			expect(excludeDraftRefs(getSession(), refs)).toEqual([
				{ type: 'ai', id: 'ai-1' },
				{ type: 'file', id: 'file-1' },
			]);
		});

		it('returns the same ref array when no tab has a draft', () => {
			const ai1 = createMockAITab({ id: 'ai-1' });
			setupSession({ aiTabs: [ai1] });
			const refs = [{ type: 'ai' as const, id: 'ai-1' }];
			expect(excludeDraftRefs(getSession(), refs)).toBe(refs);
		});

		it('excludes hidden consult tabs from the close set', () => {
			const ai1 = createMockAITab({ id: 'ai-1' });
			const consult = createMockAITab({ id: 'consult', hidden: true });
			setupSession({ aiTabs: [ai1, consult] });

			const refs = [
				{ type: 'ai' as const, id: 'ai-1' },
				{ type: 'ai' as const, id: 'consult' },
			];

			expect(excludeHiddenAiRefs(getSession(), refs)).toEqual([{ type: 'ai', id: 'ai-1' }]);
		});

		it('returns the same ref array when no tab is hidden', () => {
			const ai1 = createMockAITab({ id: 'ai-1' });
			setupSession({ aiTabs: [ai1] });
			const refs = [{ type: 'ai' as const, id: 'ai-1' }];
			expect(excludeHiddenAiRefs(getSession(), refs)).toBe(refs);
		});

		it('preserves both drafts and hidden consult tabs in one pass', () => {
			const ai1 = createMockAITab({ id: 'ai-1' });
			const ai2 = createMockAITab({ id: 'ai-2' });
			const consult = createMockAITab({ id: 'consult', hidden: true });
			setupSession({ aiTabs: [ai1, ai2, consult] });
			setLiveDraft('ai-2', 'pending text');

			const refs = [
				{ type: 'ai' as const, id: 'ai-1' },
				{ type: 'ai' as const, id: 'ai-2' },
				{ type: 'ai' as const, id: 'consult' },
			];

			expect(excludePreservedRefs(getSession(), refs)).toEqual([{ type: 'ai', id: 'ai-1' }]);
		});

		it('closes mixed tab refs while preserving browser unified history', () => {
			const ai1 = createMockAITab({ id: 'ai-1' });
			const ai2 = createMockAITab({ id: 'ai-2' });
			const fileTab = createMockFileTab({ id: 'file-1' });
			const browserTab = createMockBrowserTab({ id: 'browser-1' });
			setupSession({
				aiTabs: [ai1, ai2],
				filePreviewTabs: [fileTab],
				browserTabs: [browserTab],
				activeTabId: ai1.id,
				unifiedTabOrder: [
					{ type: 'ai', id: ai1.id },
					{ type: 'file', id: fileTab.id },
					{ type: 'browser', id: browserTab.id },
					{ type: 'ai', id: ai2.id },
				],
			});

			const nextSession = applyUnifiedTabClosures(getSession(), [
				{ type: 'file', id: fileTab.id },
				{ type: 'browser', id: browserTab.id },
				{ type: 'ai', id: ai2.id },
			]);

			expect(nextSession.filePreviewTabs).toEqual([]);
			expect(nextSession.browserTabs).toEqual([]);
			expect(nextSession.aiTabs.map((tab) => tab.id)).toEqual(['ai-1']);
			expect(nextSession.unifiedTabOrder).toEqual([{ type: 'ai', id: 'ai-1' }]);
			// Both the browser tab and the bulk-closed AI tab are recorded so they can
			// be reopened via Cmd+Shift+T. ai-2 is closed last, so it is most-recent.
			const history = nextSession.unifiedClosedTabHistory ?? [];
			const historyTypes = history.map((e) => e.type);
			expect(historyTypes).toContain('browser');
			expect(historyTypes).toContain('ai');
			const mostRecent = history[0];
			expect(mostRecent.type).toBe('ai');
			expect(mostRecent.tab.id).toBe('ai-2');
		});

		it('does not record wizard tabs into the unified history on bulk close', () => {
			const ai1 = createMockAITab({ id: 'ai-1' });
			const wizardTab = createMockAITab({ id: 'wizard', wizardState: { isActive: true } as any });
			setupSession({
				aiTabs: [ai1, wizardTab],
				activeTabId: ai1.id,
				unifiedTabOrder: [
					{ type: 'ai', id: ai1.id },
					{ type: 'ai', id: wizardTab.id },
				],
			});

			const nextSession = applyUnifiedTabClosures(getSession(), [{ type: 'ai', id: wizardTab.id }]);

			expect(nextSession.aiTabs.map((tab) => tab.id)).toEqual(['ai-1']);
			expect(nextSession.unifiedClosedTabHistory ?? []).toEqual([]);
		});

		describe('closeTabGroup', () => {
			it('closes every member, drops the group, and lands on the chip to its left', () => {
				const before = createMockAITab({ id: 'ai-before' });
				const member = createMockAITab({ id: 'ai-member' });
				const file = createMockFileTab({ id: 'file-member' });
				const after = createMockAITab({ id: 'ai-after' });
				const group = createGroupFromTabRefs(
					[
						{ type: 'ai', id: member.id },
						{ type: 'file', id: file.id },
					],
					'Pair'
				);
				setupSession({
					aiTabs: [before, member, after],
					filePreviewTabs: [file],
					tabGroups: [group],
					activeGroupId: group.id,
					activeTabId: member.id,
					unifiedTabOrder: [
						{ type: 'ai', id: before.id },
						{ type: 'group', id: group.id },
						{ type: 'ai', id: after.id },
					],
				});

				expect(getTabGroupMemberRefs(getSession(), group.id)).toEqual([
					{ type: 'ai', id: member.id },
					{ type: 'file', id: file.id },
				]);

				const next = closeTabGroup(getSession(), group.id);

				expect(next.tabGroups).toEqual([]);
				expect(next.activeGroupId).toBeNull();
				expect(next.aiTabs.map((t) => t.id)).toEqual(['ai-before', 'ai-after']);
				expect(next.filePreviewTabs).toEqual([]);
				expect(next.unifiedTabOrder).toEqual([
					{ type: 'ai', id: 'ai-before' },
					{ type: 'ai', id: 'ai-after' },
				]);
				expect(next.activeTabId).toBe('ai-before');
				expect(next.activeFileTabId).toBeNull();
				expect(next.inputMode).toBe('ai');
				// The closed AI pane can be reopened like any other closed tab.
				expect((next.unifiedClosedTabHistory ?? []).some((e) => e.tab.id === 'ai-member')).toBe(
					true
				);
			});

			it('lands on the chip to its right when the group led the strip', () => {
				const member1 = createMockAITab({ id: 'ai-m1' });
				const member2 = createMockAITab({ id: 'ai-m2' });
				const after = createMockAITab({ id: 'ai-after' });
				const group = createGroupFromTabRefs(
					[
						{ type: 'ai', id: member1.id },
						{ type: 'ai', id: member2.id },
					],
					'Pair'
				);
				setupSession({
					aiTabs: [member1, member2, after],
					tabGroups: [group],
					activeGroupId: group.id,
					activeTabId: member1.id,
					unifiedTabOrder: [
						{ type: 'group', id: group.id },
						{ type: 'ai', id: after.id },
					],
				});

				const next = closeTabGroup(getSession(), group.id);

				expect(next.aiTabs.map((t) => t.id)).toEqual(['ai-after']);
				expect(next.activeTabId).toBe('ai-after');
				expect(next.activeGroupId).toBeNull();
			});

			it('leaves the current view alone when the group is in the background', () => {
				const member1 = createMockAITab({ id: 'ai-m1' });
				const member2 = createMockAITab({ id: 'ai-m2' });
				const file = createMockFileTab({ id: 'file-open' });
				const group = createGroupFromTabRefs(
					[
						{ type: 'ai', id: member1.id },
						{ type: 'ai', id: member2.id },
					],
					'Pair'
				);
				// activeTabId still points at a member: focusing a file tab leaves it alone.
				setupSession({
					aiTabs: [member1, member2],
					filePreviewTabs: [file],
					tabGroups: [group],
					activeGroupId: null,
					activeTabId: member1.id,
					activeFileTabId: file.id,
					unifiedTabOrder: [
						{ type: 'group', id: group.id },
						{ type: 'file', id: file.id },
					],
				});

				const next = closeTabGroup(getSession(), group.id);

				expect(next.aiTabs).toEqual([]);
				expect(next.activeFileTabId).toBe('file-open');
				expect(next.unifiedTabOrder).toEqual([{ type: 'file', id: 'file-open' }]);
			});

			it('mints a fresh AI tab when the group held every tab the agent had', () => {
				const file = createMockFileTab({ id: 'file-m' });
				const terminal = createMockTerminalTab({ id: 'term-m' });
				const group = createGroupFromTabRefs(
					[
						{ type: 'file', id: file.id },
						{ type: 'terminal', id: terminal.id },
					],
					'Tools'
				);
				setupSession({
					aiTabs: [],
					filePreviewTabs: [file],
					terminalTabs: [terminal],
					tabGroups: [group],
					activeGroupId: group.id,
					unifiedTabOrder: [{ type: 'group', id: group.id }],
				});

				const next = closeTabGroup(getSession(), group.id);

				expect(next.filePreviewTabs).toEqual([]);
				expect(next.terminalTabs).toEqual([]);
				expect(next.aiTabs).toHaveLength(1);
				expect(next.activeTabId).toBe(next.aiTabs[0].id);
				expect(next.unifiedTabOrder).toEqual([{ type: 'ai', id: next.aiTabs[0].id }]);
			});

			it('does not count a hidden consult tab as a surviving tab', () => {
				const consult = createMockAITab({ id: 'consult-1', hidden: true });
				const file = createMockFileTab({ id: 'file-m' });
				const terminal = createMockTerminalTab({ id: 'term-m' });
				const group = createGroupFromTabRefs(
					[
						{ type: 'file', id: file.id },
						{ type: 'terminal', id: terminal.id },
					],
					'Tools'
				);
				setupSession({
					aiTabs: [consult],
					activeTabId: '',
					filePreviewTabs: [file],
					terminalTabs: [terminal],
					tabGroups: [group],
					activeGroupId: group.id,
					unifiedTabOrder: [
						{ type: 'ai', id: consult.id },
						{ type: 'group', id: group.id },
					],
				});

				const next = closeTabGroup(getSession(), group.id);

				const fresh = next.aiTabs.find((t) => t.id !== 'consult-1');
				expect(fresh).toBeDefined();
				expect(fresh!.hidden).toBeFalsy();
				expect(next.activeTabId).toBe(fresh!.id);
				expect(next.aiTabs.some((t) => t.id === 'consult-1')).toBe(true);
			});

			it('is a no-op for an unknown group id', () => {
				setupSession();
				const session = getSession();
				expect(closeTabGroup(session, 'missing')).toBe(session);
			});
		});
	});
});

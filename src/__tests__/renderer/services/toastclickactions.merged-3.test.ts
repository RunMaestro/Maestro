// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/renderer/services/toastClickActions.test.ts
// Source: src/__tests__/renderer/services/agentDelegation.test.ts
// Source: src/__tests__/renderer/services/feedbackConversation.test.ts
// Source: src/__tests__/renderer/services/agentRun.test.ts
// Source: src/__tests__/renderer/services/webLoginSession.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { dispatchToastClickAction } from '../../../renderer/services/toastClickActions';
import { useSessionStore as s1_useSessionStore } from '../../../renderer/stores/sessionStore';
import { useNotificationStore } from '../../../renderer/stores/notificationStore';
import { useFileExplorerStore } from '../../../renderer/stores/fileExplorerStore';
import { createMockSession as s1_createMockSession } from '../../helpers/mockSession';
import type { Session, TerminalTab } from '../../../renderer/types';
import type { BrowserTab } from '../../../shared/browserPage';
import {
	buildDelegationLogEntry,
	recordAgentDelegation,
	resolveDelegationSourceTab,
	settleAgentDelegation,
} from '../../../renderer/services/agentDelegation';
import { useSessionStore as s2_useSessionStore } from '../../../renderer/stores/sessionStore';
import { isSelfContainedCard } from '../../../renderer/utils/logEntries';
import { createMockSession as s2_createMockSession } from '../../helpers/mockSession';
import { createMockAITab } from '../../helpers/mockTab';
import type { AgentDelegationNotice } from '../../../shared/agentDelegation';
import {
	FeedbackConversationManager,
	resolveFeedbackSubmission,
	type FeedbackMessage,
	type FeedbackParsedResponse,
} from '../../../renderer/services/feedbackConversation';
import type { AgentRun, AgentRunEvent } from '../../../shared/agent-run';
import type { Campaign } from '../../../shared/campaign';
import { agentRunService } from '../../../renderer/services/agentRun';
import { currentWebLoginUser, signOutWebLogin } from '../../../renderer/services/webLoginSession';
// Source: src/__tests__/renderer/services/toastClickActions.test.ts
describe('', () => {
	function terminalTab(overrides: Partial<TerminalTab> = {}): TerminalTab {
		return {
			id: 'term-1',
			name: null,
			shellType: 'zsh',
			pid: 0,
			cwd: '/test/project',
			createdAt: 0,
			state: 'idle',
			...overrides,
		} as TerminalTab;
	}
	function browserTab(overrides: Partial<BrowserTab> = {}): BrowserTab {
		return {
			id: 'browser-1',
			url: 'https://example.com',
			title: 'Example',
			createdAt: 0,
			partition: 'persist:test',
			canGoBack: false,
			canGoForward: false,
			isLoading: false,
			favicon: null,
			...overrides,
		} as BrowserTab;
	}
	function seedSessions(sessions: Session[]): void {
		s1_useSessionStore.setState({ sessions, activeSessionId: '' });
	}
	function currentSession(id: string): Session | undefined {
		return s1_useSessionStore.getState().sessions.find((s) => s.id === id);
	}
	describe('dispatchToastClickAction', () => {
		let dispatchSpy: ReturnType<typeof vi.spyOn>;
		beforeEach(() => {
			seedSessions([]);
			useNotificationStore.setState({ toasts: [] });
			dispatchSpy = vi.spyOn(window, 'dispatchEvent');
		});
		afterEach(() => {
			dispatchSpy.mockRestore();
			vi.clearAllMocks();
		});
		function dispatchedEvent(type: string): CustomEvent | undefined {
			const match = dispatchSpy.mock.calls.find(
				([e]: [Event]) => e instanceof CustomEvent && e.type === type
			);
			return match?.[0] as CustomEvent | undefined;
		}
		it('jump-session delegates to the App-provided handler', () => {
			const onSessionClick = vi.fn();
			dispatchToastClickAction(
				{ kind: 'jump-session', sessionId: 's1', tabId: 't1' },
				{ onSessionClick }
			);
			expect(onSessionClick).toHaveBeenCalledWith('s1', 't1');
		});
		it('open-file dispatches the shared file-open event', () => {
			seedSessions([s1_createMockSession({ id: 's1' })]);
			dispatchToastClickAction({ kind: 'open-file', sessionId: 's1', path: '/tmp/a.ts' });
			expect(dispatchedEvent('maestro:openFileTab')?.detail).toEqual({
				sessionId: 's1',
				filePath: '/tmp/a.ts',
			});
		});
		describe('open-terminal', () => {
			it('focuses a terminal tab by id and switches to terminal mode', () => {
				seedSessions([
					s1_createMockSession({
						id: 's1',
						terminalTabs: [terminalTab({ id: 'term-1' }), terminalTab({ id: 'term-2' })],
						activeFileTabId: 'file-9',
						activeBrowserTabId: 'browser-9',
					}),
				]);
				dispatchToastClickAction({ kind: 'open-terminal', sessionId: 's1', tabRef: 'term-2' });
				expect(s1_useSessionStore.getState().activeSessionId).toBe('s1');
				const session = currentSession('s1')!;
				expect(session.activeTerminalTabId).toBe('term-2');
				expect(session.inputMode).toBe('terminal');
				// The file and browser selections outrank a terminal tab, so both have
				// to be cleared or the old view stays on screen.
				expect(session.activeFileTabId).toBeNull();
				expect(session.activeBrowserTabId).toBeNull();
			});
			it('resolves a terminal tab by name', () => {
				seedSessions([
					s1_createMockSession({
						id: 's1',
						terminalTabs: [terminalTab({ id: 'term-1', name: 'Dev server' })],
					}),
				]);
				dispatchToastClickAction({
					kind: 'open-terminal',
					sessionId: 's1',
					tabRef: 'Dev server',
				});
				expect(currentSession('s1')!.activeTerminalTabId).toBe('term-1');
			});
			it('falls back to the agent and warns when the tab is gone', () => {
				seedSessions([s1_createMockSession({ id: 's1', terminalTabs: [] })]);
				expect(
					dispatchToastClickAction({
						kind: 'open-terminal',
						sessionId: 's1',
						tabRef: 'Dev server',
					})
				).toBe(false);
				expect(s1_useSessionStore.getState().activeSessionId).toBe('s1');
				expect(currentSession('s1')!.activeTerminalTabId).toBeNull();
				const toasts = useNotificationStore.getState().toasts;
				expect(toasts).toHaveLength(1);
				expect(toasts[0].title).toBe('Terminal tab not found');
			});
			it('warns when the agent itself is gone', () => {
				seedSessions([]);
				dispatchToastClickAction({ kind: 'open-terminal', sessionId: 'missing' });
				expect(useNotificationStore.getState().toasts[0].title).toBe('Agent not found');
			});
		});
		describe('open-browser', () => {
			it('focuses an existing browser tab', () => {
				seedSessions([
					s1_createMockSession({
						id: 's1',
						browserTabs: [browserTab({ id: 'browser-1' })],
						inputMode: 'terminal',
						activeTerminalTabId: 'term-9',
						activeFileTabId: 'file-9',
					}),
				]);
				dispatchToastClickAction({ kind: 'open-browser', sessionId: 's1', tabId: 'browser-1' });
				expect(s1_useSessionStore.getState().activeSessionId).toBe('s1');
				const session = currentSession('s1')!;
				expect(session.activeBrowserTabId).toBe('browser-1');
				expect(session.inputMode).toBe('ai');
				expect(session.activeTerminalTabId).toBeNull();
				expect(session.activeFileTabId).toBeNull();
			});
			it('opens a new browser tab when only a url is given', () => {
				seedSessions([s1_createMockSession({ id: 's1' })]);
				dispatchToastClickAction({
					kind: 'open-browser',
					sessionId: 's1',
					url: 'https://example.com/build',
				});
				expect(dispatchedEvent('maestro:openBrowserTab')?.detail).toEqual({
					sessionId: 's1',
					url: 'https://example.com/build',
				});
			});
			it('opens the url when the named tab has been closed', () => {
				seedSessions([s1_createMockSession({ id: 's1', browserTabs: [] })]);
				dispatchToastClickAction({
					kind: 'open-browser',
					sessionId: 's1',
					tabId: 'gone',
					url: 'https://example.com/build',
				});
				expect(dispatchedEvent('maestro:openBrowserTab')?.detail).toEqual({
					sessionId: 's1',
					url: 'https://example.com/build',
				});
			});
			it('falls back to the agent and warns when the tab is gone and no url was given', () => {
				seedSessions([s1_createMockSession({ id: 's1', browserTabs: [] })]);
				expect(
					dispatchToastClickAction({ kind: 'open-browser', sessionId: 's1', tabId: 'gone' })
				).toBe(false);
				expect(s1_useSessionStore.getState().activeSessionId).toBe('s1');
				expect(useNotificationStore.getState().toasts[0].title).toBe('Browser tab not found');
			});
		});
		it('open-url hands off to the system browser', () => {
			dispatchToastClickAction({ kind: 'open-url', url: 'https://example.com/logs' });
			expect(globalThis.window.maestro.shell.openExternal).toHaveBeenCalledWith(
				'https://example.com/logs'
			);
		});
		it('closes the Document Graph overlay before landing on a tab', () => {
			useFileExplorerStore.setState({ isGraphViewOpen: true });
			seedSessions([
				s1_createMockSession({ id: 's1', terminalTabs: [terminalTab({ id: 'term-1' })] }),
			]);
			dispatchToastClickAction({ kind: 'open-terminal', sessionId: 's1', tabRef: 'term-1' });
			expect(useFileExplorerStore.getState().isGraphViewOpen).toBe(false);
		});
	});
});
// Source: src/__tests__/renderer/services/agentDelegation.test.ts
describe('', () => {
	const proxmox = () =>
		s2_createMockSession({ id: 'proxmox', name: '🖥 Proxmox', toolType: 'claude-code' });
	const maestro = () =>
		s2_createMockSession({
			id: 'maestro',
			name: 'Maestro',
			aiTabs: [
				createMockAITab({ id: 'caller-tab', logs: [] }),
				createMockAITab({ id: 'other-tab', logs: [] }),
			],
			activeTabId: 'other-tab',
		});
	const notice = (overrides: Partial<AgentDelegationNotice> = {}): AgentDelegationNotice => ({
		kind: 'dispatch',
		fromSessionId: 'maestro',
		fromTabId: 'caller-tab',
		targetSessionId: 'proxmox',
		prompt: 'Fix the advisory recovery bug',
		...overrides,
	});
	const logsOf = (sessionId: string, tabId: string) =>
		s2_useSessionStore
			.getState()
			.sessions.find((s) => s.id === sessionId)!
			.aiTabs.find((t) => t.id === tabId)!.logs;
	describe('resolveDelegationSourceTab', () => {
		it('uses the tab the spawn named', () => {
			expect(resolveDelegationSourceTab(maestro(), 'caller-tab')?.id).toBe('caller-tab');
		});
		it('refuses to guess another tab when the named one has closed', () => {
			expect(resolveDelegationSourceTab(maestro(), 'closed-tab')).toBeUndefined();
		});
		it('refuses to guess a tab when the spawn named none (a Cue run, a bare --from)', () => {
			const session = maestro();
			expect(resolveDelegationSourceTab(session)).toBeUndefined();
			session.aiTabs[0] = { ...session.aiTabs[0], state: 'busy' };
			expect(resolveDelegationSourceTab(session)).toBeUndefined();
		});
	});
	describe('buildDelegationLogEntry', () => {
		it('builds a self-contained card with a one-line subject', () => {
			const entry = buildDelegationLogEntry(
				notice({ targetTabId: 'queued-tab', prompt: 'Fix the\n\n advisory   bug', queued: true }),
				proxmox()
			);
			expect(entry.delegation).toEqual({
				kind: 'dispatch',
				toSessionId: 'proxmox',
				toTabId: 'queued-tab',
				toAgentName: '🖥 Proxmox',
				toToolType: 'claude-code',
				subject: 'Fix the advisory bug',
				queued: true,
			});
			expect(entry.text).toBe('Delegated to 🖥 Proxmox: Fix the advisory bug');
			expect(isSelfContainedCard(entry)).toBe(true);
		});
		it('cuts a long prompt down to one line', () => {
			const entry = buildDelegationLogEntry(notice({ prompt: 'x'.repeat(500) }), proxmox());
			expect(entry.delegation!.subject.length).toBeLessThanOrEqual(120);
			expect(entry.delegation!.subject.endsWith('…')).toBe(true);
		});
		it('words an ask as a question', () => {
			const entry = buildDelegationLogEntry(
				notice({ kind: 'ask', prompt: 'Which branch?' }),
				proxmox()
			);
			expect(entry.text).toBe('Asked 🖥 Proxmox: Which branch?');
		});
	});
	describe('recordAgentDelegation / settleAgentDelegation', () => {
		beforeEach(() => {
			s2_useSessionStore.setState({ sessions: [proxmox(), maestro()] } as never);
		});
		it('appends the pill to the delegating tab only', () => {
			const ref = recordAgentDelegation(notice());
			expect(ref).toEqual({
				sessionId: 'maestro',
				tabId: 'caller-tab',
				entryId: expect.any(String),
			});
			expect(logsOf('maestro', 'caller-tab')).toHaveLength(1);
			expect(logsOf('maestro', 'caller-tab')[0].delegation?.toAgentName).toBe('🖥 Proxmox');
			expect(logsOf('maestro', 'other-tab')).toHaveLength(0);
		});
		it('records nothing when the target or the caller is gone', () => {
			expect(recordAgentDelegation(notice({ targetSessionId: 'deleted' }))).toBeNull();
			expect(recordAgentDelegation(notice({ fromSessionId: 'deleted' }))).toBeNull();
			expect(logsOf('maestro', 'caller-tab')).toHaveLength(0);
		});
		it('settles a pending ask pill in place', () => {
			const ref = recordAgentDelegation(notice({ kind: 'ask' }), { pending: true })!;
			expect(logsOf('maestro', 'caller-tab')[0].delegation?.status).toBe('pending');
			settleAgentDelegation(ref, { status: 'error', error: 'timed out', toTabId: 'consult-1' });
			expect(logsOf('maestro', 'caller-tab')).toHaveLength(1);
			expect(logsOf('maestro', 'caller-tab')[0].delegation).toMatchObject({
				status: 'error',
				error: 'timed out',
				toTabId: 'consult-1',
			});
		});
		it('settling is a no-op once the entry is gone', () => {
			const ref = recordAgentDelegation(notice({ kind: 'ask' }), { pending: true })!;
			s2_useSessionStore.setState({ sessions: [proxmox(), maestro()] } as never);
			settleAgentDelegation(ref, { status: 'done' });
			expect(logsOf('maestro', 'caller-tab')).toHaveLength(0);
		});
	});
});
// Source: src/__tests__/renderer/services/feedbackConversation.test.ts
describe('', () => {
	const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
	function mockCodexAgent(overrides: Record<string, unknown> = {}) {
		return {
			id: 'codex',
			name: 'OpenAI Codex',
			available: true,
			command: 'codex',
			path: '/opt/homebrew/bin/codex',
			args: [],
			...overrides,
		};
	}
	describe('FeedbackConversationManager provider startup errors', () => {
		beforeEach(() => {
			vi.clearAllMocks();
			const processMock = window.maestro.process as any;
			processMock.spawn.mockResolvedValue({ pid: 12345, success: true });
			processMock.onData = vi.fn(() => vi.fn());
			processMock.onExit = vi.fn(() => vi.fn());
			processMock.onThinkingChunk = vi.fn(() => vi.fn());
			window.maestro.agents.get.mockResolvedValue(mockCodexAgent());
		});
		it('reports the resolved Codex binary and provider output on non-zero exit', async () => {
			const processMock = window.maestro.process as any;
			const codexBinary = '/Users/jeff/.nvm/versions/node/v25.3.0/bin/codex-multi-auth-codex';
			window.maestro.agents.get.mockResolvedValue(
				mockCodexAgent({
					path: codexBinary,
				})
			);
			const manager = new FeedbackConversationManager();
			const sessionId = manager.start({ agentType: 'codex', systemPrompt: 'system prompt' });
			const onError = vi.fn();
			const responsePromise = manager.sendMessage('it broke', [], { onError });
			await tick();
			expect(processMock.spawn).toHaveBeenCalledTimes(1);
			expect(processMock.spawn.mock.calls[0][0].command).toBe(codexBinary);
			const dataCallback = processMock.onData.mock.calls[0][0];
			dataCallback(
				sessionId,
				'\u001b[31mError: not logged in. Run `codex login` first.\u001b[0m\n'
			);
			const exitCallback = processMock.onExit.mock.calls[0][0];
			exitCallback(sessionId, 1);
			const response = await responsePromise;
			expect(response.message).toContain(codexBinary);
			expect(response.message).toContain('not logged in');
			expect(response.message).not.toContain(
				'Something went wrong processing your message. Please try again.'
			);
			expect(onError).toHaveBeenCalledWith(expect.stringContaining('not logged in'));
		});
		it('still names the binary when the failed provider printed nothing', async () => {
			const processMock = window.maestro.process as any;
			const codexBinary = '/opt/homebrew/bin/codex';
			window.maestro.agents.get.mockResolvedValue(
				mockCodexAgent({
					path: codexBinary,
				})
			);
			const manager = new FeedbackConversationManager();
			const sessionId = manager.start({ agentType: 'codex', systemPrompt: 'system prompt' });
			const responsePromise = manager.sendMessage('hi', []);
			await tick();
			const exitCallback = processMock.onExit.mock.calls[0][0];
			exitCallback(sessionId, 127);
			const response = await responsePromise;
			expect(response.message).toContain(codexBinary);
			expect(response.message).toContain('exited with code 127');
			expect(response.message).toContain('No output was captured');
		});
		it('fails the turn with the resolved binary path when the provider is detected but not runnable', async () => {
			const processMock = window.maestro.process as any;
			const codexBinary = '/Users/jeff/.nvm/versions/node/v24.15.0/bin/codex';
			window.maestro.agents.get.mockResolvedValue(
				mockCodexAgent({
					available: false,
					path: codexBinary,
				})
			);
			const manager = new FeedbackConversationManager();
			manager.start({ agentType: 'codex', systemPrompt: 'system prompt' });
			// A failed turn rather than a throw, so the caller can fall through to
			// another account.
			const result = await manager.sendTurn('hi', []);
			expect(result.failed).toBe(true);
			expect(result.error).toContain(codexBinary);
			expect(result.response.message).toContain(codexBinary);
			expect(processMock.spawn).not.toHaveBeenCalled();
		});
		it('uses the provider id instead of undefined when no binary fields exist', async () => {
			window.maestro.agents.get.mockResolvedValue({
				id: 'codex',
				available: false,
				args: [],
			});
			const manager = new FeedbackConversationManager();
			manager.start({ agentType: 'codex', systemPrompt: 'system prompt' });
			const result = await manager.sendTurn('hi', []);
			expect(result.failed).toBe(true);
			expect(result.error).toContain('Maestro resolved its binary to "codex"');
		});
		it('returns an actionable error when spawning the selected binary rejects', async () => {
			const processMock = window.maestro.process as any;
			const codexBinary = 'C:\\missing\\codex.exe';
			processMock.spawn.mockRejectedValue(new Error('spawn ENOENT C:\\missing\\codex.exe'));
			window.maestro.agents.get.mockResolvedValue(
				mockCodexAgent({
					path: codexBinary,
				})
			);
			const manager = new FeedbackConversationManager();
			manager.start({ agentType: 'codex', systemPrompt: 'system prompt' });
			const onError = vi.fn();
			const response = await manager.sendMessage('hi', [], { onError });
			expect(response.message).toContain(codexBinary);
			expect(response.message).toContain('could not be started');
			expect(response.message).toContain('spawn ENOENT');
			expect(onError).toHaveBeenCalledWith('spawn ENOENT C:\\missing\\codex.exe');
		});
		it('returns an actionable error when spawning resolves with failure', async () => {
			const processMock = window.maestro.process as any;
			const codexBinary = 'C:\\missing\\codex.exe';
			processMock.spawn.mockResolvedValue({ success: false, pid: -1 });
			window.maestro.agents.get.mockResolvedValue(
				mockCodexAgent({
					path: codexBinary,
				})
			);
			const manager = new FeedbackConversationManager();
			manager.start({ agentType: 'codex', systemPrompt: 'system prompt' });
			const onError = vi.fn();
			const response = await manager.sendMessage('hi', [], { onError });
			expect(response.message).toContain(codexBinary);
			expect(response.message).toContain('could not be started');
			expect(response.message).toContain('success=false');
			expect(onError).toHaveBeenCalledWith('Process spawn returned success=false (pid -1)');
		});
		it('notifies onComplete with a not-ready response when spawning fails', async () => {
			const processMock = window.maestro.process as any;
			processMock.spawn.mockResolvedValue({ success: false, pid: -1 });
			window.maestro.agents.get.mockResolvedValue(
				mockCodexAgent({ path: 'C:\\missing\\codex.exe' })
			);
			const manager = new FeedbackConversationManager();
			manager.start({ agentType: 'codex', systemPrompt: 'system prompt' });
			const onComplete = vi.fn();
			await manager.sendMessage('hi', [], { onComplete });
			// Failure paths must reset readiness so a prior "ready" turn can't be
			// submitted after a provider startup failure.
			expect(onComplete).toHaveBeenCalledTimes(1);
			expect(onComplete.mock.calls[0][0]).toMatchObject({ ready: false });
		});
		it('redacts obvious secrets from provider output before surfacing failure details', async () => {
			const processMock = window.maestro.process as any;
			const manager = new FeedbackConversationManager();
			const sessionId = manager.start({ agentType: 'codex', systemPrompt: 'system prompt' });
			const onError = vi.fn();
			const responsePromise = manager.sendMessage('hi', [], { onError });
			await tick();
			const dataCallback = processMock.onData.mock.calls[0][0];
			dataCallback(
				sessionId,
				[
					'OPENAI_API_KEY: sk-openai-secret-key',
					'ANTHROPIC_API_KEY=sk-anthropic-secret-key',
					'api_key=sk-lowercase-secret-key',
					'access_token: lower-access-token',
					'secret=lower-secret-value',
					'Authorization: Bearer bearer-secret-token',
					'GitHub token ghp_1234567890abcdefghijklmnopqrst',
					'Fine path /Users/jeff/.nvm/versions/node/v25.3.0/bin/codex',
				].join('\n')
			);
			const exitCallback = processMock.onExit.mock.calls[0][0];
			exitCallback(sessionId, 1);
			const response = await responsePromise;
			const onErrorMessage = String(onError.mock.calls[0][0]);
			expect(response.message).toContain('OPENAI_API_KEY: [REDACTED]');
			expect(response.message).toContain('ANTHROPIC_API_KEY=[REDACTED]');
			expect(response.message).toContain('api_key=[REDACTED]');
			expect(response.message).toContain('access_token: [REDACTED]');
			expect(response.message).toContain('secret=[REDACTED]');
			expect(response.message).toContain('Authorization: Bearer [REDACTED]');
			expect(response.message).toContain('[REDACTED_GITHUB_TOKEN]');
			expect(response.message).toContain('/Users/jeff/.nvm/versions/node/v25.3.0/bin/codex');
			expect(response.message).not.toContain('sk-openai-secret-key');
			expect(response.message).not.toContain('sk-anthropic-secret-key');
			expect(response.message).not.toContain('sk-lowercase-secret-key');
			expect(response.message).not.toContain('lower-access-token');
			expect(response.message).not.toContain('lower-secret-value');
			expect(response.message).not.toContain('bearer-secret-token');
			expect(response.message).not.toContain('ghp_1234567890abcdefghijklmnopqrst');
			expect(onErrorMessage).not.toContain('sk-openai-secret-key');
			expect(onErrorMessage).not.toContain('bearer-secret-token');
		});
		it('redacts spawn rejection details before invoking onError', async () => {
			const processMock = window.maestro.process as any;
			processMock.spawn.mockRejectedValue(
				new Error(
					'failed with Authorization: Bearer bearer-secret-token and github_pat_1234567890abcdefghijklmnopqrstuvwxyz'
				)
			);
			const manager = new FeedbackConversationManager();
			manager.start({ agentType: 'codex', systemPrompt: 'system prompt' });
			const onError = vi.fn();
			const response = await manager.sendMessage('hi', [], { onError });
			const onErrorMessage = String(onError.mock.calls[0][0]);
			expect(response.message).toContain('Authorization: Bearer [REDACTED]');
			expect(response.message).toContain('[REDACTED_GITHUB_TOKEN]');
			expect(response.message).not.toContain('bearer-secret-token');
			expect(response.message).not.toContain('github_pat_1234567890abcdefghijklmnopqrstuvwxyz');
			expect(onErrorMessage).not.toContain('bearer-secret-token');
			expect(onErrorMessage).not.toContain('github_pat_1234567890abcdefghijklmnopqrstuvwxyz');
		});
		it("passes an SSH-remote account's remote through to the process spawn", async () => {
			const processMock = window.maestro.process as any;
			const manager = new FeedbackConversationManager();
			const sessionId = manager.start({
				agentType: 'codex',
				systemPrompt: 'system prompt',
				account: { sshRemoteId: 'remote-1', remoteCwd: '/srv/app' },
			});
			const responsePromise = manager.sendMessage('hi', []);
			await tick();
			expect(processMock.spawn.mock.calls[0][0]).toMatchObject({
				sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
				cwd: '/srv/app',
			});
			// Settle the in-flight turn so its inactivity timeout and listeners are
			// torn down before the test ends (avoids open-handle flakiness).
			const exitCallback = processMock.onExit.mock.calls[0][0];
			exitCallback(sessionId, 0);
			await responsePromise;
		});
	});
	describe('resolveFeedbackSubmission', () => {
		const user = (content: string): FeedbackMessage => ({ role: 'user', content, timestamp: 1 });
		const assistant = (content: string): FeedbackMessage => ({
			role: 'assistant',
			content,
			timestamp: 2,
		});
		const response = (overrides: Partial<FeedbackParsedResponse> = {}): FeedbackParsedResponse => ({
			confidence: 90,
			ready: true,
			message: 'ok',
			category: 'bug_report',
			summary: 'Auto Run stuck after limit',
			structured: {
				expectedBehavior: 'resumes',
				actualBehavior: 'stays paused',
				reproductionSteps: '1. hit limit',
				additionalContext: 'v1.2',
			},
			...overrides,
		});
		it('returns null until the user has said something', () => {
			expect(resolveFeedbackSubmission(null, [], false, 0)).toBeNull();
			expect(resolveFeedbackSubmission(null, [assistant('hi')], false, 0)).toBeNull();
		});
		it('files the agent fields untouched once the interview is ready', () => {
			const result = resolveFeedbackSubmission(response(), [user('it broke')], true, 90)!;
			expect(result.early).toBe(false);
			expect(result.summary).toBe('Auto Run stuck after limit');
			expect(result.structured).toEqual(response().structured);
		});
		it('backs every empty required field with the user words when submitted early', () => {
			const result = resolveFeedbackSubmission(
				null,
				[
					user('Auto Run never resumed\nafter the limit'),
					assistant('Which agent?'),
					user('the main one'),
				],
				false,
				20
			)!;
			expect(result.early).toBe(true);
			expect(result.category).toBe('general_feedback');
			expect(result.summary).toBe('Auto Run never resumed');
			expect(result.structured.actualBehavior).toBe(
				'Auto Run never resumed\nafter the limit\n\nthe main one'
			);
			expect(result.structured.expectedBehavior).toMatch(
				/submitted before the interview finished/i
			);
			expect(result.structured.additionalContext).toContain('understanding 20%');
		});
		it('keeps the agent fields and quotes the user when the agent has partial answers', () => {
			const result = resolveFeedbackSubmission(
				response({ ready: false, structured: { ...response().structured, additionalContext: '' } }),
				[user('stuck again')],
				false,
				45
			)!;
			expect(result.early).toBe(true);
			expect(result.structured.actualBehavior).toBe('stays paused');
			expect(result.structured.additionalContext).toContain('> stuck again');
		});
		it('clips a long first line into a title', () => {
			const long = 'x'.repeat(200);
			const result = resolveFeedbackSubmission(null, [user(long)], false, 0)!;
			expect(result.summary.length).toBeLessThanOrEqual(72);
			expect(result.summary.endsWith('...')).toBe(true);
		});
	});
});
// Source: src/__tests__/renderer/services/agentRun.test.ts
describe('', () => {
	const run: AgentRun = {
		id: 'run-1',
		createdAt: 100,
		updatedAt: 200,
		provider: 'claude-code',
		status: 'running',
		artifacts: [],
		touchedFiles: [],
		checks: [],
		reviews: [],
	};
	const event: AgentRunEvent = {
		id: 'event-1',
		runId: 'run-1',
		timestamp: 300,
		type: 'status',
		message: 'Run started',
	};
	const campaign: Campaign = {
		id: 'campaign-1',
		title: 'Ship parser',
		createdAt: 100,
		updatedAt: 200,
		status: 'running',
		runIds: ['run-1'],
		tasks: [],
	};
	function agentRunApi() {
		return window.maestro.agentRun as unknown as {
			list: ReturnType<typeof vi.fn>;
			record: ReturnType<typeof vi.fn>;
			show: ReturnType<typeof vi.fn>;
			events: ReturnType<typeof vi.fn>;
			appendEvent: ReturnType<typeof vi.fn>;
			campaigns: {
				list: ReturnType<typeof vi.fn>;
				record: ReturnType<typeof vi.fn>;
				show: ReturnType<typeof vi.fn>;
			};
		};
	}
	describe('agentRunService', () => {
		beforeEach(() => {
			vi.clearAllMocks();
		});
		it('lists runs through the preload API', async () => {
			agentRunApi().list.mockResolvedValue({ success: true, runs: [run] });
			const result = await agentRunService.list({
				status: 'running',
				campaign: 'campaign-1',
				limit: 5,
			});
			expect(agentRunApi().list).toHaveBeenCalledWith({
				status: 'running',
				campaign: 'campaign-1',
				limit: 5,
			});
			expect(result).toEqual([run]);
		});
		it('throws the IPC error when listing runs fails', async () => {
			agentRunApi().list.mockResolvedValue({ success: false, error: 'boom' });
			await expect(agentRunService.list()).rejects.toThrow('boom');
		});
		it('shows a run or throws on failure', async () => {
			agentRunApi()
				.show.mockResolvedValueOnce({ success: true, run })
				.mockResolvedValueOnce({ success: false, error: 'missing' });
			await expect(agentRunService.show('run-1')).resolves.toEqual(run);
			await expect(agentRunService.show('missing-run')).rejects.toThrow('missing');
		});
		it('records runs through the preload API', async () => {
			agentRunApi().record.mockResolvedValue({ success: true, run });
			const result = await agentRunService.record(run);
			expect(agentRunApi().record).toHaveBeenCalledWith(run);
			expect(result).toEqual(run);
		});
		it('reads events through the preload API', async () => {
			agentRunApi().events.mockResolvedValue({ success: true, events: [event] });
			const result = await agentRunService.events('run-1');
			expect(agentRunApi().events).toHaveBeenCalledWith('run-1');
			expect(result).toEqual([event]);
		});
		it('throws the IPC error when reading events fails', async () => {
			agentRunApi().events.mockResolvedValue({ success: false, error: 'events failed' });
			await expect(agentRunService.events('run-1')).rejects.toThrow('events failed');
		});
		it('appends events through the preload API', async () => {
			agentRunApi().appendEvent.mockResolvedValue({ success: true, event });
			const result = await agentRunService.appendEvent(event);
			expect(agentRunApi().appendEvent).toHaveBeenCalledWith(event);
			expect(result).toEqual(event);
		});
		it('lists and shows campaigns through the preload API', async () => {
			agentRunApi().campaigns.list.mockResolvedValue({ success: true, campaigns: [campaign] });
			agentRunApi().campaigns.show.mockResolvedValue({ success: true, campaign });
			await expect(
				agentRunService.campaigns.list({ status: 'running', limit: 2 })
			).resolves.toEqual([campaign]);
			await expect(agentRunService.campaigns.show('campaign-1')).resolves.toEqual(campaign);
			expect(agentRunApi().campaigns.list).toHaveBeenCalledWith({ status: 'running', limit: 2 });
			expect(agentRunApi().campaigns.show).toHaveBeenCalledWith('campaign-1');
		});
		it('records campaigns through the preload API', async () => {
			agentRunApi().campaigns.record.mockResolvedValue({ success: true, campaign });
			const result = await agentRunService.campaigns.record(campaign);
			expect(agentRunApi().campaigns.record).toHaveBeenCalledWith(campaign);
			expect(result).toEqual(campaign);
		});
		it('throws campaign IPC errors instead of hiding failures', async () => {
			agentRunApi().campaigns.list.mockResolvedValue({ success: false, error: 'boom' });
			agentRunApi().campaigns.show.mockResolvedValue({ success: false, error: 'missing' });
			await expect(agentRunService.campaigns.list()).rejects.toThrow('boom');
			await expect(agentRunService.campaigns.show('missing-campaign')).rejects.toThrow('missing');
		});
	});
});
// Source: src/__tests__/renderer/services/webLoginSession.test.ts
describe('', () => {
	const originalLocation = window.location;
	function setConfig(config: unknown): void {
		(
			window as unknown as {
				__MAESTRO_CONFIG__?: unknown;
			}
		).__MAESTRO_CONFIG__ = config;
	}
	function href(): string {
		return window.location.href;
	}
	describe('webLoginSession', () => {
		beforeEach(() => {
			Object.defineProperty(window, 'location', {
				configurable: true,
				writable: true,
				value: { ...originalLocation, href: '' },
			});
			vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
		});
		afterEach(() => {
			delete (
				window as unknown as {
					__MAESTRO_CONFIG__?: unknown;
				}
			).__MAESTRO_CONFIG__;
			Object.defineProperty(window, 'location', {
				configurable: true,
				writable: true,
				value: originalLocation,
			});
			vi.unstubAllGlobals();
		});
		describe('currentWebLoginUser', () => {
			it('returns the injected account', () => {
				setConfig({
					securityToken: 'tok',
					webLoginUser: { id: 'u1', username: 'ada', displayName: 'Ada' },
				});
				expect(currentWebLoginUser()).toEqual({ id: 'u1', username: 'ada', displayName: 'Ada' });
			});
			it('returns null with no config at all (the Electron desktop)', () => {
				expect(currentWebLoginUser()).toBeNull();
			});
			it('returns null when the page carries a config but no account', () => {
				setConfig({ securityToken: 'tok', webLoginUser: null });
				expect(currentWebLoginUser()).toBeNull();
			});
			it('returns null for a malformed account rather than a half-object', () => {
				setConfig({ securityToken: 'tok', webLoginUser: { id: 'u1' } });
				expect(currentWebLoginUser()).toBeNull();
			});
		});
		describe('signOutWebLogin', () => {
			it('posts to the token-scoped logout route with the cookie, then navigates', async () => {
				setConfig({
					securityToken: 'tok',
					webLoginUser: { id: 'u1', username: 'ada', displayName: 'Ada' },
				});
				await signOutWebLogin();
				expect(fetch).toHaveBeenCalledWith('/tok/auth/logout', {
					method: 'POST',
					credentials: 'same-origin',
				});
				expect(href()).toBe('/tok/login');
			});
			it('still navigates when the POST fails', async () => {
				setConfig({ securityToken: 'tok' });
				vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
				await expect(signOutWebLogin()).resolves.toBeUndefined();
				expect(href()).toBe('/tok/login');
			});
			it('does nothing without a security token - there is no route to call', async () => {
				await signOutWebLogin();
				expect(fetch).not.toHaveBeenCalled();
				expect(href()).toBe('');
			});
		});
	});
});

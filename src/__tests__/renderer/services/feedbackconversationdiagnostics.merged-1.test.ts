// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/renderer/services/feedbackConversationDiagnostics.test.ts
// Source: src/__tests__/renderer/services/crossAgentAsk.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
	FeedbackConversationManager,
	type FeedbackDiagnostic,
} from '../../../renderer/services/feedbackConversation';
import {
	runCrossAgentAsk,
	CROSS_AGENT_ASK_SESSION_ID,
	CROSS_AGENT_ASK_TAB_ID,
} from '../../../renderer/services/crossAgentAsk';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { createMockSession } from '../../helpers/mockSession';
import { createMockAITab } from '../../helpers/mockTab';
import type { CrossAgentCompletion } from '../../../renderer/hooks/agent/useCrossAgentDispatch';
import type { SendCrossAgentRequestOptions } from '../../../renderer/hooks/agent/useCrossAgentDispatch';
const sendCrossAgentRequest = vi.hoisted(() => vi.fn());
vi.mock('../../../renderer/hooks/agent/useCrossAgentDispatch', () => ({
	sendCrossAgentRequest: sendCrossAgentRequest,
}));
// Source: src/__tests__/renderer/services/feedbackConversationDiagnostics.test.ts
describe('', () => {
	type ExitCallback = (sessionId: string, code: number) => void;
	type DataCallback = (sessionId: string, data: string) => void;
	type ToolCallback = (
		sessionId: string,
		toolEvent: {
			toolName: string;
			state?: unknown;
			timestamp: number;
			toolCallId?: string;
		}
	) => void;
	const CLAUDE_AGENT = {
		id: 'claude-code',
		command: 'claude',
		available: true,
		args: [
			'--print',
			'--verbose',
			'--output-format',
			'stream-json',
			'--dangerously-skip-permissions',
		],
		capabilities: { supportsStreamJsonInput: false },
	};
	const CODEX_AGENT = {
		id: 'codex',
		command: 'codex',
		available: true,
		args: [],
		batchModeArgs: ['--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check'],
		jsonOutputArgs: ['--json'],
		capabilities: {},
	};
	/**
	 * Wire the window.maestro surface the manager talks to, exposing the listener
	 * callbacks so a test can drive the process lifecycle by hand.
	 */
	function installProcessMocks(agent: unknown) {
		const listeners: {
			exit?: ExitCallback;
			data?: DataCallback;
			tool?: ToolCallback;
		} = {};
		const spawn = vi.fn();
		(window as any).maestro = {
			agents: { get: vi.fn().mockResolvedValue(agent) },
			process: {
				spawn,
				kill: vi.fn(),
				onData: vi.fn((cb: DataCallback) => {
					listeners.data = cb;
					return () => {};
				}),
				onExit: vi.fn((cb: ExitCallback) => {
					listeners.exit = cb;
					return () => {};
				}),
				onToolExecution: vi.fn((cb: ToolCallback) => {
					listeners.tool = cb;
					return () => {};
				}),
				onThinkingChunk: vi.fn(() => () => {}),
			},
		};
		return { spawn, listeners };
	}
	/** Finish the turn so `sendMessage()`'s promise settles. */
	function completeTurn(
		listeners: {
			exit?: ExitCallback;
			data?: DataCallback;
		},
		sessionId: string,
		payload: Record<string, unknown>
	) {
		listeners.data?.(sessionId, JSON.stringify(payload));
		listeners.exit?.(sessionId, 0);
	}
	const VALID_RESPONSE = {
		confidence: 55,
		ready: false,
		message: 'Tell me more.',
		category: 'bug_report',
		summary: 'Something broke',
		structured: {
			expectedBehavior: '',
			actualBehavior: '',
			reproductionSteps: '',
			additionalContext: '',
		},
	};
	describe('FeedbackConversationManager diagnostics', () => {
		beforeEach(() => {
			vi.clearAllMocks();
		});
		it('spawns the diagnostic agent in read-only mode', async () => {
			const { spawn, listeners } = installProcessMocks(CLAUDE_AGENT);
			const manager = new FeedbackConversationManager();
			const sessionId = manager.start({
				agentType: 'claude-code',
				systemPrompt: 'prompt',
				cwd: '/home/tester',
			});
			const pending = manager.sendMessage('it broke', []);
			await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
			completeTurn(listeners, sessionId, VALID_RESPONSE);
			await pending;
			expect(spawn.mock.calls[0][0]).toMatchObject({ readOnlyMode: true });
		});
		it('runs diagnostics from the supplied working directory', async () => {
			const { spawn, listeners } = installProcessMocks(CLAUDE_AGENT);
			const manager = new FeedbackConversationManager();
			const sessionId = manager.start({
				agentType: 'claude-code',
				systemPrompt: 'prompt',
				cwd: '/home/tester',
			});
			const pending = manager.sendMessage('it broke', []);
			await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
			completeTurn(listeners, sessionId, VALID_RESPONSE);
			await pending;
			// The old hard-coded '.' resolved to the app's cwd ('/' for a packaged
			// .app), where no diagnostic command finds anything.
			expect(spawn.mock.calls[0][0].cwd).toBe('/home/tester');
		});
		it("runs as the chosen account: its env replaces the provider's, its binary is used", async () => {
			const { spawn, listeners } = installProcessMocks(CLAUDE_AGENT);
			const manager = new FeedbackConversationManager();
			const env = { CLAUDE_CONFIG_DIR: '/home/tester/.claude-work' };
			const sessionId = manager.start({
				agentType: 'claude-code',
				systemPrompt: 'prompt',
				cwd: '/home/tester',
				account: { env, customPath: '/opt/claude', sshRemoteId: null },
			});
			const pending = manager.sendMessage('it broke', []);
			await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
			completeTurn(listeners, sessionId, VALID_RESPONSE);
			await pending;
			expect(spawn.mock.calls[0][0]).toMatchObject({
				sessionCustomEnvVars: env,
				sessionCustomPath: '/opt/claude',
				sessionSshRemoteConfig: undefined,
			});
		});
		it('reports a non-zero exit as a failed turn so the caller can try another account', async () => {
			const { spawn, listeners } = installProcessMocks(CLAUDE_AGENT);
			const manager = new FeedbackConversationManager();
			const sessionId = manager.start({ agentType: 'claude-code', systemPrompt: 'prompt' });
			const pending = manager.sendTurn('it broke', []);
			await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
			listeners.data?.(sessionId, 'Invalid API key - Please run /login');
			listeners.exit?.(sessionId, 1);
			const result = await pending;
			expect(result.failed).toBe(true);
			expect(result.error).toContain('Please run /login');
			// The next turn can run as a different account in the same conversation.
			manager.switchAccount('claude-code', { env: { CLAUDE_CONFIG_DIR: '/b' }, sshRemoteId: null });
			const retry = manager.sendTurn('it broke', []);
			await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));
			completeTurn(listeners, sessionId, VALID_RESPONSE);
			expect((await retry).failed).toBe(false);
			expect(spawn.mock.calls[1][0].sessionCustomEnvVars).toEqual({ CLAUDE_CONFIG_DIR: '/b' });
		});
		it('strips blanket permission grants from the agent args', async () => {
			const { spawn, listeners } = installProcessMocks(CLAUDE_AGENT);
			const manager = new FeedbackConversationManager();
			const sessionId = manager.start({ agentType: 'claude-code', systemPrompt: 'prompt' });
			const pending = manager.sendMessage('it broke', []);
			await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
			completeTurn(listeners, sessionId, VALID_RESPONSE);
			await pending;
			const args: string[] = spawn.mock.calls[0][0].args;
			// Leaving this in would override the provider's read-only flag and hand a
			// bug-reporting assistant write access to the app it is reporting on.
			expect(args).not.toContain('--dangerously-skip-permissions');
			expect(args).toContain('--output-format');
		});
		it('omits Codex batch-mode permission bypass args', async () => {
			const { spawn, listeners } = installProcessMocks(CODEX_AGENT);
			const manager = new FeedbackConversationManager();
			const sessionId = manager.start({ agentType: 'codex', systemPrompt: 'prompt' });
			const pending = manager.sendMessage('it broke', []);
			await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
			completeTurn(listeners, sessionId, VALID_RESPONSE);
			await pending;
			const args: string[] = spawn.mock.calls[0][0].args;
			expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
			expect(args).toContain('--json');
		});
		it('reports each diagnostic command the agent runs', async () => {
			const { spawn, listeners } = installProcessMocks(CLAUDE_AGENT);
			const manager = new FeedbackConversationManager();
			const sessionId = manager.start({ agentType: 'claude-code', systemPrompt: 'prompt' });
			const seen: FeedbackDiagnostic[] = [];
			const pending = manager.sendMessage('it broke', [], {
				onDiagnostic: (diagnostic) => seen.push(diagnostic),
			});
			await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
			listeners.tool?.(sessionId, {
				toolName: 'Bash',
				state: { status: 'running', input: { command: 'maestro-cli doctor' } },
				timestamp: 1,
				toolCallId: 'call-1',
			});
			// A single call is reported again as it completes; the user should see it once.
			listeners.tool?.(sessionId, {
				toolName: 'Bash',
				state: { status: 'completed', input: { command: 'maestro-cli doctor' } },
				timestamp: 2,
				toolCallId: 'call-1',
			});
			listeners.tool?.(sessionId, {
				toolName: 'Read',
				state: { status: 'running', input: { file_path: '/tmp/maestro.log' } },
				timestamp: 3,
				toolCallId: 'call-2',
			});
			completeTurn(listeners, sessionId, VALID_RESPONSE);
			await pending;
			expect(seen).toHaveLength(2);
			expect(seen[0]).toMatchObject({ toolName: 'Bash', command: 'maestro-cli doctor' });
			// No command in the input - the UI falls back to naming the tool.
			expect(seen[1]).toMatchObject({ toolName: 'Read', command: undefined });
		});
		it('recovers the response when the agent wraps it in prose', async () => {
			const { spawn, listeners } = installProcessMocks(CLAUDE_AGENT);
			const manager = new FeedbackConversationManager();
			const sessionId = manager.start({ agentType: 'claude-code', systemPrompt: 'prompt' });
			const pending = manager.sendMessage('it broke', []);
			await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
			// Running diagnostics first makes a preamble far more likely, and the
			// greedy match this replaced spanned first-brace to last-brace, so a single
			// stray sentence used to turn a real answer into the "didn't catch that"
			// fallback.
			listeners.data?.(
				sessionId,
				`I checked your logs first.\n\n${JSON.stringify(VALID_RESPONSE)}\n\nHope that helps.`
			);
			listeners.exit?.(sessionId, 0);
			const response = await pending;
			expect(response.confidence).toBe(55);
			expect(response.message).toBe('Tell me more.');
		});
		it('is not fooled by braces inside the message body', async () => {
			const { spawn, listeners } = installProcessMocks(CLAUDE_AGENT);
			const manager = new FeedbackConversationManager();
			const sessionId = manager.start({ agentType: 'claude-code', systemPrompt: 'prompt' });
			const pending = manager.sendMessage('it broke', []);
			await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
			const withBraces = {
				...VALID_RESPONSE,
				message: 'Your config has a stray } in it - see {"a": 1} on line 4.',
			};
			listeners.data?.(sessionId, `Here you go:\n${JSON.stringify(withBraces)}`);
			listeners.exit?.(sessionId, 0);
			const response = await pending;
			expect(response.message).toBe('Your config has a stray } in it - see {"a": 1} on line 4.');
		});
		it('falls back to the default response when nothing parses', async () => {
			const { spawn, listeners } = installProcessMocks(CLAUDE_AGENT);
			const manager = new FeedbackConversationManager();
			const sessionId = manager.start({ agentType: 'claude-code', systemPrompt: 'prompt' });
			const pending = manager.sendMessage('it broke', []);
			await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
			listeners.data?.(sessionId, 'Sorry, I got confused and wrote no JSON at all.');
			listeners.exit?.(sessionId, 0);
			const response = await pending;
			expect(response.ready).toBe(false);
			expect(response.message).toContain("didn't quite catch that");
		});
		it('ignores tool events belonging to another session', async () => {
			const { spawn, listeners } = installProcessMocks(CLAUDE_AGENT);
			const manager = new FeedbackConversationManager();
			const sessionId = manager.start({ agentType: 'claude-code', systemPrompt: 'prompt' });
			const seen: FeedbackDiagnostic[] = [];
			const pending = manager.sendMessage('it broke', [], {
				onDiagnostic: (diagnostic) => seen.push(diagnostic),
			});
			await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
			listeners.tool?.('some-other-session', {
				toolName: 'Bash',
				state: { status: 'running', input: { command: 'rm -rf /' } },
				timestamp: 1,
				toolCallId: 'other-1',
			});
			completeTurn(listeners, sessionId, VALID_RESPONSE);
			await pending;
			expect(seen).toHaveLength(0);
		});
	});
});
// Source: src/__tests__/renderer/services/crossAgentAsk.test.ts
describe('', () => {
	/** The options the service handed to the shared consult dispatcher. */
	function sentOptions(): SendCrossAgentRequestOptions {
		return sendCrossAgentRequest.mock.calls[0][0] as SendCrossAgentRequestOptions;
	}
	/** Settle the in-flight consult with a terminal completion. */
	function complete(completion: CrossAgentCompletion): void {
		sentOptions().onComplete?.(completion);
	}
	describe('runCrossAgentAsk', () => {
		beforeEach(() => {
			sendCrossAgentRequest.mockClear();
			useSessionStore.setState({
				sessions: [
					createMockSession({
						id: 'target',
						name: '📜 Substrate PedTome',
						cwd: '/Users/me/sub',
					}),
					createMockSession({ id: 'caller', name: '🥋 Kensho', cwd: '/Users/me/kensho' }),
				],
			} as never);
		});
		it('resolves with an error instead of throwing when the target is gone', async () => {
			const result = await runCrossAgentAsk({ targetSessionId: 'nope', question: 'hi' });
			expect(result.success).toBe(false);
			expect(result.error).toContain('not found');
			expect(sendCrossAgentRequest).not.toHaveBeenCalled();
		});
		it('refuses a self-consult', async () => {
			const result = await runCrossAgentAsk({
				targetSessionId: 'target',
				question: 'hi',
				fromSessionId: 'target',
			});
			expect(result.success).toBe(false);
			expect(result.error).toContain('cannot consult itself');
			expect(sendCrossAgentRequest).not.toHaveBeenCalled();
		});
		it('sends a fresh context by default - no transcript is forwarded', async () => {
			const pending = runCrossAgentAsk({
				targetSessionId: 'target',
				question: 'How does the gate work?',
				fromSessionId: 'caller',
			});
			expect(sentOptions().sourceLogs).toEqual([]);
			complete({ text: 'HMAC cookie.' });
			await pending;
		});
		it('forwards the caller transcript only when asked', async () => {
			const caller = createMockSession({ id: 'caller', name: '🥋 Kensho' });
			caller.aiTabs = [
				{
					id: 'caller-tab',
					name: 'Work',
					logs: [{ id: 'l1', timestamp: 1, source: 'user', text: 'earlier' }],
				},
			] as never;
			caller.activeTabId = 'caller-tab';
			useSessionStore.setState({
				sessions: [createMockSession({ id: 'target', name: 'PedTome' }), caller],
			} as never);
			const pending = runCrossAgentAsk({
				targetSessionId: 'target',
				question: 'and now?',
				fromSessionId: 'caller',
				withContext: true,
			});
			expect(sentOptions().sourceLogs).toHaveLength(1);
			complete({ text: 'ok' });
			await pending;
		});
		it('forwards the ASKING tab transcript, not whichever tab the user has open', async () => {
			const caller = createMockSession({ id: 'caller', name: '🥋 Kensho' });
			caller.aiTabs = [
				{
					id: 'asking-tab',
					name: 'Work',
					logs: [{ id: 'l1', timestamp: 1, source: 'user', text: 'the real thread' }],
				},
				{
					id: 'open-tab',
					name: 'Unrelated',
					logs: [{ id: 'l2', timestamp: 2, source: 'user', text: 'something else' }],
				},
			] as never;
			caller.activeTabId = 'open-tab';
			useSessionStore.setState({
				sessions: [createMockSession({ id: 'target', name: 'PedTome' }), caller],
			} as never);
			const pending = runCrossAgentAsk({
				targetSessionId: 'target',
				question: 'and now?',
				fromSessionId: 'caller',
				fromTabId: 'asking-tab',
				withContext: true,
			});
			expect(sentOptions().sourceLogs.map((log: { id: string }) => log.id)).toEqual(['l1']);
			complete({ text: 'ok' });
			await pending;
		});
		it('keys the consult on the CALLING AGENT, not on whichever tab it had open', async () => {
			// One consult tab per (caller -> target) pairing is what lets a follow-up
			// `ask` resume the earlier exchange. Keying it on the caller's active tab
			// would start over every time the agent switched tabs.
			const pending = runCrossAgentAsk({
				targetSessionId: 'target',
				question: 'q',
				fromSessionId: 'caller',
			});
			expect(sentOptions().sourceSessionId).toBe('caller');
			expect(sentOptions().sourceTabId).toBe(CROSS_AGENT_ASK_TAB_ID);
			// The caller's cwd rides along so the target may read the caller's project.
			expect(sentOptions().sourceCwd).toBe('/Users/me/kensho');
			complete({ text: 'a' });
			await pending;
		});
		it('falls back to a shared CLI origin when the caller does not name itself', async () => {
			const pending = runCrossAgentAsk({ targetSessionId: 'target', question: 'q' });
			expect(sentOptions().sourceSessionId).toBe(CROSS_AGENT_ASK_SESSION_ID);
			expect(sentOptions().sourceAgentName).toBe('CLI');
			expect(sentOptions().sourceCwd).toBeUndefined();
			complete({ text: 'a' });
			await pending;
		});
		it('returns the answer and the consult tab on success', async () => {
			const pending = runCrossAgentAsk({ targetSessionId: 'target', question: 'q' });
			complete({ text: 'Signed cookie, no session table.', targetTabId: 'consult-1' });
			await expect(pending).resolves.toEqual({
				success: true,
				answer: 'Signed cookie, no session table.',
				error: undefined,
				canceled: undefined,
				targetAgentName: '📜 Substrate PedTome',
				targetTabId: 'consult-1',
			});
		});
		it('keeps a partial answer alongside the failure reason', async () => {
			// A consult that said something before it died still said something; the
			// caller needs both halves to decide what to do next.
			const pending = runCrossAgentAsk({ targetSessionId: 'target', question: 'q' });
			complete({ text: 'Half an ans', error: 'agent timed out' });
			const result = await pending;
			expect(result.success).toBe(false);
			expect(result.answer).toBe('Half an ans');
			expect(result.error).toBe('agent timed out');
		});
		it('reports a stop as canceled rather than as a failure of the target', async () => {
			const pending = runCrossAgentAsk({ targetSessionId: 'target', question: 'q' });
			complete({ text: '', canceled: true });
			const result = await pending;
			expect(result.success).toBe(false);
			expect(result.canceled).toBe(true);
			expect(result.error).toBeUndefined();
		});
		describe('consult pill in the asking agent transcript', () => {
			const pillsIn = (tabId: string) =>
				useSessionStore
					.getState()
					.sessions.find((s) => s.id === 'caller')!
					.aiTabs.find((t) => t.id === tabId)!
					.logs.filter((log) => log.delegation);
			beforeEach(() => {
				useSessionStore.setState({
					sessions: [
						createMockSession({
							id: 'target',
							name: '📜 Substrate PedTome',
							cwd: '/Users/me/sub',
						}),
						createMockSession({
							id: 'caller',
							name: '🥋 Kensho',
							cwd: '/Users/me/kensho',
							aiTabs: [
								createMockAITab({ id: 'asking-tab', logs: [] }),
								createMockAITab({ id: 'other-tab', logs: [] }),
							],
							activeTabId: 'other-tab',
						}),
					],
				} as never);
			});
			it('shows a pending pill in the asking tab, then settles it with the consult tab', async () => {
				const pending = runCrossAgentAsk({
					targetSessionId: 'target',
					question: 'How does the gate work?',
					fromSessionId: 'caller',
					fromTabId: 'asking-tab',
				});
				expect(pillsIn('asking-tab')).toHaveLength(1);
				expect(pillsIn('asking-tab')[0].delegation).toMatchObject({
					kind: 'ask',
					toSessionId: 'target',
					status: 'pending',
					subject: 'How does the gate work?',
				});
				expect(pillsIn('other-tab')).toHaveLength(0);
				complete({ text: 'Signed cookie.', targetTabId: 'consult-1' });
				await pending;
				expect(pillsIn('asking-tab')[0].delegation).toMatchObject({
					status: 'done',
					toTabId: 'consult-1',
				});
			});
			it('settles the pill as an error when no answer came back', async () => {
				const pending = runCrossAgentAsk({
					targetSessionId: 'target',
					question: 'q',
					fromSessionId: 'caller',
					fromTabId: 'asking-tab',
				});
				complete({ text: '', error: 'agent timed out' });
				await pending;
				expect(pillsIn('asking-tab')[0].delegation).toMatchObject({
					status: 'error',
					error: 'agent timed out',
				});
			});
			it('marks nothing for an unattributed caller', async () => {
				const pending = runCrossAgentAsk({ targetSessionId: 'target', question: 'q' });
				complete({ text: 'a' });
				await pending;
				expect(pillsIn('asking-tab')).toHaveLength(0);
				expect(pillsIn('other-tab')).toHaveLength(0);
			});
		});
	});
});

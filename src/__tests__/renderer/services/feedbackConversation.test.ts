import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	FeedbackConversationManager,
	resolveFeedbackSubmission,
	type FeedbackMessage,
	type FeedbackParsedResponse,
} from '../../../renderer/services/feedbackConversation';
import { getAgentDefinition } from '../../../shared/maestro-lib/providers/definitions';

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
		dataCallback(sessionId, '\u001b[31mError: not logged in. Run `codex login` first.\u001b[0m\n');
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
		window.maestro.agents.get.mockResolvedValue(mockCodexAgent({ path: 'C:\\missing\\codex.exe' }));

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
		expect(result.structured.expectedBehavior).toMatch(/submitted before the interview finished/i);
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

describe('Grok feedback interview turns', () => {
	const grokAgent = (overrides: Record<string, unknown> = {}) => ({
		id: 'grok',
		name: 'Grok CLI',
		available: true,
		command: 'grok',
		path: '/usr/local/bin/grok',
		args: [],
		jsonOutputArgs: ['--output-format', 'streaming-json'],
		...overrides,
	});
	const grokAccount = (overrides: Record<string, unknown> = {}) => ({
		key: 'grok::/home/me/.grok-work',
		label: 'Grok CLI - work',
		env: { GROK_HOME: '/home/me/.grok-work' },
		customPath: '/opt/grok/bin/grok',
		sshRemoteId: null as string | null,
		...overrides,
	});
	const answer = JSON.stringify({
		confidence: 85,
		ready: true,
		message: 'Filed as a bug.',
		category: 'bug_report',
		summary: 'Composer loses the draft',
		structured: {
			expectedBehavior: 'The draft stays',
			actualBehavior: 'It is gone',
			reproductionSteps: '1. type 2. switch tab',
			additionalContext: 'Grok interview',
		},
	});
	const processMock = () => window.maestro.process as any;
	const agentsGet = () => window.maestro.agents.get as any;
	const spawnConfig = (call = 0) => processMock().spawn.mock.calls[call][0];
	let fetchSpy: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.clearAllMocks();
		const p = processMock();
		p.spawn.mockReset();
		p.spawn.mockResolvedValue({ pid: 4242, success: true });
		p.kill = vi.fn();
		p.onData = vi.fn(() => vi.fn());
		p.onExit = vi.fn(() => vi.fn());
		p.onThinkingChunk = vi.fn(() => vi.fn());
		p.onToolExecution = vi.fn(() => vi.fn());
		agentsGet().mockReset();
		agentsGet().mockResolvedValue(grokAgent());
		fetchSpy = vi.fn();
		vi.stubGlobal('fetch', fetchSpy);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		// Nothing in an interview turn files, searches or reaches the network.
		const feedback = window.maestro.feedback as any;
		expect(feedback.submit).not.toHaveBeenCalled();
		expect(feedback.submitConversation).not.toHaveBeenCalled();
		expect(feedback.subscribeIssue).not.toHaveBeenCalled();
		expect(feedback.searchIssues).not.toHaveBeenCalled();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('spawns the selected Grok account read-only with its profile, model and structured stream, and parses its answer', async () => {
		const manager = new FeedbackConversationManager();
		const sessionId = manager.start({
			agentType: 'grok',
			systemPrompt: 'FEEDBACK SYSTEM PROMPT',
			cwd: '/home/me',
			account: grokAccount({ model: '  grok-4-fast  ' }),
		});
		const onComplete = vi.fn();
		const turn = manager.sendTurn(
			'my draft vanished',
			[
				{ role: 'user', content: 'hello', timestamp: 1 },
				{ role: 'assistant', content: 'What happened?', timestamp: 2 },
			],
			{ onComplete }
		);
		await tick();

		expect(processMock().spawn).toHaveBeenCalledTimes(1);
		const cfg = spawnConfig();
		expect(cfg).toMatchObject({
			sessionId,
			toolType: 'grok',
			command: '/usr/local/bin/grok',
			cwd: '/home/me',
			readOnlyMode: true,
			sessionCustomEnvVars: { GROK_HOME: '/home/me/.grok-work' },
			sessionCustomPath: '/opt/grok/bin/grok',
			sessionCustomModel: 'grok-4-fast',
		});
		expect(cfg.sessionSshRemoteConfig).toBeUndefined();
		expect(cfg.args).toEqual(['--output-format', 'streaming-json']);
		// The system instructions travel once, with the history and the reminder.
		expect(cfg.prompt.split('FEEDBACK SYSTEM PROMPT')).toHaveLength(2);
		expect(cfg.prompt).toContain('User: hello');
		expect(cfg.prompt).toContain('Assistant: What happened?');
		expect(cfg.prompt).toContain('## Current User Message\n\nUser: my draft vanished');

		processMock().onData.mock.calls[0][0](sessionId, `Checked the log first.\n${answer}\n`);
		processMock().onExit.mock.calls[0][0](sessionId, 0);
		const result = await turn;
		expect(result.failed).toBe(false);
		expect(result.refused).toBeUndefined();
		expect(result.response).toMatchObject({
			ready: true,
			confidence: 85,
			category: 'bug_report',
			summary: 'Composer loses the draft',
			structured: { reproductionSteps: '1. type 2. switch tab' },
		});
		expect(onComplete).toHaveBeenCalledWith(result.response);
	});

	it('carries the SSH identity and remote cwd, and leaves the model to main when none was picked', async () => {
		const manager = new FeedbackConversationManager();
		const sessionId = manager.start({
			agentType: 'grok',
			systemPrompt: 'S',
			cwd: '/home/me',
			account: grokAccount({ sshRemoteId: 'build-box', remoteCwd: '/srv/me', model: '   ' }),
		});
		// A remote account is not gated on local detection.
		agentsGet().mockResolvedValue(grokAgent({ available: false }));
		const turn = manager.sendTurn('hi', []);
		await tick();

		expect(spawnConfig()).toMatchObject({
			sessionSshRemoteConfig: { enabled: true, remoteId: 'build-box' },
			cwd: '/srv/me',
			sessionCustomPath: '/opt/grok/bin/grok',
		});
		expect(spawnConfig().sessionCustomModel).toBeUndefined();
		processMock().onExit.mock.calls[0][0](sessionId, 0);
		await turn;
	});

	it('strips every permission-bypass argument and adds the structured stream once', async () => {
		agentsGet().mockResolvedValue(
			grokAgent({
				args: [
					'--always-approve',
					'--yolo',
					'--dangerously-skip-permissions',
					'--permission-mode',
					'bypassPermissions',
					'--permission-mode=acceptEdits',
					'--output-format',
					'streaming-json',
					'--keep-me',
				],
			})
		);
		const manager = new FeedbackConversationManager();
		manager.start({ agentType: 'grok', systemPrompt: 'S' });
		void manager.sendTurn('hi', []);
		await tick();

		const args: string[] = spawnConfig().args;
		expect(args).toEqual(['--output-format', 'streaming-json', '--keep-me']);
		for (const bypass of getAgentDefinition('grok')!.yoloModeArgs ?? []) {
			expect(args).not.toContain(bypass);
		}
		expect(args.some((arg) => arg.startsWith('--permission-mode'))).toBe(false);
		manager.cleanup();
	});

	it("falls back to the definition's structured stream args when detection reports none", async () => {
		agentsGet().mockResolvedValue(grokAgent({ jsonOutputArgs: undefined }));
		const manager = new FeedbackConversationManager();
		manager.start({ agentType: 'grok', systemPrompt: 'S' });
		void manager.sendTurn('hi', []);
		await tick();
		expect(spawnConfig().args).toEqual(getAgentDefinition('grok')!.jsonOutputArgs);
		manager.cleanup();
	});

	it("keeps an in-flight turn on its own session identity: other sessions' events and a later account switch do not touch it", async () => {
		const manager = new FeedbackConversationManager();
		const sessionId = manager.start({
			agentType: 'grok',
			systemPrompt: 'S',
			account: grokAccount(),
		});
		const onDiagnostic = vi.fn();
		const onChunk = vi.fn();
		const turn = manager.sendTurn('hi', [], { onDiagnostic, onChunk });
		await tick();

		// The selection changes while the first turn is still running.
		manager.switchAccount('grok', grokAccount({ env: { GROK_HOME: '/home/me/.grok-home' } }));

		const onData = processMock().onData.mock.calls[0][0];
		const onExit = processMock().onExit.mock.calls[0][0];
		const onTool = processMock().onToolExecution.mock.calls[0][0];
		onData('feedback-someone-else', '{"confidence":99,"message":"wrong session"}');
		onTool('feedback-someone-else', { toolName: 'Bash', timestamp: 1 });
		onExit('feedback-someone-else', 0);
		onTool(sessionId, {
			toolName: 'Bash',
			state: { input: { command: 'tail log' } },
			timestamp: 5,
			toolCallId: 't1',
		});
		onTool(sessionId, {
			toolName: 'Bash',
			state: { input: { command: 'tail log' } },
			timestamp: 6,
			toolCallId: 't1',
		});
		onData(sessionId, answer);
		onExit(sessionId, 0);

		const result = await turn;
		expect(result.response.message).toBe('Filed as a bug.');
		expect(onChunk).toHaveBeenCalledTimes(1);
		expect(onDiagnostic).toHaveBeenCalledTimes(1);
		expect(onDiagnostic).toHaveBeenCalledWith({
			toolName: 'Bash',
			command: 'tail log',
			timestamp: 5,
		});
		expect(spawnConfig(0).sessionCustomEnvVars).toEqual({ GROK_HOME: '/home/me/.grok-work' });

		// The next turn of the same conversation runs as the newly selected account.
		const next = manager.sendTurn('more', []);
		await tick();
		expect(spawnConfig(1)).toMatchObject({
			sessionId,
			toolType: 'grok',
			sessionCustomEnvVars: { GROK_HOME: '/home/me/.grok-home' },
		});
		processMock().onExit.mock.calls[1][0](sessionId, 0);
		await next;
	});

	it('bounds a silent Grok turn: the timeout kills its process and settles the turn', async () => {
		vi.useFakeTimers();
		try {
			const manager = new FeedbackConversationManager();
			const sessionId = manager.start({ agentType: 'grok', systemPrompt: 'S' });
			const turn = manager.sendTurn('hi', []);
			await vi.advanceTimersByTimeAsync(600_001);
			const result = await turn;
			expect(result.failed).toBe(false);
			expect(result.response.message).toContain('took too long');
			expect(processMock().kill).toHaveBeenCalledWith(sessionId);
			expect(processMock().spawn).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it('cancels a running Grok turn: cleanup kills its process and detaches every listener', async () => {
		const detach = { data: vi.fn(), exit: vi.fn(), tool: vi.fn(), thinking: vi.fn() };
		processMock().onData = vi.fn(() => detach.data);
		processMock().onExit = vi.fn(() => detach.exit);
		processMock().onToolExecution = vi.fn(() => detach.tool);
		processMock().onThinkingChunk = vi.fn(() => detach.thinking);
		const manager = new FeedbackConversationManager();
		const sessionId = manager.start({ agentType: 'grok', systemPrompt: 'S' });
		void manager.sendTurn('hi', [], { onDiagnostic: vi.fn(), onThinkingChunk: vi.fn() });
		await tick();

		manager.cleanup();
		expect(processMock().kill).toHaveBeenCalledWith(sessionId);
		for (const fn of Object.values(detach)) expect(fn).toHaveBeenCalledTimes(1);
		expect(manager.isActive).toBe(false);
	});

	it('refuses Grok without CLI-enforced read-only support before detection or spawn, and never substitutes', async () => {
		const definition = getAgentDefinition('grok')!;
		const previous = definition.readOnlyCliEnforced;
		definition.readOnlyCliEnforced = false;
		try {
			const manager = new FeedbackConversationManager();
			manager.start({ agentType: 'grok', systemPrompt: 'S', account: grokAccount() });
			const onError = vi.fn();
			const onComplete = vi.fn();
			const result = await manager.sendTurn('hi', [], { onError, onComplete });

			expect(result).toMatchObject({ failed: true, refused: true });
			expect(result.error).toContain('CLI-enforced read-only');
			expect(result.response.ready).toBe(false);
			expect(onError).toHaveBeenCalledWith(result.error);
			expect(onComplete).toHaveBeenCalledWith(result.response);
			expect(window.maestro.agents.get).not.toHaveBeenCalled();
			expect(processMock().spawn).not.toHaveBeenCalled();
		} finally {
			definition.readOnlyCliEnforced = previous;
		}
	});

	it('refuses an explicitly selected Grok account main marked unsupported, with no other provider or account in its place', async () => {
		const manager = new FeedbackConversationManager();
		manager.start({
			agentType: 'grok',
			systemPrompt: 'S',
			account: grokAccount({ status: 'unsupported', statusDetail: 'no qualified read-only route' }),
		});
		const result = await manager.sendTurn('hi', []);

		expect(result).toMatchObject({ failed: true, refused: true });
		expect(result.error).toContain('no qualified read-only route');
		expect(result.error).toContain('Pick another account');
		expect(window.maestro.agents.get).not.toHaveBeenCalled();
		expect(processMock().spawn).not.toHaveBeenCalled();
	});

	it('reports a managed spawn refusal as a failed Grok turn with no retry and no substitute', async () => {
		processMock().spawn.mockResolvedValue({
			pid: -1,
			success: false,
			error: 'The managed host did not admit this spawn.',
			managed: { state: 'denied', code: 'outside-ceiling' },
		});
		const manager = new FeedbackConversationManager();
		manager.start({ agentType: 'grok', systemPrompt: 'S', account: grokAccount() });
		const onError = vi.fn();
		const result = await manager.sendTurn('hi', [], { onError });

		expect(result.failed).toBe(true);
		expect(result.error).toBe('Process spawn returned success=false (pid -1)');
		expect(result.response.message).toContain('Grok CLI provider could not be started');
		expect(result.response.message).toContain('/opt/grok/bin/grok');
		expect(processMock().spawn).toHaveBeenCalledTimes(1);
		expect(spawnConfig().toolType).toBe('grok');
		expect(agentsGet().mock.calls).toEqual([['grok']]);
		expect(onError).toHaveBeenCalledTimes(1);
	});

	it('reports a rejected Grok spawn redacted, with no retry and no substitute', async () => {
		processMock().spawn.mockRejectedValue(
			new Error('spawn refused for api_key=xai-secret-value under management')
		);
		const manager = new FeedbackConversationManager();
		manager.start({ agentType: 'grok', systemPrompt: 'S' });
		const result = await manager.sendTurn('hi', []);

		expect(result.failed).toBe(true);
		expect(result.error).toContain('api_key=[REDACTED]');
		expect(result.error).not.toContain('xai-secret-value');
		expect(processMock().spawn).toHaveBeenCalledTimes(1);
		expect(agentsGet().mock.calls).toEqual([['grok']]);
	});
});

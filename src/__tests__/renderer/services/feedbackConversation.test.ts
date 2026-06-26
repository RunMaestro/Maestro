import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FeedbackConversationManager } from '../../../renderer/services/feedbackConversation';

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

	it('throws with the resolved binary path when the provider is detected but not runnable', async () => {
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

		await expect(manager.sendMessage('hi', [])).rejects.toThrow(codexBinary);
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

		await expect(manager.sendMessage('hi', [])).rejects.toThrow(
			'Maestro resolved its binary to "codex"'
		);
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

	it('passes SSH remote config through to the process spawn', async () => {
		const processMock = window.maestro.process as any;
		const sshRemoteConfig = {
			enabled: true,
			remoteId: 'remote-1',
			workingDirOverride: '/srv/app',
		};
		const manager = new FeedbackConversationManager();
		const sessionId = manager.start({
			agentType: 'codex',
			systemPrompt: 'system prompt',
			sshRemoteConfig,
		});

		const responsePromise = manager.sendMessage('hi', []);
		await tick();

		expect(processMock.spawn.mock.calls[0][0].sessionSshRemoteConfig).toEqual(sshRemoteConfig);

		// Settle the in-flight turn so its inactivity timeout and listeners are
		// torn down before the test ends (avoids open-handle flakiness).
		const exitCallback = processMock.onExit.mock.calls[0][0];
		exitCallback(sessionId, 0);
		await responsePromise;
	});
});

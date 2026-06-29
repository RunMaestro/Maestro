/**
 * Tests for feedbackConversation.ts
 *
 * Focus: provider-startup failures must surface an actionable error (the
 * resolved binary path + the provider's own output) instead of a generic
 * "something went wrong". This is the failure users hit when multiple Codex
 * installs are present and the wrong one (e.g. a codex-multi-auth wrapper or a
 * shadowed nvm binary) gets auto-selected and can't start. See issue #1064.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock window.maestro (mirrors inlineWizardConversation.test.ts pattern)
const mockMaestro = {
	agents: {
		get: vi.fn(),
	},
	process: {
		spawn: vi.fn(),
		onData: vi.fn(() => vi.fn()),
		onExit: vi.fn(() => vi.fn()),
		onThinkingChunk: vi.fn(() => vi.fn()),
		kill: vi.fn(),
	},
};

vi.stubGlobal('window', { maestro: mockMaestro });

// Import after mocking
import { FeedbackConversationManager } from '../../../renderer/services/feedbackConversation';

// Flush microtasks + the deferred spawn so the process listeners are registered.
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('FeedbackConversationManager - provider failure surfacing', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockMaestro.process.spawn.mockResolvedValue(undefined);
		mockMaestro.process.onData.mockImplementation(() => vi.fn());
		mockMaestro.process.onExit.mockImplementation(() => vi.fn());
	});

	it('spawns the resolved binary and reports its path + output when Codex exits non-zero', async () => {
		// Mimics jeffscottward's box: detection resolves a specific multi-auth
		// wrapper among several Codex installs.
		const codexBinary = '/Users/jeff/.nvm/versions/node/v25.3.0/bin/codex-multi-auth-codex';
		mockMaestro.agents.get.mockResolvedValue({
			id: 'codex',
			name: 'OpenAI Codex',
			available: true,
			command: 'codex',
			path: codexBinary,
			args: [],
		});

		const manager = new FeedbackConversationManager();
		const sessionId = manager.start({ agentType: 'codex', systemPrompt: 'sys' });

		const onError = vi.fn();
		const responsePromise = manager.sendMessage('it broke', [], { onError });

		await tick();

		// The spawn must use the resolved binary, not the bare command name.
		expect(mockMaestro.process.spawn).toHaveBeenCalledTimes(1);
		expect(mockMaestro.process.spawn.mock.calls[0][0].command).toBe(codexBinary);

		// Feed the provider's stderr, then simulate a non-zero exit.
		const dataCb = mockMaestro.process.onData.mock.calls[0][0];
		dataCb(sessionId, 'Error: not logged in. Run `codex login` first.\n');
		const exitCb = mockMaestro.process.onExit.mock.calls[0][0];
		exitCb(sessionId, 1);

		const response = await responsePromise;

		// User-facing message names the exact binary and the underlying error -
		// not the old generic string.
		expect(response.message).toContain(codexBinary);
		expect(response.message).toContain('not logged in');
		expect(response.message).not.toBe(
			'Something went wrong processing your message. Please try again.'
		);
		expect(onError).toHaveBeenCalledWith(expect.stringContaining('not logged in'));
	});

	it('still names the binary when the failed provider printed nothing', async () => {
		const codexBinary = '/opt/homebrew/bin/codex';
		mockMaestro.agents.get.mockResolvedValue({
			id: 'codex',
			name: 'OpenAI Codex',
			available: true,
			command: 'codex',
			path: codexBinary,
			args: [],
		});

		const manager = new FeedbackConversationManager();
		const sessionId = manager.start({ agentType: 'codex', systemPrompt: 'sys' });
		const responsePromise = manager.sendMessage('hi', []);
		await tick();

		const exitCb = mockMaestro.process.onExit.mock.calls[0][0];
		exitCb(sessionId, 127);

		const response = await responsePromise;
		expect(response.message).toContain(codexBinary);
		expect(response.message).toContain('127');
	});

	it('throws with the resolved binary path when the provider is detected but not runnable', async () => {
		const codexBinary = '/Users/jeff/.nvm/versions/node/v24.15.0/bin/codex';
		mockMaestro.agents.get.mockResolvedValue({
			id: 'codex',
			name: 'OpenAI Codex',
			available: false,
			command: 'codex',
			path: codexBinary,
			args: [],
		});

		const manager = new FeedbackConversationManager();
		manager.start({ agentType: 'codex', systemPrompt: 'sys' });

		await expect(manager.sendMessage('hi', [])).rejects.toThrow(codexBinary);
		// An unavailable provider must not be spawned.
		expect(mockMaestro.process.spawn).not.toHaveBeenCalled();
	});
});

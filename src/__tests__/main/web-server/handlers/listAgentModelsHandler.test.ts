/**
 * @file listAgentModelsHandler.test.ts
 * @description Tests for the list_agent_models WebSocket handler behind
 * `maestro-cli list models`. It must run the same discovery the desktop
 * pickers use, so a `--refresh` also reaches every picker on screen.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../../main/agents/model-discovery', () => ({
	discoverAgentModels: vi.fn(),
}));

vi.mock('../../../../main/stores/getters', () => ({
	getSshRemoteById: vi.fn(),
}));

import { handleListAgentModels } from '../../../../main/web-server/handlers/messageHandlers/models';
import { discoverAgentModels } from '../../../../main/agents/model-discovery';
import { getSshRemoteById } from '../../../../main/stores/getters';

const detector = { discoverModels: vi.fn() };

function makeCtx() {
	return {
		send: vi.fn(),
		sendError: vi.fn(),
		reportHandlerError: vi.fn(),
		callbacks: { getDebugPackageDeps: () => ({ getAgentDetector: () => detector }) },
	};
}

const client = { id: 'c1', connectedAt: 0, cli: true } as never;

describe('handleListAgentModels', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('runs the shared discovery and replies with the list', async () => {
		vi.mocked(discoverAgentModels).mockResolvedValue(['ollama/qwen3:8b']);
		const ctx = makeCtx();

		await handleListAgentModels(ctx as never, client, {
			type: 'list_agent_models',
			agentId: 'opencode',
			requestId: 'r1',
		});

		const [deps, options] = vi.mocked(discoverAgentModels).mock.calls[0];
		expect(options).toEqual({ agentId: 'opencode', forceRefresh: false, sshRemoteId: undefined });
		// The detector and SSH lookup are the app's own, not a second copy.
		expect(deps.getAgentDetector()).toBe(detector);
		expect(deps.getSshRemote).toBe(getSshRemoteById);
		expect(ctx.send).toHaveBeenCalledWith(client, {
			type: 'list_agent_models_result',
			success: true,
			agentId: 'opencode',
			sshRemoteId: null,
			models: ['ollama/qwen3:8b'],
			requestId: 'r1',
		});
	});

	it('forces a refresh and targets an SSH remote when asked', async () => {
		vi.mocked(discoverAgentModels).mockResolvedValue([]);
		const ctx = makeCtx();

		await handleListAgentModels(ctx as never, client, {
			type: 'list_agent_models',
			agentId: 'opencode',
			refresh: true,
			sshRemoteId: 'remote-1',
		});

		expect(vi.mocked(discoverAgentModels).mock.calls[0][1]).toEqual({
			agentId: 'opencode',
			forceRefresh: true,
			sshRemoteId: 'remote-1',
		});
		expect(ctx.send.mock.calls[0][1]).toMatchObject({ success: true, sshRemoteId: 'remote-1' });
	});

	it('rejects an unknown provider without running discovery', async () => {
		const ctx = makeCtx();

		await handleListAgentModels(ctx as never, client, {
			type: 'list_agent_models',
			agentId: 'not-a-provider',
		});

		expect(discoverAgentModels).not.toHaveBeenCalled();
		expect(ctx.send.mock.calls[0][1]).toMatchObject({
			type: 'list_agent_models_result',
			success: false,
			error: 'Unknown provider "not-a-provider".',
		});
	});

	it('reports a discovery failure instead of throwing', async () => {
		vi.mocked(discoverAgentModels).mockRejectedValue(new Error('SSH remote not found: gone'));
		const ctx = makeCtx();

		await handleListAgentModels(ctx as never, client, {
			type: 'list_agent_models',
			agentId: 'opencode',
			sshRemoteId: 'gone',
		});

		expect(ctx.send.mock.calls[0][1]).toMatchObject({
			success: false,
			error: 'SSH remote not found: gone',
		});
	});
});

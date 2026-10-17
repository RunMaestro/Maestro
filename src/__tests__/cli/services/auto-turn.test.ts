/**
 * @file auto-turn.test.ts
 * @description A turn on the Auto model that the CLI spawns itself.
 *
 * The model router is the desktop app's, so the CLI asks it over the WS bridge
 * and resolves the answer with the shared resolver. What is under test: the
 * request it sends, that no answer of any kind is a "no decision" and never a
 * failure, and that the agent's tier targets and the harness defaults reach
 * the resolution.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const desktop = vi.hoisted(() => ({
	connect: vi.fn(),
	sendCommand: vi.fn(),
	disconnect: vi.fn(),
}));
const storage = vi.hoisted(() => ({ readHarnessTierDefaults: vi.fn() }));

vi.mock('../../../cli/services/maestro-client', () => ({
	MaestroClient: class {
		connect = desktop.connect;
		sendCommand = desktop.sendCommand;
		disconnect = desktop.disconnect;
	},
	withMaestroClient: vi.fn(async (action: (client: unknown) => Promise<unknown>) => {
		await desktop.connect();
		try {
			return await action({ sendCommand: desktop.sendCommand });
		} finally {
			desktop.disconnect();
		}
	}),
}));
vi.mock('../../../cli/services/storage', () => storage);

import {
	CLI_ROUTE_BRIDGE_GRACE_MS,
	resolveCliAutoTurn,
	routeTurnViaDesktop,
} from '../../../cli/services/auto-turn';
import { MaestroClient } from '../../../cli/services/maestro-client';
import { MODEL_ROUTING_UNATTENDED_TIMEOUT_MS } from '../../../shared/local-models/model-routing-task';

const AGENT = { id: 'agent-1', toolType: 'claude-code' as const };
const LOCAL = { type: 'source' as const, endpointId: 'maestro-server', model: 'qwen3.5-4b' };
const ROUTED = {
	success: true,
	result: {
		tier: 'medium',
		effort: 'low',
		engine: { id: 'embedding-router', label: 'Embedding router', calibrated: false },
		latencyMs: 19,
	},
};
const STAMP = { tier: 'medium', effort: 'low', engine: 'Embedding router', calibrated: false };

beforeEach(() => {
	vi.clearAllMocks();
	desktop.connect.mockResolvedValue(undefined);
	desktop.sendCommand.mockResolvedValue(ROUTED);
	storage.readHarnessTierDefaults.mockReturnValue({});
});

describe('routeTurnViaDesktop', () => {
	it('asks the desktop to route the turn, with an unattended turn patience', async () => {
		const stamp = await routeTurnViaDesktop({ prompt: 'rename the helper', agentId: 'agent-1' });

		expect(stamp).toEqual(STAMP);
		expect(desktop.sendCommand).toHaveBeenCalledWith(
			{
				type: 'model_route_turn',
				request: {
					prompt: 'rename the helper',
					agentId: 'agent-1',
					timeoutMs: MODEL_ROUTING_UNATTENDED_TIMEOUT_MS,
				},
			},
			'model_route_turn_result',
			MODEL_ROUTING_UNATTENDED_TIMEOUT_MS + CLI_ROUTE_BRIDGE_GRACE_MS
		);
		expect(desktop.disconnect).toHaveBeenCalledTimes(1);
	});

	it('asks on a connection the caller already holds, and leaves it open', async () => {
		const client = new MaestroClient();

		await routeTurnViaDesktop({ prompt: 'p' }, client);

		expect(desktop.sendCommand).toHaveBeenCalledTimes(1);
		expect(desktop.connect).not.toHaveBeenCalled();
		expect(desktop.disconnect).not.toHaveBeenCalled();
	});

	it('carries a skip as the stamp that says why', async () => {
		desktop.sendCommand.mockResolvedValue({
			success: true,
			result: { skipped: 'off', detail: 'Model routing is off.', latencyMs: 0 },
		});
		expect(await routeTurnViaDesktop({ prompt: 'p' })).toEqual({
			skipped: 'off',
			detail: 'Model routing is off.',
		});
	});

	it('is no decision, never a throw, when the desktop is not running', async () => {
		desktop.connect.mockRejectedValue(new Error('Maestro is not running'));

		const stamp = await routeTurnViaDesktop({ prompt: 'p' });

		expect(stamp).toMatchObject({ skipped: 'unavailable' });
		expect('detail' in stamp && stamp.detail).toContain('Maestro is not running');
	});

	it('is no decision when the desktop is older than the message, or answers an error', async () => {
		desktop.sendCommand.mockRejectedValueOnce(new Error('Unsupported command: model_route_turn'));
		expect(await routeTurnViaDesktop({ prompt: 'p' })).toMatchObject({ skipped: 'unavailable' });

		desktop.sendCommand.mockResolvedValueOnce({ success: false, error: 'bad request' });
		const refused = await routeTurnViaDesktop({ prompt: 'p' });
		expect(refused).toMatchObject({ skipped: 'unavailable' });
		expect('detail' in refused && refused.detail).toContain('bad request');
	});
});

describe('resolveCliAutoTurn', () => {
	it('routes the prompt for the agent and launches on the tier and effort chosen', async () => {
		const turn = await resolveCliAutoTurn({ agent: AGENT, prompt: 'rename the helper' });

		expect(desktop.sendCommand.mock.calls[0][0]).toMatchObject({
			type: 'model_route_turn',
			request: { prompt: 'rename the helper', agentId: 'agent-1' },
		});
		expect(turn).toMatchObject({ model: 'sonnet', effort: 'low' });
		expect(turn.stamp).toEqual({ status: 'routed', route: STAMP });
	});

	it("with no desktop to ask, the turn runs on the agent's default and is not failed", async () => {
		desktop.connect.mockRejectedValue(new Error('Maestro is not running'));

		const turn = await resolveCliAutoTurn({ agent: AGENT, prompt: 'p', agentEffort: 'high' });

		expect(turn.model).toBeUndefined();
		expect(turn.effort).toBe('high');
		expect(turn.refusal).toBeUndefined();
		expect(turn.stamp.status).toBe('no-decision');
	});

	it("resolves the tier through the agent's targets and the harness defaults on disk", async () => {
		const own = await resolveCliAutoTurn({
			agent: { ...AGENT, tierTargets: { medium: LOCAL } },
			prompt: 'p',
		});
		expect(own).toMatchObject({ model: 'qwen3.5-4b', runOn: LOCAL, tierSource: 'agent' });

		storage.readHarnessTierDefaults.mockReturnValue({
			'claude-code': { medium: { type: 'provider-model', model: 'sonnet[1m]' } },
		});
		const harness = await resolveCliAutoTurn({ agent: AGENT, prompt: 'p' });
		expect(harness).toMatchObject({ model: 'sonnet[1m]', tierSource: 'harness-default' });
	});

	it('refuses, by name, a tier whose target cannot be used', async () => {
		const turn = await resolveCliAutoTurn({
			agent: { id: 'agent-1', toolType: 'factory-droid', tierTargets: { medium: LOCAL } },
			prompt: 'p',
		});
		expect(turn.refusal?.message).toMatch(/This agent's "medium" tier target/);
	});

	it('a marker wins the axes it sets, and one that sets both is not routed', async () => {
		const partial = await resolveCliAutoTurn({
			agent: AGENT,
			prompt: 'p',
			marker: { line: 0, tier: 'high', scopes: { tier: 'task' } },
		});
		expect(partial).toMatchObject({ model: 'opus', effort: 'low' });
		expect(desktop.sendCommand).toHaveBeenCalledTimes(1);

		const full = await resolveCliAutoTurn({
			agent: AGENT,
			prompt: 'p',
			marker: { line: 0, tier: 'high', effort: 'high' },
		});
		expect(full).toMatchObject({ model: 'opus', effort: 'max' });
		expect(desktop.sendCommand).toHaveBeenCalledTimes(1);
	});

	it('takes a router in place of the desktop round trip', async () => {
		const route = vi.fn(async () => ({
			tier: 'low' as const,
			effort: 'low' as const,
			engine: 'stub',
			calibrated: false,
		}));

		const turn = await resolveCliAutoTurn({ agent: AGENT, prompt: 'p', route });

		expect(route).toHaveBeenCalledWith({ prompt: 'p', agentId: 'agent-1' });
		expect(desktop.sendCommand).not.toHaveBeenCalled();
		expect(turn.model).toBe('haiku');
	});
});

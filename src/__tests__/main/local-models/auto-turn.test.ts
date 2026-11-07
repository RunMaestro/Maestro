/**
 * @file auto-turn.test.ts
 *
 * A turn on the Auto model that the main process launches with no tab behind
 * it (a Cue run that opts in, a headless send). `routeTurn` is mocked at its
 * entry; what is under test is what this module adds: the patient timeout of an
 * unattended turn, the agent's tier targets and the harness defaults reaching
 * the resolution, and rule 1 from the one record a headless session has.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const settings = vi.hoisted(() => new Map<string, unknown>());
const routeTurn = vi.hoisted(() => vi.fn());

vi.mock('../../../main/stores/getters', () => ({
	getSettingsStore: () => ({
		get: (key: string, fallback?: unknown) => (settings.has(key) ? settings.get(key) : fallback),
	}),
}));
vi.mock('../../../main/local-models/route-turn', () => ({ routeTurn }));

import {
	noteAutoSessionLaunch,
	resetAutoSessionLaunchesForTests,
	resolveAgentAutoTurn,
} from '../../../main/local-models/auto-turn';
import { promptCacheLifetimeMs } from '../../../shared/autoTurn';
import {
	MODEL_ROUTING_UNATTENDED_TIMEOUT_MS,
	type RouteTurnResult,
} from '../../../shared/local-models/model-routing-task';

const AGENT = { id: 'agent-1', toolType: 'claude-code' as const, customEffort: 'high' };
const LOCAL = { type: 'source' as const, endpointId: 'maestro-server', model: 'qwen3.5-4b' };

const routed = (
	tier: 'low' | 'medium' | 'high',
	effort: 'low' | 'medium' | 'high'
): RouteTurnResult => ({
	tier,
	effort,
	engine: { id: 'jev-cloud', label: 'Jev (TypeSafe cloud)', calibrated: true },
	latencyMs: 240,
});

beforeEach(() => {
	settings.clear();
	routeTurn.mockReset();
	routeTurn.mockResolvedValue(routed('medium', 'low'));
	resetAutoSessionLaunchesForTests();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('resolveAgentAutoTurn', () => {
	it('rejects a malformed tab target before requesting a routing decision', async () => {
		await expect(
			resolveAgentAutoTurn({
				agent: { ...AGENT, runOn: 'invalid' },
				tab: { agentSessionId: null },
				prompt: 'p',
			})
		).rejects.toThrow('Run on target');
		expect(routeTurn).not.toHaveBeenCalled();
	});

	it('freezes an explicit tab target when no routing decision is available', async () => {
		routeTurn.mockResolvedValue({ skipped: 'timeout', detail: 'timeout', latencyMs: 1 });
		const turn = await resolveAgentAutoTurn({
			agent: { ...AGENT, runOn: { type: 'provider' } },
			tab: { agentSessionId: null, tabProvider: 'codex', runOn: LOCAL },
			prompt: 'p',
		});
		expect(turn.runOn).toEqual(LOCAL);
		expect(turn.stamp.status).toBe('no-decision');
	});

	it('uses the supplied tab harness and Run on without inferring ownership from its native ID', async () => {
		settings.set('harnessTierDefaults', {
			codex: { medium: { type: 'provider-model', model: 'gpt-5.4' } },
		});
		const turn = await resolveAgentAutoTurn({
			agent: { ...AGENT, tierTargets: { medium: LOCAL }, runOn: LOCAL },
			tab: {
				agentSessionId: 'claude-looking-id',
				tabProvider: 'codex',
				runOn: { type: 'provider' },
			},
			prompt: 'p',
		});
		expect(turn).toMatchObject({ model: 'gpt-5.4', tierSource: 'harness-default' });
		expect(turn.refusal).toBeUndefined();
	});

	it('asks the router about the prompt, for the agent, with an unattended turn patience', async () => {
		const turn = await resolveAgentAutoTurn({ agent: AGENT, prompt: 'rename the helper' });

		expect(routeTurn).toHaveBeenCalledWith(
			{ agent: { id: 'agent-1' }, prompt: 'rename the helper' },
			{ timeoutMs: MODEL_ROUTING_UNATTENDED_TIMEOUT_MS }
		);
		expect(turn).toMatchObject({ model: 'sonnet', effort: 'low' });
		expect(turn.stamp).toMatchObject({
			status: 'routed',
			route: { tier: 'medium', effort: 'low', engine: 'Jev (TypeSafe cloud)', calibrated: true },
		});
	});

	it("hands the caller's stop signal to the router", async () => {
		const stop = new AbortController();
		await resolveAgentAutoTurn({ agent: AGENT, prompt: 'p', signal: stop.signal });
		expect(routeTurn.mock.calls[0][1]).toMatchObject({ signal: stop.signal });
	});

	it("resolves the tier through the agent's own targets", async () => {
		routeTurn.mockResolvedValue(routed('low', 'low'));
		const turn = await resolveAgentAutoTurn({
			agent: { ...AGENT, tierTargets: { low: LOCAL } },
			prompt: 'p',
		});
		expect(turn).toMatchObject({ model: 'qwen3.5-4b', runOn: LOCAL, tierSource: 'agent' });
	});

	it('resolves the tier through the harness defaults in Settings', async () => {
		settings.set('harnessTierDefaults', {
			'claude-code': { medium: { type: 'provider-model', model: 'sonnet[1m]' } },
		});
		const turn = await resolveAgentAutoTurn({ agent: AGENT, prompt: 'p' });
		expect(turn).toMatchObject({ model: 'sonnet[1m]', tierSource: 'harness-default' });
	});

	it("rule 2: no decision resolves to the agent's default, and its own effort", async () => {
		routeTurn.mockResolvedValue({ skipped: 'timeout', detail: 'slow', latencyMs: 5000 });
		const turn = await resolveAgentAutoTurn({ agent: AGENT, prompt: 'p' });

		expect(turn.model).toBeUndefined();
		expect(turn.effort).toBe('high');
		expect(turn.refusal).toBeUndefined();
		expect(turn.stamp.status).toBe('no-decision');
	});

	it('refuses, by name, a tier whose target cannot be used', async () => {
		const turn = await resolveAgentAutoTurn({
			agent: { ...AGENT, toolType: 'factory-droid', tierTargets: { medium: LOCAL } },
			prompt: 'p',
		});
		expect(turn.refusal?.message).toMatch(/This agent's "medium" tier target/);
	});

	it('lets a marker win the axis it sets, and still asks for the other', async () => {
		const turn = await resolveAgentAutoTurn({
			agent: AGENT,
			prompt: 'p',
			marker: { line: 0, effort: 'high', scopes: { effort: 'subscription' } },
		});
		expect(routeTurn).toHaveBeenCalledTimes(1);
		expect(turn).toMatchObject({ model: 'sonnet', effort: 'max' });
	});

	it('asks nothing when a marker sets both axes', async () => {
		const turn = await resolveAgentAutoTurn({
			agent: AGENT,
			prompt: 'p',
			marker: { line: 0, tier: 'high', effort: 'low' },
		});
		expect(routeTurn).not.toHaveBeenCalled();
		expect(turn).toMatchObject({ model: 'opus', effort: 'low' });
	});
});

describe('rule 1 for a headless session', () => {
	const NOW = 1_800_000_000_000;

	it('a session start takes the tier', async () => {
		const turn = await resolveAgentAutoTurn({ agent: AGENT, prompt: 'p' });
		expect(turn.model).toBe('sonnet');
		expect(turn.stamp.hold).toBeUndefined();
	});

	it('a resumed session nobody has a record of is cold, and takes the tier', async () => {
		const turn = await resolveAgentAutoTurn({
			agent: AGENT,
			prompt: 'p',
			providerSessionId: 'sess-unknown',
		});
		expect(turn.model).toBe('sonnet');
	});

	it('a session resumed inside the cache lifetime keeps its model and takes the effort', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		noteAutoSessionLaunch('claude-code', 'sess-1', { model: 'haiku' });
		routeTurn.mockResolvedValue(routed('high', 'medium'));

		vi.setSystemTime(NOW + 60_000);
		const turn = await resolveAgentAutoTurn({
			agent: AGENT,
			prompt: 'p',
			providerSessionId: 'sess-1',
		});

		expect(turn).toMatchObject({ model: 'haiku', effort: 'high' });
		expect(turn.stamp).toMatchObject({ status: 'routed', hold: { model: 'haiku' } });
	});

	it('keeps the place a tier sent the session, too', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		noteAutoSessionLaunch('claude-code', 'sess-1', { model: 'qwen3.5-4b', runOn: LOCAL });

		const turn = await resolveAgentAutoTurn({
			agent: AGENT,
			prompt: 'p',
			providerSessionId: 'sess-1',
		});

		expect(turn).toMatchObject({ model: 'qwen3.5-4b', runOn: LOCAL });
	});

	it('a session idle past the cache lifetime takes the tier again', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		noteAutoSessionLaunch('claude-code', 'sess-1', { model: 'haiku' });

		vi.setSystemTime(NOW + promptCacheLifetimeMs('claude-code') + 1);
		const turn = await resolveAgentAutoTurn({
			agent: AGENT,
			prompt: 'p',
			providerSessionId: 'sess-1',
		});

		expect(turn.model).toBe('sonnet');
	});

	it('does not read one provider session as another provider with the same id', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		noteAutoSessionLaunch('codex', 'sess-1', { model: 'gpt-6-luna' });

		const turn = await resolveAgentAutoTurn({
			agent: AGENT,
			prompt: 'p',
			providerSessionId: 'sess-1',
		});

		expect(turn.model).toBe('sonnet');
	});

	it('drops records that have gone cold when a new one is written', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		noteAutoSessionLaunch('claude-code', 'sess-old', { model: 'haiku' });

		vi.setSystemTime(NOW + promptCacheLifetimeMs('claude-code') + 1);
		noteAutoSessionLaunch('claude-code', 'sess-new', { model: 'opus' });
		// Wind the clock back: a record that survived would hold the model again.
		vi.setSystemTime(NOW + 1000);

		const turn = await resolveAgentAutoTurn({
			agent: AGENT,
			prompt: 'p',
			providerSessionId: 'sess-old',
		});
		expect(turn.model).toBe('sonnet');
	});
});

/**
 * @file system-one-route.test.ts
 * @description Tests for `maestro-cli s1 route`: a dry run of the model router.
 * The request crosses the WS bridge in the shape the desktop handler expects,
 * a decision prints who decided and how fast, `--agent` resolves the decision
 * through the resolver a send uses, `--correct` records a correction instead
 * of routing, and the exit code tells a script whether there was a decision.
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

vi.mock('../../../cli/services/maestro-client', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../cli/services/maestro-client')>()),
	withMaestroClient: vi.fn(),
}));

const storage = vi.hoisted(() => ({
	resolveAgentId: vi.fn(),
	getSessionById: vi.fn(),
	readHarnessTierDefaults: vi.fn(() => ({})),
	readLocalModelEndpoints: vi.fn(() => []),
}));
vi.mock('../../../cli/services/storage', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../cli/services/storage')>()),
	...storage,
}));

import {
	formatModelRouteDryRun,
	modelRouteExitCode,
	resolveRouteForAgent,
	systemOneRoute,
} from '../../../cli/commands/system-one-route';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { ExitCode } from '../../../cli/exit-codes';
import {
	EMBEDDING_ROUTER_ENGINE_ID,
	MODEL_ROUTING_TIMEOUT_MS,
	type ModelRouteDecision,
	type ModelRouteSkipped,
} from '../../../shared/local-models/model-routing-task';
import { resolveTierModel } from '../../../shared/modelTiers';
import type { SessionInfo } from '../../../shared/types';

const PROMPT = 'rename the helper in utils.ts';

const ENGINE = {
	id: EMBEDDING_ROUTER_ENGINE_ID,
	label: 'Embedding router (EmbeddingGemma 300M), not calibrated',
	calibrated: false,
};

const decision = (overrides: Partial<ModelRouteDecision> = {}): ModelRouteDecision => ({
	tier: 'medium',
	effort: 'low',
	tierConfidence: 0.62,
	effortConfidence: 0.4,
	engine: ENGINE,
	latencyMs: 120,
	...overrides,
});

const skipped = (overrides: Partial<ModelRouteSkipped> = {}): ModelRouteSkipped => ({
	skipped: 'off',
	detail: 'The model-routing task is off.',
	latencyMs: 0,
	...overrides,
});

const agentFixture = (overrides: Partial<SessionInfo> = {}): SessionInfo => ({
	id: 'agent-abc-123',
	name: 'Backend',
	toolType: 'claude-code',
	cwd: '/path/to/project',
	projectRoot: '/path/to/project',
	...overrides,
});

interface Sent {
	payload: Record<string, unknown>;
	responseType: string;
	timeoutMs: number | undefined;
}

/** Answer every bridge call with `reply(payload)`, recording what was sent. */
function mockBridge(reply: (payload: Record<string, unknown>) => Record<string, unknown>): Sent[] {
	const sent: Sent[] = [];
	vi.mocked(withMaestroClient).mockImplementation(async (action) =>
		action({
			sendCommand: vi
				.fn()
				.mockImplementation((payload: Record<string, unknown>, rt: string, timeoutMs?: number) => {
					sent.push({ payload, responseType: rt, timeoutMs });
					return Promise.resolve(reply(payload));
				}),
		} as never)
	);
	return sent;
}

let logSpy: MockInstance;
let errorSpy: MockInstance;
let exitSpy: MockInstance;

const printed = () => logSpy.mock.calls.map((call) => String(call[0])).join('\n');
const errors = () => errorSpy.mock.calls.map((call) => String(call[0])).join('\n');
const jsonOut = () => JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));

/** Run a command that is expected to exit, and answer with the code it exited with. */
async function exitCode(run: () => Promise<void>): Promise<number> {
	await expect(run()).rejects.toThrow(/^exit:/);
	return Number(exitSpy.mock.calls.at(-1)?.[0]);
}

beforeEach(() => {
	vi.clearAllMocks();
	storage.readHarnessTierDefaults.mockReturnValue({});
	storage.readLocalModelEndpoints.mockReturnValue([]);
	storage.resolveAgentId.mockImplementation((id: string) => id);
	storage.getSessionById.mockReturnValue(undefined);
	logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
	errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
		throw new Error(`exit:${code}`);
	}) as never);
});

describe('s1 route', () => {
	it('asks the desktop router and prints the tier, the effort, the engine and the latency', async () => {
		const sent = mockBridge(() => ({ success: true, result: decision() }));

		await systemOneRoute(PROMPT, {});

		expect(sent).toHaveLength(1);
		expect(sent[0].payload).toEqual({
			type: 'model_route_turn',
			request: { prompt: PROMPT, timeoutMs: 5000 },
		});
		expect(sent[0].responseType).toBe('model_route_turn_result');
		// The bridge waits longer than the router is told to, so the router's own
		// timeout answers first.
		expect(sent[0].timeoutMs).toBeGreaterThan(5000);
		const out = printed();
		expect(out).toContain(`${ENGINE.label} decided in 120 ms`);
		expect(out).toMatch(/Tier\s+medium\s+\(62% of the vote\)/);
		expect(out).toMatch(/Effort\s+low\s+\(40% of the vote\)/);
		expect(out).not.toContain('A typed send waits');
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it('prints the whole decision as JSON', async () => {
		mockBridge(() => ({ success: true, result: decision() }));

		await systemOneRoute(PROMPT, { json: true });

		const out = jsonOut();
		expect(out).toMatchObject({
			success: true,
			tier: 'medium',
			effort: 'low',
			engine: ENGINE,
			latencyMs: 120,
			withinSendTimeout: true,
		});
		expect(out).not.toHaveProperty('agent');
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it('flags an answer slower than a typed send waits', async () => {
		const slow = decision({ latencyMs: MODEL_ROUTING_TIMEOUT_MS + 1 });
		mockBridge(() => ({ success: true, result: slow }));

		await systemOneRoute(PROMPT, {});
		expect(printed()).toContain(
			`A typed send waits ${MODEL_ROUTING_TIMEOUT_MS} ms for the router.`
		);
		expect(printed()).toContain('would have run with no decision');

		logSpy.mockClear();
		await systemOneRoute(PROMPT, { json: true });
		expect(jsonOut()).toMatchObject({ success: true, withinSendTimeout: false });
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it('counts an answer at exactly the send timeout as in time', async () => {
		mockBridge(() => ({
			success: true,
			result: decision({ latencyMs: MODEL_ROUTING_TIMEOUT_MS }),
		}));

		await systemOneRoute(PROMPT, { json: true });

		expect(jsonOut().withinSendTimeout).toBe(true);
	});

	it('exits 6 when the router is off', async () => {
		mockBridge(() => ({ success: true, result: skipped() }));

		expect(await exitCode(() => systemOneRoute(PROMPT, {}))).toBe(ExitCode.Refused);
		expect(printed()).toContain('Auto (router off): The model-routing task is off.');

		logSpy.mockClear();
		expect(await exitCode(() => systemOneRoute(PROMPT, { json: true }))).toBe(6);
		expect(jsonOut()).toMatchObject({
			success: false,
			skipped: 'off',
			detail: 'The model-routing task is off.',
		});
	});

	it.each(['timeout', 'unavailable', 'cancelled', 'no-prompt'] as const)(
		'exits 7 when the router gave no decision (%s)',
		async (reason) => {
			mockBridge(() => ({
				success: true,
				result: skipped({ skipped: reason, detail: 'No answer.', engine: ENGINE, latencyMs: 5000 }),
			}));

			expect(await exitCode(() => systemOneRoute(PROMPT, {}))).toBe(ExitCode.NoAnswer);
			expect(printed()).toContain('Auto (no decision): No answer.');

			logSpy.mockClear();
			expect(await exitCode(() => systemOneRoute(PROMPT, { json: true }))).toBe(7);
			expect(jsonOut()).toMatchObject({ success: false, skipped: reason });
		}
	);

	it.each(['', '   \n'])('refuses a blank prompt (%j) before anything is sent', async (blank) => {
		const sent = mockBridge(() => ({ success: true, result: decision() }));

		expect(await exitCode(() => systemOneRoute(blank, {}))).toBe(ExitCode.InvalidUsage);
		expect(errors()).toContain('Give the prompt to route.');
		expect(sent).toEqual([]);
	});

	it('reports a blank prompt as JSON with --json', async () => {
		mockBridge(() => ({ success: true, result: decision() }));

		expect(await exitCode(() => systemOneRoute('', { json: true }))).toBe(2);
		expect(jsonOut()).toEqual({ success: false, error: 'Give the prompt to route.' });
	});

	it('exits 1 when the desktop answers with no result', async () => {
		mockBridge(() => ({ success: true }));

		expect(await exitCode(() => systemOneRoute(PROMPT, {}))).toBe(ExitCode.GeneralError);
		expect(errors()).toContain('The desktop app sent no routing result.');
	});

	it('exits 1 with the reason when the desktop refuses the request', async () => {
		mockBridge(() => ({ success: false, error: 'A routing request is an object.' }));

		expect(await exitCode(() => systemOneRoute(PROMPT, {}))).toBe(ExitCode.GeneralError);
		expect(errors()).toContain('A routing request is an object.');
	});

	describe('--agent', () => {
		it('names the agent in the request and resolves the decision through its tiers', async () => {
			const agent = agentFixture();
			storage.resolveAgentId.mockReturnValue(agent.id);
			storage.getSessionById.mockReturnValue(agent);
			const sent = mockBridge(() => ({ success: true, result: decision() }));
			const model = resolveTierModel('claude-code', 'medium');
			expect(model).toBeTruthy();

			await systemOneRoute(PROMPT, { agent: 'agent-abc', json: true });

			expect(storage.resolveAgentId).toHaveBeenCalledWith('agent-abc');
			expect(storage.getSessionById).toHaveBeenCalledWith(agent.id);
			expect(sent[0].payload).toEqual({
				type: 'model_route_turn',
				request: { prompt: PROMPT, agentId: agent.id, timeoutMs: 5000 },
			});
			const out = jsonOut();
			expect(out).toMatchObject({ success: true, tier: 'medium', withinSendTimeout: true });
			expect(out.agent).toMatchObject({
				id: agent.id,
				name: 'Backend',
				toolType: 'claude-code',
				support: { model: true, effort: true },
				model,
				label: `Auto → medium · ${model}`,
			});
			expect(out.agent).not.toHaveProperty('refusal');
			expect(out.agent.notes[0]).toContain(`${ENGINE.label} chose tier medium, effort low.`);
		});

		it('prints what a turn on Auto would launch on', async () => {
			const agent = agentFixture();
			storage.getSessionById.mockReturnValue(agent);
			mockBridge(() => ({ success: true, result: decision() }));
			const model = resolveTierModel('claude-code', 'medium');

			await systemOneRoute(PROMPT, { agent: agent.id });

			const out = printed();
			expect(out).toContain('Backend (Claude Code), at a session start:');
			expect(out).toContain(`Auto → medium · ${model}`);
			expect(out).toMatch(new RegExp(`Model\\s+${model}`));
			expect(out).toContain('Auto picks the model and the effort for each turn.');
		});

		it("resolves through the agent's own tier target ahead of the built-in table", async () => {
			const agent = agentFixture({
				tierTargets: { medium: { type: 'provider-model', model: 'my-own-sonnet' } },
			});
			storage.getSessionById.mockReturnValue(agent);
			mockBridge(() => ({ success: true, result: decision() }));

			await systemOneRoute(PROMPT, { agent: agent.id, json: true });

			expect(jsonOut().agent).toMatchObject({
				model: 'my-own-sonnet',
				label: 'Auto → medium · my-own-sonnet',
			});
		});

		it('still resolves the agent when the router gave no decision, and exits by the skip', async () => {
			const agent = agentFixture({ customEffort: 'high' });
			storage.getSessionById.mockReturnValue(agent);
			mockBridge(() => ({ success: true, result: skipped() }));

			expect(await exitCode(() => systemOneRoute(PROMPT, { agent: agent.id, json: true }))).toBe(
				ExitCode.Refused
			);
			const out = jsonOut();
			expect(out.success).toBe(false);
			expect(out.agent.label).toBe('Auto (router off)');
			expect(out.agent).not.toHaveProperty('model');
		});

		it('exits 2 for an agent id that resolves to nothing', async () => {
			storage.resolveAgentId.mockImplementation(() => {
				throw new Error('Agent not found: nope');
			});
			const sent = mockBridge(() => ({ success: true, result: decision() }));

			expect(await exitCode(() => systemOneRoute(PROMPT, { agent: 'nope' }))).toBe(
				ExitCode.InvalidUsage
			);
			expect(errors()).toContain('Agent not found: nope');
			expect(sent).toEqual([]);
		});

		it('exits 2 when the resolved id has no agent behind it', async () => {
			storage.resolveAgentId.mockReturnValue('agent-gone');
			storage.getSessionById.mockReturnValue(undefined);
			const sent = mockBridge(() => ({ success: true, result: decision() }));

			expect(await exitCode(() => systemOneRoute(PROMPT, { agent: 'gone', json: true }))).toBe(2);
			expect(jsonOut()).toEqual({ success: false, error: 'Agent not found: gone' });
			expect(sent).toEqual([]);
		});
	});

	describe('--correct', () => {
		it('records the correction instead of routing, and prints the count', async () => {
			const sent = mockBridge(() => ({
				success: true,
				result: { ok: true, replaced: false, total: 3 },
			}));

			await systemOneRoute(PROMPT, { correct: 'high' });

			expect(sent).toHaveLength(1);
			expect(sent[0].payload).toEqual({
				type: 'model_route_correct',
				request: { prompt: PROMPT, tier: 'high' },
			});
			expect(sent[0].responseType).toBe('model_route_correct_result');
			const out = printed();
			expect(out).toContain('Recorded: this prompt needs tier high.');
			expect(out).toContain('3 corrections kept.');
			expect(out).not.toContain('replaces the earlier correction');
			expect(exitSpy).not.toHaveBeenCalled();
		});

		it('reads the tier whatever its case and spacing', async () => {
			const sent = mockBridge(() => ({
				success: true,
				result: { ok: true, replaced: false, total: 1 },
			}));

			await systemOneRoute(PROMPT, { correct: '  LOW ' });

			expect(sent[0].payload).toEqual({
				type: 'model_route_correct',
				request: { prompt: PROMPT, tier: 'low' },
			});
			expect(printed()).toContain('1 correction kept.');
		});

		it('says when it replaced an earlier correction for the same prompt', async () => {
			mockBridge(() => ({ success: true, result: { ok: true, replaced: true, total: 4 } }));

			await systemOneRoute(PROMPT, { correct: 'medium' });

			expect(printed()).toContain('It replaces the earlier correction for the same prompt.');
		});

		it('prints the recorded correction as JSON', async () => {
			mockBridge(() => ({ success: true, result: { ok: true, replaced: true, total: 4 } }));

			await systemOneRoute(PROMPT, { correct: 'high', json: true });

			expect(jsonOut()).toEqual({ success: true, tier: 'high', replaced: true, total: 4 });
		});

		it('exits 2 for a tier that is not one, before anything is sent', async () => {
			const sent = mockBridge(() => ({ success: true, result: { ok: true, total: 1 } }));

			expect(await exitCode(() => systemOneRoute(PROMPT, { correct: 'bogus' }))).toBe(
				ExitCode.InvalidUsage
			);
			expect(errors()).toContain('"bogus" is not a tier. Use low, medium, high.');
			expect(sent).toEqual([]);
		});

		it('exits 2 with the reason when the store refuses the correction', async () => {
			mockBridge(() => ({
				success: true,
				result: { ok: false, message: 'There is no prompt to record a correction for.' },
			}));

			expect(await exitCode(() => systemOneRoute(PROMPT, { correct: 'high' }))).toBe(
				ExitCode.InvalidUsage
			);
			expect(errors()).toContain('There is no prompt to record a correction for.');
		});

		it('exits 1 when the desktop answers with no result', async () => {
			mockBridge(() => ({ success: true }));

			expect(await exitCode(() => systemOneRoute(PROMPT, { correct: 'high' }))).toBe(
				ExitCode.GeneralError
			);
			expect(errors()).toContain('The desktop app sent no result for the correction.');
		});
	});
});

describe('modelRouteExitCode', () => {
	it('is success for a decision', () => {
		expect(modelRouteExitCode(decision())).toBe(ExitCode.Success);
	});

	it('is Refused for a router that is off, and NoAnswer for every other skip', () => {
		expect(modelRouteExitCode(skipped())).toBe(ExitCode.Refused);
		for (const reason of ['no-prompt', 'timeout', 'unavailable', 'cancelled'] as const) {
			expect(modelRouteExitCode(skipped({ skipped: reason }))).toBe(ExitCode.NoAnswer);
		}
	});
});

describe('resolveRouteForAgent', () => {
	const context = { harnessDefaults: {}, endpoints: [] };

	it('resolves a decision to the built-in model of its tier', () => {
		const model = resolveTierModel('claude-code', 'high');
		const resolution = resolveRouteForAgent(agentFixture(), decision({ tier: 'high' }), context);

		expect(resolution).toMatchObject({
			id: 'agent-abc-123',
			name: 'Backend',
			toolType: 'claude-code',
			support: { model: true, effort: true },
			model,
			label: `Auto → high · ${model}`,
		});
		expect(resolution.runOn).toBeUndefined();
		expect(resolution.refusal).toBeUndefined();
	});

	it('reads a harness default ahead of the built-in table', () => {
		const resolution = resolveRouteForAgent(agentFixture(), decision(), {
			harnessDefaults: {
				'claude-code': { medium: { type: 'provider-model', model: 'harness-sonnet' } },
			},
			endpoints: [],
		});

		expect(resolution.model).toBe('harness-sonnet');
	});

	it("leaves the model and effort to the agent's default with no decision", () => {
		const resolution = resolveRouteForAgent(
			agentFixture({ customEffort: 'high' }),
			skipped({ skipped: 'timeout', detail: 'The router did not answer in 5000 ms.' }),
			context
		);

		expect(resolution.model).toBeUndefined();
		expect(resolution.effort).toBe('high');
		expect(resolution.label).toBe('Auto (no decision)');
		expect(resolution.notes[0]).toContain('The router did not answer in 5000 ms.');
	});

	it('says which axes Auto cannot act on for a provider with no tiers', () => {
		const resolution = resolveRouteForAgent(
			agentFixture({ toolType: 'opencode' }),
			decision(),
			context
		);

		expect(resolution.support.model).toBe(false);
		expect(resolution.model).toBeUndefined();
	});
});

describe('formatModelRouteDryRun', () => {
	it('prints a decision without the vote share when the router reports none', () => {
		const text = formatModelRouteDryRun({
			result: decision({ tierConfidence: undefined, effortConfidence: undefined }),
			withinSendTimeout: true,
		});

		expect(text).toContain(`${ENGINE.label} decided in 120 ms`);
		expect(text).toMatch(/Tier\s+medium$/m);
		expect(text).toMatch(/Effort\s+low$/m);
		expect(text).not.toContain('of the vote');
		expect(text).not.toContain('A typed send waits');
	});

	it('warns when the answer was slower than a typed send waits', () => {
		const text = formatModelRouteDryRun({
			result: decision({ latencyMs: 900 }),
			withinSendTimeout: false,
		});

		expect(text).toContain(`A typed send waits ${MODEL_ROUTING_TIMEOUT_MS} ms for the router.`);
	});

	it('heads a skip by its kind and prints no tier', () => {
		const off = formatModelRouteDryRun({ result: skipped(), withinSendTimeout: true });
		expect(off).toContain('Auto (router off): The model-routing task is off.');
		expect(off).not.toContain('Tier');

		const none = formatModelRouteDryRun({
			result: skipped({ skipped: 'unavailable', detail: 'The router could not run.' }),
			withinSendTimeout: true,
		});
		expect(none).toContain('Auto (no decision): The router could not run.');
	});

	it("prints the agent's resolution, its notes, its place and a refusal", () => {
		const text = formatModelRouteDryRun({
			result: decision(),
			withinSendTimeout: true,
			agent: {
				id: 'agent-abc-123',
				name: 'Backend',
				toolType: 'claude-code',
				support: { model: true, effort: true },
				label: 'Auto → medium · qwen3.5-4b · Maestro',
				model: 'qwen3.5-4b',
				effort: 'low',
				runOn: 'qwen3.5-4b · Maestro',
				notes: ['Auto: the router chose tier medium, effort low.'],
				refusal: 'The "medium" tier target cannot run.',
			},
		});

		expect(text).toContain('Backend (Claude Code), at a session start:');
		expect(text).toContain('  Auto → medium · qwen3.5-4b · Maestro');
		expect(text).toMatch(/Model\s+qwen3\.5-4b/);
		expect(text).toMatch(/Effort\s+low/);
		expect(text).toMatch(/Runs on\s+qwen3\.5-4b · Maestro/);
		expect(text).toContain('  Auto: the router chose tier medium, effort low.');
		expect(text).toContain('A send would be refused: The "medium" tier target cannot run.');
		expect(text).toContain('Auto picks the model and the effort for each turn.');
	});

	it("names the agent's default where the resolution sets nothing, and an Auto that changes nothing", () => {
		const text = formatModelRouteDryRun({
			result: decision(),
			withinSendTimeout: true,
			agent: {
				id: 'agent-oc',
				name: 'Scratch',
				toolType: 'opencode',
				support: { model: false, effort: false },
				label: 'Auto → medium',
				notes: [],
			},
		});

		expect(text).toMatch(/Model\s+the agent's default/);
		expect(text).toMatch(/Effort\s+the agent's default/);
		expect(text).not.toContain('Runs on');
		expect(text).toContain('Auto would change nothing for this agent.');
	});
});

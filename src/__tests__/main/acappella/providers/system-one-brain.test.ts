/**
 * @file system-one-brain.test.ts
 *
 * Voice routing on System One, as a decorator over a Brain, against a stubbed
 * task router.
 *
 * What is worth testing is the seam: which turns go to the engine and which
 * stay with the Brain, that the Brain is never asked to route in the place of
 * an engine that gave no answer, and that everything spoken is still the
 * Brain's own.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/maestro-test' } }));
vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../../main/local-models/task-router', () => ({ runSystemOneTask: vi.fn() }));

import { withSystemOneRouting } from '../../../../main/acappella/providers/system-one-brain';
import {
	runSystemOneTask,
	type SystemOneTaskResult,
} from '../../../../main/local-models/task-router';
import { isVoiceProviderError } from '../../../../shared/acappella/provider-errors';
import type { RosterAgent } from '../../../../shared/acappella/protocol';
import type { BrainProvider, VoiceRouteContext } from '../../../../shared/acappella/providers';
import type { RouteDecision } from '../../../../shared/acappella/route-decision';
import {
	VOICE_ROUTE_TAB_QUESTION_ID,
	VOICE_ROUTE_TARGET_QUESTION_ID,
} from '../../../../shared/acappella/voice-routing-system-one';

const JEV = 'Jev (TypeSafe cloud)';

const ROSTER: RosterAgent[] = [
	{
		sessionId: 'agent-backend',
		name: 'Backend',
		agentType: 'claude-code',
		cwd: '/repo/api',
		tabs: [{ id: 'tab-auth', name: 'Auth', lastActiveAt: 1 }],
	},
	{ sessionId: 'agent-web', name: 'Web', agentType: 'codex', cwd: '/repo/web', tabs: [] },
];
const CONTEXT: VoiceRouteContext = { roster: ROSTER, scope: { kind: 'conductor' } };

const BRAIN_DECISION: RouteDecision = {
	target: { sessionId: 'agent-web' },
	tabAction: 'current',
	prompt: 'from the brain',
	confidence: 0.9,
};

function makeBrain(extra: Partial<BrainProvider> = {}): BrainProvider {
	return {
		id: 'builtin-brain',
		label: 'Built-in',
		tier: 'local',
		route: vi.fn(async () => BRAIN_DECISION),
		converse: vi.fn(async () => 'spoken by the brain'),
		...extra,
	};
}

function answered(target: string, tab = 'current'): SystemOneTaskResult {
	return {
		status: 'ok',
		engine: 'jev-cloud',
		engineLabel: JEV,
		model: 'jev-1.13.0',
		answers: {
			[VOICE_ROUTE_TARGET_QUESTION_ID]: {
				type: 'choice',
				choice: target,
				probabilities: { [target]: 0.92 },
			},
			[VOICE_ROUTE_TAB_QUESTION_ID]: { type: 'choice', choice: tab },
		},
		usage: { inputTokens: 200, outputTokens: 3 },
		costUsd: 0.0000084,
		latencyMs: 240,
		calibrated: true,
		redacted: false,
	};
}

function noAnswer(code: 'auth' | 'rate-limited' | 'timeout' | 'unavailable' | 'off') {
	return {
		status: 'unavailable' as const,
		engine: 'jev-cloud' as const,
		engineLabel: JEV,
		code,
		reason: `${JEV} gave no answer (${code}).`,
	};
}

describe('withSystemOneRouting', () => {
	it("keeps the wrapped Brain's identity, so the HUD names the engine that speaks", () => {
		const brain = makeBrain();
		const routed = withSystemOneRouting(brain, { runTask: vi.fn() });
		expect(routed).toMatchObject({ id: 'builtin-brain', label: 'Built-in', tier: 'local' });
	});

	it('goes through the task router for the voice-routing task by default', async () => {
		vi.mocked(runSystemOneTask).mockResolvedValue({ status: 'not-assigned' });
		const brain = makeBrain();

		await withSystemOneRouting(brain).route('run the tests', CONTEXT);

		expect(runSystemOneTask).toHaveBeenCalledWith('voice-routing', {
			utterance: 'run the tests',
			context: CONTEXT,
		});
	});

	it('lets the Brain route, untouched, on any other assignment', async () => {
		const brain = makeBrain();
		const runTask = vi.fn(async () => ({ status: 'not-assigned' as const }));

		const decision = await withSystemOneRouting(brain, { runTask }).route('run the tests', CONTEXT);

		expect(decision).toBe(BRAIN_DECISION);
		expect(brain.route).toHaveBeenCalledWith('run the tests', CONTEXT);
	});

	it("routes on the engine's answers and never asks the Brain to route", async () => {
		const brain = makeBrain();
		const runTask = vi.fn(async () => answered('agent-backend', 'tab-auth'));

		const decision = await withSystemOneRouting(brain, { runTask }).route(
			'back to the auth work',
			CONTEXT
		);

		expect(runTask).toHaveBeenCalledWith({ utterance: 'back to the auth work', context: CONTEXT });
		expect(decision).toEqual({
			target: { sessionId: 'agent-backend' },
			tabAction: 'recall',
			tabId: 'tab-auth',
			prompt: 'back to the auth work',
			confidence: 0.92,
		});
		expect(brain.route).not.toHaveBeenCalled();
	});

	it('leaves a turn the Conductor may talk back in with the Brain, and asks the engine nothing', async () => {
		const brain = makeBrain();
		const runTask = vi.fn();
		const context = { ...CONTEXT, conversational: true };

		await expect(
			withSystemOneRouting(brain, { runTask }).route('I am thinking about the cache', context)
		).resolves.toBe(BRAIN_DECISION);

		expect(runTask).not.toHaveBeenCalled();
		expect(brain.route).toHaveBeenCalledWith('I am thinking about the cache', context);
	});

	it('refuses by name when the engine gives no answer, and never falls back to the Brain', async () => {
		const kinds = {
			auth: 'auth',
			'rate-limited': 'quota',
			timeout: 'timeout',
			unavailable: 'unavailable',
			off: 'unavailable',
		} as const;
		for (const [code, kind] of Object.entries(kinds)) {
			const brain = makeBrain();
			const runTask = vi.fn(async () => noAnswer(code as keyof typeof kinds));

			const failure = await withSystemOneRouting(brain, { runTask })
				.route('run the tests', CONTEXT)
				.catch((error: unknown) => error);

			expect(isVoiceProviderError(failure)).toBe(true);
			expect(failure).toMatchObject({
				kind,
				providerId: 'builtin-brain',
				message: `${JEV} gave no answer (${code}).`,
			});
			expect(brain.route).not.toHaveBeenCalled();
		}
	});

	it('refuses the same way under either fail policy: the task has none of its own', async () => {
		for (const status of ['failed-open', 'failed-closed'] as const) {
			const brain = makeBrain();
			const runTask = vi.fn(async () => ({ ...noAnswer('timeout'), status }));
			await expect(
				withSystemOneRouting(brain, { runTask }).route('run the tests', CONTEXT)
			).rejects.toMatchObject({ kind: 'timeout' });
			expect(brain.route).not.toHaveBeenCalled();
		}
	});

	it('refuses when the answers hold no decision, or the engine was stopped', async () => {
		const brain = makeBrain();
		const unreadable = vi.fn(async () => ({ ...answered('agent-backend'), answers: {} }));
		await expect(
			withSystemOneRouting(brain, { runTask: unreadable as never }).route('run it', CONTEXT)
		).rejects.toMatchObject({
			kind: 'unavailable',
			message: `${JEV} did not answer the routing questions.`,
		});

		const stopped = vi.fn(async () => ({
			status: 'cancelled' as const,
			engine: 'jev-cloud' as const,
			engineLabel: JEV,
		}));
		await expect(
			withSystemOneRouting(brain, { runTask: stopped }).route('run it', CONTEXT)
		).rejects.toMatchObject({ kind: 'timeout' });
		expect(brain.route).not.toHaveBeenCalled();
	});

	it('lets an unclassified engine failure propagate, for Sentry', async () => {
		const runTask = vi.fn(async () => {
			throw new Error('engine bug');
		});
		await expect(
			withSystemOneRouting(makeBrain(), { runTask }).route('run it', CONTEXT)
		).rejects.toThrow('engine bug');
	});

	it('leaves everything spoken to the Brain, streamed when the Brain streams', async () => {
		const converseContext = { agentSessionId: 'agent-backend', tabId: 'tab-auth' };
		const plain = makeBrain();
		const routedPlain = withSystemOneRouting(plain, { runTask: vi.fn() });
		await expect(routedPlain.converse('agent text', converseContext)).resolves.toBe(
			'spoken by the brain'
		);
		expect(routedPlain.converseStream).toBeUndefined();

		const streaming = makeBrain({
			async *converseStream() {
				yield 'spoken ';
				yield 'in pieces';
			},
		});
		const routed = withSystemOneRouting(streaming, { runTask: vi.fn() });
		const chunks: string[] = [];
		for await (const chunk of routed.converseStream!('agent text', converseContext)) {
			chunks.push(chunk);
		}
		expect(chunks).toEqual(['spoken ', 'in pieces']);
	});
});

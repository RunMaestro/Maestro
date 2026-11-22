/**
 * The Conductor Brain on a Local Models source: whatever the `voice-routing`
 * task is assigned to, a catalog model on this machine or a model on one of the
 * user's endpoints.
 *
 * **It owns no model and picks no source.** Every turn goes through the task
 * router (`runLocalTask('voice-routing', ...)`), the one choke point every
 * Local Models consumer uses. So the assignment is read at the moment of the
 * turn, the run is recorded beside every other task's, background indexing
 * stands aside while the user is waiting on a route, and a local model is the
 * app-wide resident one: a tab name generated mid-conversation does not open a
 * second copy.
 *
 * **A source that cannot answer is refused as itself.** The router never falls
 * back, and neither does this: not downloaded, runtime will not load, server
 * down, assignment switched off are each restated as this provider's classified
 * failure, with the router's own sentence naming the model or endpoint.
 *
 * **The decision is validated whatever produced it.** A local model is
 * grammar-constrained and a server is sent the schema as a response format, but
 * both guarantee a well-formed `sessionId`, not a real one. `parseRouteDecision`
 * checks it against the roster, the same as for the hosted Brains.
 */

import {
	ENDPOINT_BRAIN_PROVIDER_ID,
	QWEN3_BRAIN_PROVIDER_ID,
} from '../../../../shared/acappella/provider-catalog';
import { VoiceProviderError } from '../../../../shared/acappella/provider-errors';
import type {
	BrainProvider,
	VoiceConverseContext,
	VoiceRouteContext,
} from '../../../../shared/acappella/providers';
import type { RouteDecision } from '../../../../shared/acappella/route-decision';
import {
	ROUTE_DECISION_GRAMMAR_SCHEMA,
	ROUTE_DECISION_JSON_SCHEMA,
} from '../../../../shared/acappella/route-decision';
import {
	VOICE_ROUTING_TASK_ID,
	type VoiceBrainSource,
} from '../../../../shared/acappella/voice-routing';
import { isLocalModelCancelled, isLocalModelError } from '../../../local-models/errors';
import {
	DEFAULT_TASK_MAX_TOKENS,
	runLocalTask,
	type LocalTaskInput,
	type LocalTaskResult,
	type LocalTaskUnavailable,
} from '../../../local-models/task-router';
import { getLocalTextEngine, type LocalTextEngine } from '../../../local-models/text-gen';
import { taskAssignmentLocation } from '../../../../shared/local-models/settings-location';
import { beginSleepAwareSpan, sleepAwareElapsedMs } from '../../../utils/sleep-tracker';
import {
	buildConverseUserPrompt,
	buildRouteUserPrompt,
	converseSystemPrompt,
	limitSpokenReply,
	parseRouteDecision,
	routeSystemPrompt,
} from '../brain-prompt';

const ROUTE_MAX_TOKENS = 400;
const CONVERSE_MAX_TOKENS = 300;

/**
 * How long one turn may take before the floor is given back.
 *
 * Far longer than a hosted Brain's budget on purpose. The first turn of a
 * session can include a cold load (a second or two for a small local model,
 * much longer for a large model on a server that had it unloaded), and failing
 * that turn would fail every first turn. It is still a bound: a server that
 * accepted the request and never answers must not hold a spoken turn open.
 */
export const ASSIGNED_BRAIN_TURN_TIMEOUT_MS = 30_000;

/** What to tell the user when the slot is filled but the assignment names no model. */
const NOT_ASSIGNED_MESSAGE = `Voice routing has no model assigned. Assign one in ${taskAssignmentLocation('voice-routing')}, or pick another Conductor Brain in Settings > Plugins > A Cappella > Voice Providers.`;

export type AssignedBrainProviderId =
	| typeof QWEN3_BRAIN_PROVIDER_ID
	| typeof ENDPOINT_BRAIN_PROVIDER_ID;

export interface AssignedBrainOptions {
	/** Which of the two assigned Brains this is: a local model or an endpoint. */
	id: AssignedBrainProviderId;
	/**
	 * The source the assignment named when the pipeline was built. Used for the
	 * label and for freeing a local model on teardown; the router re-reads the
	 * assignment on every turn, so a change takes effect without a rebuild.
	 */
	source?: VoiceBrainSource;
	/** Injected in tests; production goes through the task router. */
	runTask?: (input: LocalTaskInput) => Promise<LocalTaskResult>;
	/** Injected in tests; production frees the model on the shared text engine. */
	unloadModel?: (modelId: string) => Promise<void>;
	/** Injected in tests. Defaults to {@link ASSIGNED_BRAIN_TURN_TIMEOUT_MS}. */
	turnTimeoutMs?: number;
}

export class AssignedBrainProvider implements BrainProvider {
	readonly id: AssignedBrainProviderId;
	readonly label: string;
	readonly tier = 'local' as const;

	private readonly source: VoiceBrainSource | undefined;
	private readonly runTask: (input: LocalTaskInput) => Promise<LocalTaskResult>;
	private readonly unloadModel: (modelId: string) => Promise<void>;
	private readonly turnTimeoutMs: number;

	constructor(options: AssignedBrainOptions) {
		this.id = options.id;
		this.source = options.source;
		this.label = options.source
			? `${options.source.label} (${options.id === QWEN3_BRAIN_PROVIDER_ID ? 'local' : 'endpoint'})`
			: options.id === QWEN3_BRAIN_PROVIDER_ID
				? 'Local model'
				: 'Model endpoint';
		this.runTask = options.runTask ?? ((input) => runLocalTask(VOICE_ROUTING_TASK_ID, input));
		this.unloadModel = options.unloadModel ?? ((modelId) => getLocalTextEngine().unload(modelId));
		this.turnTimeoutMs = options.turnTimeoutMs ?? ASSIGNED_BRAIN_TURN_TIMEOUT_MS;
	}

	async route(input: string, context: VoiceRouteContext): Promise<RouteDecision> {
		const raw = await this.generate(
			routeSystemPrompt(),
			buildRouteUserPrompt(input, context),
			ROUTE_MAX_TOKENS,
			// A llama.cpp grammar emits every listed property, so the local model gets
			// the shape whose optional fields may be null. See the schema's own note.
			this.id === QWEN3_BRAIN_PROVIDER_ID
				? ROUTE_DECISION_GRAMMAR_SCHEMA
				: ROUTE_DECISION_JSON_SCHEMA
		);
		return parseRouteDecision(raw, context, input);
	}

	async converse(agentText: string, context: VoiceConverseContext): Promise<string> {
		const raw = await this.generate(
			converseSystemPrompt(),
			buildConverseUserPrompt(agentText, context),
			CONVERSE_MAX_TOKENS
		);
		return limitSpokenReply(raw, context.maxSentences);
	}

	/**
	 * Free the local model now, on pipeline teardown. Only the model this Brain
	 * was built for, and only when it is the resident one: voice ending must not
	 * evict a different model a housekeeping task loaded. An endpoint holds
	 * nothing in this process.
	 */
	async unload(): Promise<void> {
		const assignment = this.source?.assignment;
		if (assignment?.type === 'local') await this.unloadModel(assignment.modelId);
	}

	/** One turn through the router, with its verdict restated as this provider's. */
	private async generate(
		system: string,
		prompt: string,
		maxTokens: number,
		jsonSchema?: Record<string, unknown>
	): Promise<string> {
		const verdict = await this.runTask({
			system,
			prompt,
			maxTokens,
			// Deterministic, for the same reason the hosted Brains are: a misroute
			// that cannot be reproduced cannot be fixed.
			temperature: 0,
			...(jsonSchema ? { jsonSchema } : {}),
			signal: AbortSignal.timeout(this.turnTimeoutMs),
		});

		switch (verdict.status) {
			case 'ok':
				return verdict.text;
			case 'unavailable':
				throw new VoiceProviderError(verdict.reason, {
					kind: failureKindFor(verdict),
					providerId: this.id,
				});
			case 'cancelled':
				// The only signal handed over is the turn budget, so a cancel is a timeout.
				throw new VoiceProviderError(
					`${this.label} did not answer within ${Math.round(this.turnTimeoutMs / 1000)} seconds.`,
					{ kind: 'timeout', providerId: this.id }
				);
			case 'off':
			case 'use-utility-agent':
				// The assignment was switched off under a pipeline built for it. Refused
				// by name; the next session resolves the Brain that is now in force.
				throw new VoiceProviderError(NOT_ASSIGNED_MESSAGE, {
					kind: 'unavailable',
					providerId: this.id,
				});
		}
	}
}

/**
 * How an unavailable source travels as a voice failure. An endpoint that could
 * not be reached or timed out may answer on the next try; everything else (a
 * model not downloaded, a runtime that will not load, a missing key, a model
 * the server does not have) is fixed in settings, not by saying it again.
 */
function failureKindFor(
	verdict: LocalTaskUnavailable
): 'auth' | 'network' | 'timeout' | 'unavailable' {
	if (verdict.code === 'auth') return 'auth';
	if (verdict.code === 'network') return 'network';
	if (verdict.code === 'timeout') return 'timeout';
	return 'unavailable';
}

/**
 * A `runTask` that runs every turn on one given engine and model, with no
 * assignment and no router.
 *
 * For harnesses that run outside the app (the routing evaluation script, the
 * on-device llama check), where there is no settings store to hold an
 * assignment and no stats database to record into. It classifies a failure the
 * way the router does, so the provider under test behaves as it would in a
 * session. Never used by a session: production turns go through the router.
 */
export function localEngineTaskRunner(
	engine: Pick<LocalTextEngine, 'generate'>,
	modelId: string
): (input: LocalTaskInput) => Promise<LocalTaskResult> {
	const source = { type: 'local' as const, modelId };
	return async (input) => {
		const span = beginSleepAwareSpan();
		try {
			const reply = await engine.generate(modelId, {
				prompt: input.prompt,
				system: input.system,
				maxTokens: input.maxTokens ?? DEFAULT_TASK_MAX_TOKENS,
				temperature: input.temperature ?? 0,
				jsonSchema: input.jsonSchema,
				signal: input.signal,
			});
			return { status: 'ok', text: reply.text, source, durationMs: sleepAwareElapsedMs(span) };
		} catch (error) {
			if (isLocalModelCancelled(error)) return { status: 'cancelled', source };
			if (isLocalModelError(error)) {
				return {
					status: 'unavailable',
					source,
					reason: `${error.message} ${error.recovery}`,
					code: error.code,
				};
			}
			throw error;
		}
	};
}

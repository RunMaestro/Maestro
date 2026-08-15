/**
 * OpenAI Conductor Brain.
 *
 * Two calls, both short and both on a cheap fast model, because routing latency
 * is felt directly: it sits between the user finishing a sentence and anything
 * happening at all. A large model would route marginally better and make the
 * feature feel broken.
 *
 * Routing uses structured outputs against the shared `RouteDecision` schema, so
 * the model cannot emit a shape the executor would have to reject. It is still
 * run through `parseRouteDecision`, which validates the ids against the roster
 * that was actually passed in - a schema guarantees a well-formed `sessionId`,
 * not a real one, and dispatching an utterance to a hallucinated agent is the
 * failure this whole subsystem is built to avoid.
 */

import { OPENAI_BRAIN_PROVIDER_ID } from '../../../../shared/acappella/provider-catalog';
import type {
	BrainProvider,
	VoiceConverseContext,
	VoiceRouteContext,
} from '../../../../shared/acappella/providers';
import type { RouteDecision } from '../../../../shared/acappella/route-decision';
import { ROUTE_DECISION_JSON_SCHEMA } from '../../../../shared/acappella/route-decision';
import {
	buildConverseUserPrompt,
	buildRouteUserPrompt,
	converseSystemPrompt,
	limitSpokenReply,
	parseRouteDecision,
	routeSystemPrompt,
} from '../brain-prompt';
import { getCredential } from '../credentials';
import { hostedJson, requireCredential, type HostedFetch } from './http';

const CHAT_URL = 'https://api.openai.com/v1/chat/completions';

/** Cheap, fast, and good enough to pick an agent out of a list. */
const DEFAULT_MODEL = 'gpt-4o-mini';

/**
 * Routing is on the critical path between a finished sentence and any visible
 * response, so it gets a tighter deadline than the rewrite that follows it.
 */
const ROUTE_TIMEOUT_MS = 8_000;
const CONVERSE_TIMEOUT_MS = 12_000;

/** A route decision is a small object; a spoken reply is two sentences. */
const ROUTE_MAX_TOKENS = 400;
const CONVERSE_MAX_TOKENS = 300;

export interface OpenAiBrainOptions {
	model?: string;
	fetchImpl?: HostedFetch;
	readCredential?: typeof getCredential;
	routeTimeoutMs?: number;
	converseTimeoutMs?: number;
}

export class OpenAiBrainProvider implements BrainProvider {
	readonly id = OPENAI_BRAIN_PROVIDER_ID;
	readonly label = 'OpenAI (hosted)';
	readonly tier = 'cloud' as const;

	private readonly model: string;
	private readonly fetchImpl?: HostedFetch;
	private readonly readCredential: typeof getCredential;
	private readonly routeTimeoutMs: number;
	private readonly converseTimeoutMs: number;

	constructor(options: OpenAiBrainOptions = {}) {
		this.model = options.model ?? DEFAULT_MODEL;
		this.fetchImpl = options.fetchImpl;
		this.readCredential = options.readCredential ?? getCredential;
		this.routeTimeoutMs = options.routeTimeoutMs ?? ROUTE_TIMEOUT_MS;
		this.converseTimeoutMs = options.converseTimeoutMs ?? CONVERSE_TIMEOUT_MS;
	}

	async route(input: string, context: VoiceRouteContext): Promise<RouteDecision> {
		const content = await this.complete({
			system: routeSystemPrompt(),
			user: buildRouteUserPrompt(input, context),
			timeoutMs: this.routeTimeoutMs,
			maxTokens: ROUTE_MAX_TOKENS,
			responseFormat: {
				type: 'json_schema',
				json_schema: {
					name: 'route_decision',
					strict: false,
					schema: ROUTE_DECISION_JSON_SCHEMA,
				},
			},
		});

		return parseRouteDecision(content, context, input);
	}

	async converse(agentText: string, context: VoiceConverseContext): Promise<string> {
		const content = await this.complete({
			system: converseSystemPrompt(),
			user: buildConverseUserPrompt(agentText, context),
			timeoutMs: this.converseTimeoutMs,
			maxTokens: CONVERSE_MAX_TOKENS,
		});

		return limitSpokenReply(content, context.maxSentences);
	}

	// -- Internals -----------------------------------------------------------

	private async complete(params: {
		system: string;
		user: string;
		timeoutMs: number;
		maxTokens: number;
		responseFormat?: unknown;
	}): Promise<string> {
		const key = requireCredential(this.id, 'openai', this.readCredential);

		const payload = await hostedJson<ChatCompletion>({
			providerId: this.id,
			service: 'openai',
			url: CHAT_URL,
			init: {
				method: 'POST',
				headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
				body: JSON.stringify({
					model: this.model,
					// Deterministic on purpose: the same utterance against the same
					// roster should route the same way twice, or "it went to the wrong
					// agent" becomes unreproducible.
					temperature: 0,
					max_tokens: params.maxTokens,
					messages: [
						{ role: 'system', content: params.system },
						{ role: 'user', content: params.user },
					],
					...(params.responseFormat ? { response_format: params.responseFormat } : {}),
				}),
			},
			timeoutMs: params.timeoutMs,
			fetchImpl: this.fetchImpl,
		});

		return payload.choices?.[0]?.message?.content ?? '';
	}
}

/** Sugar matching the rest of A Cappella's factories. */
export function createOpenAiBrainProvider(options: OpenAiBrainOptions = {}): OpenAiBrainProvider {
	return new OpenAiBrainProvider(options);
}

interface ChatCompletion {
	choices?: Array<{ message?: { content?: string } }>;
}

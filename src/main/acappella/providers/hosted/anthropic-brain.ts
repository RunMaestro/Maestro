/**
 * Anthropic Conductor Brain.
 *
 * Here so that a user with a Claude key is not made to open an OpenAI account to
 * use voice mode. Most Maestro users already have one; asking for a second
 * vendor relationship to route a sentence would be a tax on the feature.
 *
 * Same prompts, same parser, same validation as every other Brain (see
 * `../brain-prompt.ts`), so switching the Brain slot changes the vendor and not
 * the behaviour. Claude has no `response_format`, so the JSON discipline comes
 * from the system prompt plus an assistant prefill of `{`, which is the reliable
 * way to stop a model prefacing its object with "Sure! Here is the JSON:".
 */

import { ANTHROPIC_BRAIN_PROVIDER_ID } from '../../../../shared/acappella/provider-catalog';
import type {
	BrainProvider,
	VoiceConverseContext,
	VoiceRouteContext,
} from '../../../../shared/acappella/providers';
import type { RouteDecision } from '../../../../shared/acappella/route-decision';
import {
	buildConverseUserPrompt,
	buildRouteUserPrompt,
	CONVERSE_SYSTEM_PROMPT,
	limitSpokenReply,
	parseRouteDecision,
	ROUTE_SYSTEM_PROMPT,
} from '../brain-prompt';
import { getCredential } from '../credentials';
import { hostedJson, requireCredential, type HostedFetch } from './http';

const MESSAGES_URL = 'https://api.anthropic.com/v1/messages';

/** The version header the Messages API requires. Not a model version. */
const API_VERSION = '2023-06-01';

/** The fastest model in the family. Routing is a latency problem, not a hard one. */
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

const ROUTE_TIMEOUT_MS = 8_000;
const CONVERSE_TIMEOUT_MS = 12_000;

const ROUTE_MAX_TOKENS = 400;
const CONVERSE_MAX_TOKENS = 300;

/**
 * Prefill. The model continues from this rather than starting a sentence, so the
 * response is an object body and `parseRouteDecision` gets the brace back below.
 */
const JSON_PREFILL = '{';

export interface AnthropicBrainOptions {
	model?: string;
	fetchImpl?: HostedFetch;
	readCredential?: typeof getCredential;
	routeTimeoutMs?: number;
	converseTimeoutMs?: number;
}

export class AnthropicBrainProvider implements BrainProvider {
	readonly id = ANTHROPIC_BRAIN_PROVIDER_ID;
	readonly label = 'Anthropic (hosted)';
	readonly tier = 'cloud' as const;

	private readonly model: string;
	private readonly fetchImpl?: HostedFetch;
	private readonly readCredential: typeof getCredential;
	private readonly routeTimeoutMs: number;
	private readonly converseTimeoutMs: number;

	constructor(options: AnthropicBrainOptions = {}) {
		this.model = options.model ?? DEFAULT_MODEL;
		this.fetchImpl = options.fetchImpl;
		this.readCredential = options.readCredential ?? getCredential;
		this.routeTimeoutMs = options.routeTimeoutMs ?? ROUTE_TIMEOUT_MS;
		this.converseTimeoutMs = options.converseTimeoutMs ?? CONVERSE_TIMEOUT_MS;
	}

	async route(input: string, context: VoiceRouteContext): Promise<RouteDecision> {
		const content = await this.complete({
			system: ROUTE_SYSTEM_PROMPT,
			user: buildRouteUserPrompt(input, context),
			prefill: JSON_PREFILL,
			timeoutMs: this.routeTimeoutMs,
			maxTokens: ROUTE_MAX_TOKENS,
		});

		// The prefill is not echoed back, so it is restored before parsing.
		return parseRouteDecision(`${JSON_PREFILL}${content}`, context, input);
	}

	async converse(agentText: string, context: VoiceConverseContext): Promise<string> {
		const content = await this.complete({
			system: CONVERSE_SYSTEM_PROMPT,
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
		prefill?: string;
		timeoutMs: number;
		maxTokens: number;
	}): Promise<string> {
		const key = requireCredential(this.id, 'anthropic', this.readCredential);

		const messages: Array<{ role: string; content: string }> = [
			{ role: 'user', content: params.user },
		];
		if (params.prefill) messages.push({ role: 'assistant', content: params.prefill });

		const payload = await hostedJson<MessagesResponse>({
			providerId: this.id,
			service: 'anthropic',
			url: MESSAGES_URL,
			init: {
				method: 'POST',
				headers: {
					'x-api-key': key,
					'anthropic-version': API_VERSION,
					'content-type': 'application/json',
				},
				body: JSON.stringify({
					model: this.model,
					// Same reasoning as the OpenAI Brain: routing has to be reproducible
					// or a misroute cannot be investigated.
					temperature: 0,
					max_tokens: params.maxTokens,
					system: params.system,
					messages,
				}),
			},
			timeoutMs: params.timeoutMs,
			fetchImpl: this.fetchImpl,
		});

		return (payload.content ?? [])
			.filter((block) => block?.type === 'text' && typeof block.text === 'string')
			.map((block) => block.text as string)
			.join('');
	}
}

/** Sugar matching the rest of A Cappella's factories. */
export function createAnthropicBrainProvider(
	options: AnthropicBrainOptions = {}
): AnthropicBrainProvider {
	return new AnthropicBrainProvider(options);
}

interface MessagesResponse {
	content?: Array<{ type?: string; text?: string }>;
}

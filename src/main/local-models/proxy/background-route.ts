/**
 * The token proxy's per-request router: decide whether one Anthropic Messages
 * request is a BACKGROUND request, and write the target's model into it.
 *
 * A provider CLI sends two kinds of request. Its own turns (the main loop, and
 * a subagent's loop) carry the conversation. Its side requests (a session
 * title, the summary of a fetched web page) are self-contained and sent on the
 * provider's small model. An agent whose `backgroundRequests` names a target
 * has the second kind sent there (`shared/local-models/background-requests.ts`).
 *
 * The decision errs one way only. A request is routed when it names the small
 * model AND shows none of the signs of a turn; anything else goes to the
 * provider exactly as it arrived. Sending a turn to the target would change the
 * model in the middle of a session, which is the one thing this must never do,
 * so a sign that is only probably a turn still keeps the request on the
 * provider.
 *
 * The signs of a turn, any one of which is enough:
 *
 *   - `thinking`: a `thinking` or `redacted_thinking` block in the messages.
 *     Those are signed by the provider and mean nothing to another server.
 *   - `cache-control`: a `cache_control` breakpoint anywhere but the system
 *     prompt (on a message block, on a tool definition, or the request-level
 *     one, which lands on the last message). A CLI marks the conversation it
 *     will send again; it does not mark a one-off.
 *   - `tool-result`: a tool result in the messages. A tool ran, so this is a
 *     loop's next step, or a copy of one.
 *   - `tools`: the request declares tools. A loop does; a side request has
 *     nothing to call. This is what keeps the FIRST request of a loop on the
 *     provider when the CLI was told not to mark its conversation for caching.
 *
 * One small-model request is neither a turn nor work a target can do, and it
 * stays on the provider too:
 *
 *   - `probe`: the request asks for at most one token (`max_tokens` of 1 or
 *     less). Claude Code's TUI sends one before a turn (its message is the
 *     word `quota`) to learn the state of the ACCOUNT from the provider's
 *     answer: the status and the rate-limit headers. A local model answers 200
 *     with one token, which says nothing about the account and reads as "no
 *     limit". On a real session the provider answered that probe 429 and the
 *     target answered it 200 (docs/architecture/local-models.md).
 *
 * Like the compressor, this never parses the body into a value and prints it
 * again. It locates values (`json-spans.ts`) and writes one new string literal
 * over the model's. Every other byte is the byte the client sent.
 *
 * Pure: no I/O, no state.
 */

import { modelIdInTierFamily } from '../../../shared/modelTiers';
import {
	isNullSpan,
	memberOf,
	parseJsonSpans,
	spliceSpans,
	stringValue,
	type JsonSpan,
} from './json-spans';

/** Why a request stays on the provider. */
export type BackgroundRouteSkip =
	/** The body is not a JSON object with a model name and a message list. */
	| 'unreadable'
	/** The model is not the provider's small model. */
	| 'not-small-model'
	/** It asks for at most one token: a question about the provider, not work. */
	| 'probe'
	| 'thinking'
	| 'cache-control'
	| 'tool-result'
	| 'tools';

export type BackgroundRoutePlan =
	| {
			route: true;
			/** The small model the request named. */
			model: string;
			/** Where each top-level `model` value sits in the body. */
			modelSpans: ReadonlyArray<{ start: number; end: number }>;
	  }
	| { route: false; reason: BackgroundRouteSkip };

/** What a walk of the message list found. */
interface TurnSigns {
	thinking: boolean;
	cacheControl: boolean;
	toolResult: boolean;
}

function isSet(body: string, span: JsonSpan | undefined): boolean {
	return span !== undefined && !isNullSpan(body, span);
}

/**
 * Read every object under `span` for the block types and the marker that mean
 * a turn. The walk does not know the shape of a block, on purpose: a tool
 * result nests content blocks, a new block type may nest others, and a match in
 * a place that is not a block at all (inside a tool call's input, say) only
 * keeps the request on the provider.
 */
function findTurnSigns(body: string, span: JsonSpan, signs: TurnSigns): void {
	if (span.kind === 'array') {
		for (const item of span.items) findTurnSigns(body, item, signs);
		return;
	}
	if (span.kind !== 'object') return;
	for (const member of span.members) {
		if (member.key === 'cache_control') {
			if (isSet(body, member.value)) signs.cacheControl = true;
		} else if (member.key === 'type') {
			const type = stringValue(body, member.value) ?? '';
			if (type === 'thinking' || type === 'redacted_thinking') signs.thinking = true;
			// `tool_result`, and a server tool's (`web_search_tool_result`).
			else if (type === 'tool_result' || type.endsWith('_tool_result')) signs.toolResult = true;
		}
		findTurnSigns(body, member.value, signs);
	}
}

/**
 * Decide whether one Anthropic Messages request body is a background request
 * of a `toolType` agent. `toolType` names whose small model counts: a provider
 * Maestro knows no small model for is never routed.
 */
export function planBackgroundRoute(body: string, toolType: string): BackgroundRoutePlan {
	const root = parseJsonSpans(body);
	if (root?.kind !== 'object') return { route: false, reason: 'unreadable' };
	const model = stringValue(body, memberOf(root, 'model'));
	const messages = memberOf(root, 'messages');
	if (model === undefined || messages?.kind !== 'array') {
		return { route: false, reason: 'unreadable' };
	}
	if (!modelIdInTierFamily(toolType, 'low', model)) {
		return { route: false, reason: 'not-small-model' };
	}
	const maxTokens = memberOf(root, 'max_tokens');
	if (maxTokens?.kind === 'scalar' && Number(body.slice(maxTokens.start, maxTokens.end)) <= 1) {
		return { route: false, reason: 'probe' };
	}

	const signs: TurnSigns = { thinking: false, cacheControl: false, toolResult: false };
	findTurnSigns(body, messages, signs);
	// The request-level marker and a tool definition's are both breakpoints
	// outside the system prompt. Only the marker is read from the definitions:
	// a schema is free to use the word `type` however it likes.
	const tools = memberOf(root, 'tools');
	const inTools: TurnSigns = { thinking: false, cacheControl: false, toolResult: false };
	if (tools) findTurnSigns(body, tools, inTools);
	if (inTools.cacheControl || isSet(body, memberOf(root, 'cache_control'))) {
		signs.cacheControl = true;
	}

	if (signs.thinking) return { route: false, reason: 'thinking' };
	if (signs.cacheControl) return { route: false, reason: 'cache-control' };
	if (signs.toolResult) return { route: false, reason: 'tool-result' };
	if (tools?.kind === 'array' && tools.items.length > 0) return { route: false, reason: 'tools' };

	// Every top-level `model`, not only the one a parser would keep: no copy of
	// the provider's model name is left for the target to read instead.
	const modelSpans = root.members
		.filter((member) => member.key === 'model')
		.map((member) => ({ start: member.value.start, end: member.value.end }));
	return { route: true, model, modelSpans };
}

/** The body of a routed request: the one it arrived as, with `model` as its model. */
export function withRequestModel(
	body: string,
	plan: Extract<BackgroundRoutePlan, { route: true }>,
	model: string
): string {
	const literal = JSON.stringify(model);
	return spliceSpans(
		body,
		plan.modelSpans.map((span) => ({ ...span, text: literal }))
	);
}

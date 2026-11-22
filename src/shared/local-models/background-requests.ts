/**
 * Background requests: where an agent's SIDE requests go.
 *
 * Claude Code sends work that is not the conversation (a session title, the
 * summary of a fetched web page) on its small model. An agent on the Maestro
 * token proxy can send exactly those requests to a model on a Local Models
 * source, while its own turns keep going to the provider. The proxy decides per request
 * (`src/main/local-models/proxy/background-route.ts`). This module holds what
 * every surface shares: the stored setting, and the wording of a target that
 * cannot be used.
 *
 * Three rules every caller inherits:
 *
 * 1. Only a request that is unmistakably a side request is routed. Anything
 *    that could be the agent's own turn goes to the provider untouched, so the
 *    agent's main loop never changes model in the middle of a session.
 * 2. A target that cannot be used fails the request by name. The request is
 *    not sent to the provider instead: that would hide the failure and spend
 *    the money the user chose to save.
 * 3. Only the Anthropic Messages route is routed, and only to a source that
 *    serves it (`endpointServesAnthropicMessages`).
 */

import { getAgentDisplayName } from '../agentMetadata';
import { endpointServesAnthropicMessages, type LocalModelEndpoint } from './endpoints';
import { MODEL_SERVER_ENDPOINT_ID, MODEL_SERVER_NAME } from './model-server';
import {
	formatRunOnSpec,
	parseRunOnEdit,
	parseRunOnSpec,
	parseRunOnTarget,
	RUN_ON_PROVIDER_SPEC,
	runOnTargetLabel,
	type RunOnSourceTarget,
} from './run-on';
import {
	buildRunOnOptionGroups,
	type RunOnOptionGroup,
	type RunOnPickerSource,
} from './run-on-picker';
import { TOKEN_PROXY_NAME } from './token-proxy';

/** The agent setting. Absent on the agent record means every request goes to the provider. */
export interface BackgroundRequests {
	/**
	 * The model on a Local Models source that background requests are sent to.
	 * Its `contextTokens` is not stored: a request states its own limits.
	 */
	target: RunOnSourceTarget;
}

export type BackgroundRequestsParse =
	| { ok: true; backgroundRequests: BackgroundRequests | undefined }
	| { ok: false; error: string };

/**
 * Read the setting from anything that may hold one (the stored agent record, a
 * bridge message) and put it in the one form that is stored. A blank value and
 * a `provider` target both read as "not routed", which is the setting's
 * absence. Shared by the proxy and by every writer, so none can store a value
 * the proxy would then refuse as malformed.
 */
export function parseBackgroundRequests(value: unknown): BackgroundRequestsParse {
	if (value === undefined || value === null) return { ok: true, backgroundRequests: undefined };
	if (typeof value !== 'object' || Array.isArray(value)) {
		return { ok: false, error: 'Background requests is an object with a target.' };
	}
	const raw = (value as Record<string, unknown>).target;
	if (raw === undefined || raw === null) {
		return { ok: false, error: 'Background requests names a target.' };
	}
	const parsed = parseRunOnTarget(raw);
	if (!parsed.ok) return parsed;
	if (parsed.target.type === 'provider') return { ok: true, backgroundRequests: undefined };
	const { endpointId, model } = parsed.target;
	return { ok: true, backgroundRequests: { target: { type: 'source', endpointId, model } } };
}

/** The provider whose side requests the proxy can route: the Anthropic Messages route alone. */
const BACKGROUND_REQUESTS_PROVIDER = 'claude-code';

/**
 * The sentence beside the picker: what is routed, and what never is. The two
 * examples are the two requests a real session routed, and the last sentence
 * is what that session cost with a model that thinks: a minute for each page
 * (docs/architecture/local-models.md, "Real run: background requests").
 */
export const BACKGROUND_REQUESTS_DESCRIPTION = `${getAgentDisplayName(BACKGROUND_REQUESTS_PROVIDER)} sends side requests, such as a session title and the summary of a web page it fetched, on its small model. The ${TOKEN_PROXY_NAME} can send those to a local model. The agent's own turns always go to the provider, and a request the local model cannot serve fails: it is not sent to the provider instead. Pick a model that answers without thinking first: the agent waits for the summary of each page.`;

/** Why the setting needs the proxy first. Said by the picker's host and by every writer. */
export const BACKGROUND_REQUESTS_NEEDS_PROXY = `Background requests are routed by the ${TOKEN_PROXY_NAME}, and this agent does not use it. Set its proxy mode to Passthrough or Compress first.`;

/**
 * Whether an agent on this provider can have its background requests routed.
 * Only Claude Code: the proxy routes the Anthropic Messages route, and the
 * small-model rule that tells a side request from a turn is known for it alone.
 */
export function backgroundRequestsSupport(
	toolType: string
): { supported: true } | { supported: false; reason: string } {
	if (toolType === BACKGROUND_REQUESTS_PROVIDER) return { supported: true };
	return {
		supported: false,
		reason: `Background requests apply to ${getAgentDisplayName(BACKGROUND_REQUESTS_PROVIDER)} agents only: the ${TOKEN_PROXY_NAME} routes the Anthropic Messages route, which no other provider uses.`,
	};
}

/** How "not routed" is spelled on a command line. `provider` reads the same. */
export const BACKGROUND_REQUESTS_OFF_SPEC = 'none';

/** The setting as one word: `none`, or the Run on spelling `<source id>:<model>`. */
export function formatBackgroundRequestsSpec(
	backgroundRequests: BackgroundRequests | null | undefined
): string {
	return backgroundRequests
		? formatRunOnSpec(backgroundRequests.target)
		: BACKGROUND_REQUESTS_OFF_SPEC;
}

/**
 * Read a spelling written by {@link formatBackgroundRequestsSpec}, as typed on
 * `update-agent --background-requests` or chosen in the picker. Blank, `none`
 * and `provider` all mean "not routed".
 */
export function parseBackgroundRequestsSpec(spec: string): BackgroundRequestsParse {
	const trimmed = spec.trim();
	if (trimmed === '' || trimmed.toLowerCase() === BACKGROUND_REQUESTS_OFF_SPEC) {
		return { ok: true, backgroundRequests: undefined };
	}
	const parsed = parseRunOnSpec(trimmed);
	if (!parsed.ok) {
		return {
			ok: false,
			error: `Background requests take "${BACKGROUND_REQUESTS_OFF_SPEC}" or <source id>:<model>.`,
		};
	}
	return parseBackgroundRequests({ target: parsed.target });
}

/**
 * Check a setting someone is about to store on an agent: the Models tab's
 * picker, `update-agent --background-requests`, and the bridge that applies
 * it. On top of {@link parseBackgroundRequests} it refuses a provider the proxy
 * cannot route for, and (when `endpoints` is passed) a source id that names
 * nothing or a source not known to serve the Anthropic Messages route, so no
 * writer can store a target every background request would then fail on.
 *
 * Whether the agent uses the proxy needs the proxy's port, which the caller
 * that holds it checks ({@link BACKGROUND_REQUESTS_NEEDS_PROXY}). Whether the
 * source serves the model is not asked: that needs the network.
 */
export function parseBackgroundRequestsEdit(
	toolType: string,
	value: unknown,
	endpoints?: readonly Pick<LocalModelEndpoint, 'id' | 'name' | 'kind'>[]
): BackgroundRequestsParse {
	const parsed = parseBackgroundRequests(value);
	if (!parsed.ok || !parsed.backgroundRequests) return parsed;
	const support = backgroundRequestsSupport(toolType);
	if (!support.supported) return { ok: false, error: support.reason };

	const { target } = parsed.backgroundRequests;
	const known = parseRunOnEdit(toolType, target, endpoints);
	if (!known.ok) return known;
	const endpoint = endpoints?.find((candidate) => candidate.id === target.endpointId);
	if (endpoint && !endpointServesAnthropicMessages(endpoint)) {
		return {
			ok: false,
			error: `Maestro cannot tell that the source "${endpoint.name}" serves the Anthropic Messages route (/v1/messages), which a background request uses. Pick a model on the ${MODEL_SERVER_NAME}, Ollama or LM Studio.`,
		};
	}
	return parsed;
}

/** How the picker's first choice reads: every request goes to the provider. */
export const BACKGROUND_REQUESTS_OFF_LABEL = 'Off (send them to the provider)';

/**
 * The choices the Background requests picker offers: Off, then every model of
 * each source that serves the Anthropic Messages route, from the Run on
 * picker's own builder so a model reads the same in both. A source that does
 * not serve the route is left out, because choosing it would be refused. The
 * current target is listed even when nothing lists it, with the reason.
 * Option values are the shared spelling ({@link formatBackgroundRequestsSpec}).
 */
export function buildBackgroundRequestsOptionGroups(input: {
	current: BackgroundRequests | undefined;
	sources: readonly RunOnPickerSource[];
	endpoints: readonly Pick<LocalModelEndpoint, 'id' | 'name' | 'kind' | 'enabled'>[];
}): RunOnOptionGroup[] {
	const serves = (endpointId: string) => {
		if (endpointId === MODEL_SERVER_ENDPOINT_ID) return true;
		const endpoint = input.endpoints.find((candidate) => candidate.id === endpointId);
		return endpoint !== undefined && endpointServesAnthropicMessages(endpoint);
	};
	return buildRunOnOptionGroups({
		toolType: BACKGROUND_REQUESTS_PROVIDER,
		current: input.current?.target ?? { type: 'provider' },
		sources: input.sources.filter((source) => serves(source.endpointId)),
		endpoints: input.endpoints,
	}).map((group) => ({
		...group,
		options: group.options.map((option) =>
			option.value === RUN_ON_PROVIDER_SPEC
				? { value: BACKGROUND_REQUESTS_OFF_SPEC, label: BACKGROUND_REQUESTS_OFF_LABEL }
				: option
		),
	}));
}

/**
 * Why a background request could not be sent to its target.
 *
 *   - `background-invalid-target`: the stored setting is not a source and a model.
 *   - `background-source-missing`: the source is no longer configured.
 *   - `background-source-disabled`: the source is switched off.
 *   - `background-source-not-anthropic`: the source is not known to serve the
 *     Anthropic Messages route.
 *   - `background-server-failed`: the Maestro model server could not serve the model.
 */
export type BackgroundRequestsRefusalCode =
	| 'background-invalid-target'
	| 'background-source-missing'
	| 'background-source-disabled'
	| 'background-source-not-anthropic'
	| 'background-server-failed';

const NOT_SENT = 'The request was not sent to the provider.';
const TURN_OFF = 'turn Background requests off';

/**
 * The message for a background request whose target cannot be used, which is
 * what the client is answered with (rule 2). `target` is null only for
 * `background-invalid-target`, where `detail` says what is wrong with the
 * stored value; elsewhere `detail` is what the source or the server said.
 */
export function backgroundRequestsUnavailable(
	code: BackgroundRequestsRefusalCode,
	target: RunOnSourceTarget | null,
	endpoint: Pick<LocalModelEndpoint, 'id' | 'name'> | null,
	detail?: string
): string {
	const said = detail?.trim() ?? '';
	if (code === 'background-invalid-target' || !target) {
		return `This agent's Background requests target cannot be used${said ? `: ${said}` : '.'} ${NOT_SENT} Pick a model again, or ${TURN_OFF}.`;
	}
	const label = runOnTargetLabel(target, endpoint ? [endpoint] : []);
	const name = endpoint?.name ?? target.endpointId;
	const what: Record<
		Exclude<BackgroundRequestsRefusalCode, 'background-invalid-target'>,
		string
	> = {
		'background-source-missing': `its source (${target.endpointId}) is no longer configured. ${NOT_SENT} Pick a model again, or ${TURN_OFF}.`,
		'background-source-disabled': `the source "${name}" is disabled. ${NOT_SENT} Enable it, or ${TURN_OFF}.`,
		'background-source-not-anthropic': `Maestro cannot tell that the source "${name}" serves the Anthropic Messages route (/v1/messages), which a background request uses. ${NOT_SENT} Pick a model on the ${MODEL_SERVER_NAME}, Ollama or LM Studio, or ${TURN_OFF}.`,
		'background-server-failed': `the ${MODEL_SERVER_NAME} could not serve it${said ? ` (${said.replace(/\.$/, '')})` : ''}. ${NOT_SENT} Fix the model server, or ${TURN_OFF}.`,
	};
	return `This agent sends background requests to ${label}, but ${what[code]}`;
}

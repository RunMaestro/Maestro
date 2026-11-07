/**
 * Run on: the model an agent's harness talks to.
 *
 * An agent keeps its provider's CLI (Claude Code's tool loop, permissions and
 * transcripts, Maestro's parsers and session storage) and only the model behind
 * it changes. Its target is the provider's own cloud model (the default), or a
 * model on a Local Models source: the Maestro model server, a server the user
 * runs (Ollama, LM Studio), or a cloud endpoint from Sources.
 *
 * "How is this harness pointed at another model server" is a per-provider fact
 * and "may this launch do it" is a per-launch decision. Both live here, pure,
 * so the launch plan, the settings picker, the CLI and the turn pills cannot
 * disagree about them.
 *
 * Five rules every caller inherits:
 *
 * 1. A target that cannot run refuses the launch by name. It is never dropped
 *    so the turn can go to the provider's cloud model: that would spend money
 *    the user chose not to spend, and send the conversation where they chose
 *    not to send it.
 * 2. Only recipes checked against the real CLI are mapped. A guessed variable
 *    is ignored by the CLI, so the agent would run on the provider's model
 *    while every surface says it runs elsewhere.
 * 3. A variable the agent sets in its own environment wins, one variable at a
 *    time (the gateway's rule). The source's key is the exception in one
 *    direction: it is withheld when the agent sets the base URL itself, because
 *    a key belongs to the server it was issued for and must not be sent to an
 *    address the source does not own.
 * 4. The model is not in `args`. It is handed back as `model` and goes through
 *    the provider's own `modelArgs` builder, in the position that builder is
 *    known to work in (Codex reads `-m` after `exec`), and so that it REPLACES
 *    the agent's stored model instead of sitting beside it.
 * 5. The provider's own key never goes to the source. Claude Code sends
 *    `ANTHROPIC_API_KEY` as `x-api-key` to whatever its base URL is, beside the
 *    source's token (measured 2026-10-12, Claude Code 2.1.296), so a key the
 *    shell, Settings or the agent itself holds for Anthropic would reach a
 *    server Anthropic does not run. Such a variable is set blank for the launch,
 *    whoever set it. Rule 3 does not apply to it: a blank is not a value the
 *    user can be said to have chosen for this source. It is left alone only
 *    when the agent sets the base URL itself, because the request then goes
 *    where the agent's own variables send it.
 * 6. A variable that holds a whole document is added to, not replaced. OpenCode
 *    takes its provider from `OPENCODE_CONFIG_CONTENT`, the same variable that
 *    carries Maestro's permission block, the read-only override of it, or the
 *    user's own config. The recipe returns a merge for such a variable
 *    (`envVarMerges`), applied to whatever value the launch ends up with, so
 *    rule 3 has nothing to withhold: the user's document is the base.
 */

import { isEnvVarSet, type EnvVarMerge } from '../agentEnvironment';
import type { AgentId } from '../agentIds';
import { getAgentDisplayName } from '../agentMetadata';
import type { LocalModelEndpoint } from './endpoints';
import { isLoopbackGatewayUrl } from './gateway';
import { getLocalModel } from './model-catalog';
import {
	MODEL_SERVER_AGENT_MIN_CONTEXT,
	MODEL_SERVER_ENDPOINT_ID,
	MODEL_SERVER_NAME,
} from './model-server';
import { localModelAssignmentSourceLabel } from './tasks';

/** A model on a Local Models source, named the way an assignment names one. */
export interface RunOnSourceTarget {
	type: 'source';
	/** A configured endpoint's id, or `maestro-server` for the Maestro model server. */
	endpointId: string;
	/** The model name the source serves it under (a catalog id on the Maestro server). */
	model: string;
	/** The context the harness is told it has. Absent means {@link RUN_ON_DEFAULT_CONTEXT_TOKENS}. */
	contextTokens?: number;
}

/** Where an agent's model runs. Absent on the agent record means `provider`. */
export type RunOnTarget = { type: 'provider' } | RunOnSourceTarget;

/**
 * The context a harness is given when the target names none: the smallest
 * window an agent harness was measured to work in.
 */
export const RUN_ON_DEFAULT_CONTEXT_TOKENS = MODEL_SERVER_AGENT_MIN_CONTEXT;

/**
 * The smallest context a target may name. Below it a harness cannot hold its
 * own first prompt (see `MODEL_SERVER_AGENT_MIN_CONTEXT`), so every turn would
 * fail with "Prompt is too long".
 */
export const RUN_ON_MIN_CONTEXT_TOKENS = MODEL_SERVER_AGENT_MIN_CONTEXT;

/**
 * Why a context size cannot be stored on a target, or null when it can. The
 * one rule behind the picker's field, the CLI flag and {@link parseRunOnTarget}.
 */
export function runOnContextProblem(contextTokens: unknown): string | null {
	if (typeof contextTokens !== 'number' || !Number.isInteger(contextTokens) || contextTokens <= 0) {
		return 'A Run on context size is a whole number of tokens above zero.';
	}
	if (contextTokens < RUN_ON_MIN_CONTEXT_TOKENS) {
		return `A Run on context size is at least ${RUN_ON_MIN_CONTEXT_TOKENS} tokens: an agent harness cannot hold its own first prompt in less.`;
	}
	return null;
}

/**
 * Sent as the key to a source that has none. Claude Code refuses to start with
 * a base URL and no credential ("Not logged in"), and Codex refuses a provider
 * whose `env_key` variable is unset, so a keyless server still needs some text.
 */
export const RUN_ON_PLACEHOLDER_KEY = 'maestro-run-on';

/**
 * The variable a harness reads its Run on key from, when the harness lets the
 * launch name one: Codex's `env_key`, OpenCode's `{env:...}` reference.
 */
export const RUN_ON_KEY_ENV_VAR = 'MAESTRO_RUN_ON_KEY';

/**
 * The id of the model provider Maestro defines for a harness that takes a
 * provider definition (Codex on the command line, OpenCode in its inline
 * config). OpenCode names the model `<this id>/<model>`.
 */
const RUN_ON_PROVIDER_ID = 'maestro';

/**
 * What Copilot CLI is told the model IS (`COPILOT_PROVIDER_MODEL_ID`), apart
 * from the name it sends the source. Copilot CLI picks its tools from that id,
 * which defaults to `--model`: a name it takes for a GPT model gets a freeform
 * `apply_patch` tool (`"type": "custom"`), and `llama-server` answers a request
 * that carries one with 500 "Unsupported tool type". Measured 2026-10-12 with
 * Copilot CLI 1.0.95 and `gpt-oss-20b-mxfp4`: every call failed until the id
 * was a name no family matches, which gets plain function tools.
 */
const COPILOT_NEUTRAL_MODEL_ID = 'maestro-run-on';

/** The variable OpenCode reads an inline config document from. */
export const OPENCODE_CONFIG_ENV_VAR = 'OPENCODE_CONFIG_CONTENT';

/**
 * Claude Code's own output reservation. It holds this many tokens back from the
 * window before it decides to compact.
 */
const CLAUDE_CODE_DEFAULT_MAX_OUTPUT_TOKENS = 32_000;

/**
 * The output budget a harness is given for a window: a fifth of it, up to
 * Claude Code's own default. Measured 2026-10-12 with Claude Code at 40,960
 * tokens: with the default 32,000 held back about 9K is left, under Claude
 * Code's own system prompt, so it compacted on every turn and gave up
 * ("Autocompact is thrashing"); 8,192 (a fifth) worked for every model that
 * qualified. OpenCode and Copilot CLI are given the same split: OpenCode as
 * its model's output limit (it asked the source for exactly that many), Copilot
 * CLI as its output limit with the rest of the window as its prompt limit.
 */
export function runOnOutputTokens(contextTokens: number): number {
	return Math.min(CLAUDE_CODE_DEFAULT_MAX_OUTPUT_TOKENS, Math.floor(contextTokens / 5));
}

/** What a recipe is built from: a source the launch may use, already checked. */
export interface RunOnRecipeInput {
	/** The source's base URL: its root, with no `/v1` and no trailing slash. */
	baseUrl: string;
	/** The source's key, or {@link RUN_ON_PLACEHOLDER_KEY} when it has none. */
	key: string;
	model: string;
	contextTokens: number;
}

/** What a recipe hands back: everything that points one launch at the source. */
export interface RunOnRecipe {
	envVars: Record<string, string>;
	/**
	 * ROOT arguments. They go before the agent's own (ahead of any subcommand),
	 * which is where a CLI reads a global option. The model flag is not among
	 * them (rule 4).
	 */
	args: string[];
	/**
	 * Arguments that belong to the provider's batch subcommand, placed right
	 * after it (`placeSubcommandArgs`). OpenCode reads `--standalone` after `run`
	 * and rejects it in front.
	 */
	subcommandArgs?: string[];
	/**
	 * The name the harness is given for the model, when it is not the source's
	 * own name for it (OpenCode: `<provider id>/<model>`). It goes through the
	 * provider's `modelArgs` like any model (rule 4).
	 */
	harnessModel?: string;
	/** Variables built from the value the launch would otherwise carry (rule 6). */
	envVarMerges?: Record<string, EnvVarMerge>;
}

/** Whether a provider's harness can run on another model server, and how. */
export type AgentRunOnSupport =
	| {
			supported: true;
			/**
			 * The variable that carries the source's base URL, for a harness that
			 * reads it from the environment. Rule 3 reads it: when the agent sets it,
			 * `keyEnvVar` is withheld.
			 */
			baseUrlEnvVar?: string;
			/** The variable that carries the source's key. */
			keyEnvVar: string;
			/**
			 * The provider's own credential variables that the harness would send to
			 * the source as well. Set blank for the launch (rule 5).
			 */
			providerKeyEnvVars?: readonly string[];
			/** The variables and arguments that point the harness at the source. */
			recipe: (input: RunOnRecipeInput) => RunOnRecipe;
	  }
	| {
			supported: false;
			/** One sentence for the user, shown beside the disabled picker. */
			reason: string;
	  };

/**
 * Keyed by `AgentId`, so a new provider fails to compile until it is given a
 * recipe or a reason. Every recipe was run against the real CLI: Claude Code
 * 2.1.296 on the Maestro model server and on Ollama, and Codex CLI 0.162.1 on
 * the Maestro model server (2026-10-11 and 2026-10-12); OpenCode 2.0.25 and
 * Copilot CLI 1.0.85 on a loopback server that logs what it is sent
 * (2026-10-12). The providers with a reason were checked against their
 * documentation on 2026-10-12; none of their CLIs was on the machine to run.
 */
const RUN_ON_SUPPORT: Record<AgentId, AgentRunOnSupport> = {
	// The base URL alone fails with "Not logged in": the token is what makes
	// Claude Code skip its own login. Every tier variable is set because Claude
	// Code sends background work (titles, summaries, subagents) to its haiku
	// tier, and an unset tier names a model the source does not serve.
	'claude-code': {
		supported: true,
		baseUrlEnvVar: 'ANTHROPIC_BASE_URL',
		keyEnvVar: 'ANTHROPIC_AUTH_TOKEN',
		// Sent as `x-api-key` beside the token. A blank value sends no such header;
		// `CLAUDE_CODE_OAUTH_TOKEN` is not sent while the token is set (both
		// measured 2026-10-12).
		providerKeyEnvVars: ['ANTHROPIC_API_KEY'],
		recipe: ({ baseUrl, key, model, contextTokens }) => ({
			envVars: {
				ANTHROPIC_BASE_URL: baseUrl,
				ANTHROPIC_AUTH_TOKEN: key,
				ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
				ANTHROPIC_DEFAULT_SONNET_MODEL: model,
				ANTHROPIC_DEFAULT_OPUS_MODEL: model,
				CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(contextTokens),
				CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(runOnOutputTokens(contextTokens)),
			},
			args: [],
		}),
	},
	// A provider of its own, on the Responses route. With a ChatGPT login,
	// `-c openai_base_url=...` alone sends the ChatGPT token to the source; a
	// custom provider with its own `env_key` sends the source's key and nothing
	// else. The values are parsed as TOML, and they are written with nothing a
	// shell can change: no double quote and no space (see `tomlLiteral`). On
	// Windows an agent is started through a shell, and Windows PowerShell hands
	// a program an argument with its double quotes dropped and split at its
	// spaces. Codex refuses that ("unexpected argument", measured 2026-10-13
	// with Codex CLI 0.162.1, which takes this form on the same run).
	codex: {
		supported: true,
		keyEnvVar: RUN_ON_KEY_ENV_VAR,
		recipe: ({ baseUrl, key, contextTokens }) => ({
			envVars: { [RUN_ON_KEY_ENV_VAR]: key },
			args: [
				'-c',
				`model_providers.${RUN_ON_PROVIDER_ID}={name='Maestro',base_url=${tomlLiteral(`${baseUrl}/v1`)},env_key='${RUN_ON_KEY_ENV_VAR}',wire_api='responses'}`,
				'-c',
				`model_provider='${RUN_ON_PROVIDER_ID}'`,
				'-c',
				`model_context_window=${contextTokens}`,
			],
		}),
	},
	// Copilot CLI's own route for a custom provider (`copilot help providers`):
	// setting the base URL takes the launch off GitHub's model routing, and
	// GitHub sign-in is not used. It calls `/chat/completions` under the URL it
	// is given, so the URL carries `/v1`. Measured: the source's key is the only
	// credential sent (no GitHub token; a launch with no key sends an empty
	// bearer), `--model` names the model, and a resumed session stays on the
	// source. The model's name must not choose the tools: see
	// COPILOT_NEUTRAL_MODEL_ID.
	'copilot-cli': {
		supported: true,
		baseUrlEnvVar: 'COPILOT_PROVIDER_BASE_URL',
		keyEnvVar: 'COPILOT_PROVIDER_API_KEY',
		// Credentials for some OTHER custom provider, which Copilot CLI prefers to
		// the key above and would send to the source: a bearer token left in the
		// shell went out in place of the source's key (measured). A blank value
		// sends the key again.
		providerKeyEnvVars: [
			'COPILOT_PROVIDER_BEARER_TOKEN',
			'COPILOT_PROVIDER_API_KEY_COMMAND',
			'COPILOT_PROVIDER_HEADERS',
		],
		recipe: ({ baseUrl, key, model, contextTokens }) => {
			const outputTokens = runOnOutputTokens(contextTokens);
			return {
				envVars: {
					COPILOT_PROVIDER_BASE_URL: `${baseUrl}/v1`,
					// Both are Copilot CLI's defaults, stated so a value exported for
					// another provider does not pick the wire format.
					COPILOT_PROVIDER_TYPE: 'openai',
					COPILOT_PROVIDER_WIRE_API: 'completions',
					COPILOT_PROVIDER_API_KEY: key,
					// The name sent to the source. Left in the shell for another
					// provider, it went out in place of `--model` (measured).
					COPILOT_PROVIDER_WIRE_MODEL: model,
					// What picks Copilot CLI's tools. Never the model's own name, and
					// never a value left in the shell for another provider.
					COPILOT_PROVIDER_MODEL_ID: COPILOT_NEUTRAL_MODEL_ID,
					COPILOT_PROVIDER_MAX_PROMPT_TOKENS: String(contextTokens - outputTokens),
					COPILOT_PROVIDER_MAX_OUTPUT_TOKENS: String(outputTokens),
				},
				args: [],
			};
		},
	},
	// A provider of its own in OpenCode's inline config, on the Chat Completions
	// route, with the key read from the environment so it is not written into
	// the document. Two things the run showed:
	//   - `--standalone` is required. OpenCode 2 runs turns through a background
	//     service that was started with some other environment, and that service
	//     does not see this launch's config ("Model unavailable: maestro/..."). A
	//     private server reads it, and shares the session store, so a resumed
	//     session still resumes.
	//   - The session title is written by the same model: that request reached
	//     the source too, with the same key.
	// Measured on OpenCode 2.0.25. An older OpenCode has no `--standalone` and
	// fails the launch on the unknown option.
	opencode: {
		supported: true,
		keyEnvVar: RUN_ON_KEY_ENV_VAR,
		recipe: ({ baseUrl, key, model, contextTokens }) => ({
			envVars: { [RUN_ON_KEY_ENV_VAR]: key },
			args: [],
			subcommandArgs: ['--standalone'],
			harnessModel: `${RUN_ON_PROVIDER_ID}/${model}`,
			envVarMerges: {
				[OPENCODE_CONFIG_ENV_VAR]: (current) =>
					withOpenCodeProvider(current, {
						npm: '@ai-sdk/openai-compatible',
						name: 'Maestro',
						options: { baseURL: `${baseUrl}/v1`, apiKey: `{env:${RUN_ON_KEY_ENV_VAR}}` },
						models: {
							[model]: {
								name: model,
								limit: { context: contextTokens, output: runOnOutputTokens(contextTokens) },
							},
						},
					}),
			},
		}),
	},
	'factory-droid': {
		supported: false,
		reason: `${getAgentDisplayName('factory-droid')} takes another model server only from a settings file (its custom models list), and Maestro does not write one for a launch, so it runs on its provider's model only.`,
	},
	// Both speak the Gemini API only. `GOOGLE_GEMINI_BASE_URL` moves them to
	// another Gemini-compatible endpoint, which no Local Models source is, and
	// Antigravity also needs its settings file changed before it reads it.
	antigravity: geminiWireOnly('antigravity'),
	'gemini-cli': geminiWireOnly('gemini-cli'),
	'qwen3-coder': documentedNotRun('qwen3-coder', '--auth-type openai with --openai-base-url'),
	hermes: documentedNotRun('hermes', '--provider openai-api with OPENAI_BASE_URL'),
	// `LLAMA_BASE_URL` exists, for llama.cpp's router server only, and a stored
	// login for that provider wins over it.
	pi: {
		supported: false,
		reason: `${getAgentDisplayName('pi')} takes another model server only from its models file or an extension file, and Maestro does not write one for a launch, so it runs on its provider's model only.`,
	},
	omp: documentedNotRun('omp', 'LM_STUDIO_BASE_URL'),
	// `GROK_MODELS_BASE_URL` moves its requests, but a key for that address can
	// only be set per model in its config file. Its documented credential order
	// then falls to the signed-in session, which must not go to a source.
	grok: {
		supported: false,
		reason: `${getAgentDisplayName('grok')} has a base-URL variable but no way to give a launch a key for it, so Maestro cannot tell which credential it would send to another model server, and it runs on its provider's model only.`,
	},
	terminal: { supported: false, reason: 'A terminal is a shell, not an agent.' },
};

/**
 * A harness whose documentation names a way that Maestro has not run against
 * the real CLI. Rule 2 keeps it unmapped until one launch has been measured.
 */
function documentedNotRun(agentId: AgentId, way: string): AgentRunOnSupport {
	return {
		supported: false,
		reason: `${getAgentDisplayName(agentId)} documents a way to use another model server (${way}), but Maestro has not checked it against the real CLI, so it runs on its provider's model only.`,
	};
}

function geminiWireOnly(agentId: AgentId): AgentRunOnSupport {
	return {
		supported: false,
		reason: `${getAgentDisplayName(agentId)} speaks only the Gemini API, which a Local Models source does not serve, so it runs on its provider's model only.`,
	};
}

/**
 * A URL as a TOML literal string (single quotes, nothing escaped inside). A
 * literal string cannot hold a single quote, so one in the URL is written as
 * `%27`, which names the same address. A URL holds no space and no control
 * character once an endpoint record has accepted it.
 */
function tomlLiteral(url: string): string {
	return `'${url.replace(/'/g, '%27')}'`;
}

/**
 * OpenCode's inline config with Maestro's provider added to it. `current` is
 * the document the launch would otherwise carry (Maestro's permission block,
 * or the user's own); every other key of it is kept. A value that is not a
 * JSON object cannot be added to, and OpenCode could not have read it either,
 * so the provider is then the whole document.
 */
function withOpenCodeProvider(current: string | undefined, provider: unknown): string {
	const config = parseJsonObject(current);
	const providers = isJsonObject(config.provider) ? config.provider : {};
	return JSON.stringify({
		...config,
		provider: { ...providers, [RUN_ON_PROVIDER_ID]: provider },
	});
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonObject(text: string | undefined): Record<string, unknown> {
	if (!text) return {};
	try {
		const parsed: unknown = JSON.parse(text);
		return isJsonObject(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

/** Whether (and by which recipe) a provider's harness can run on another model server. */
export function agentRunOnSupport(toolType: string): AgentRunOnSupport {
	return (
		(RUN_ON_SUPPORT as Record<string, AgentRunOnSupport | undefined>)[toolType] ?? {
			supported: false,
			reason: `Maestro has not verified a way to point "${toolType}" at another model server.`,
		}
	);
}

/** Whether a stored target sends the agent's model somewhere other than its provider. */
export function isRunOnSourceTarget(
	target: RunOnTarget | null | undefined
): target is RunOnSourceTarget {
	return target?.type === 'source';
}

export type RunOnTargetParse = { ok: true; target: RunOnTarget } | { ok: false; error: string };

/**
 * Read a target from anything that may hold one (the stored agent record, a
 * bridge message) and put it in the one form that is stored: trimmed, with no
 * unknown keys. A blank value reads as `provider`, which is what an agent with
 * no target runs on. Shared by every writer, so none can store a target the
 * launch would then refuse as malformed.
 */
export function parseRunOnTarget(value: unknown): RunOnTargetParse {
	if (value === undefined || value === null) return { ok: true, target: { type: 'provider' } };
	if (typeof value !== 'object' || Array.isArray(value)) {
		return { ok: false, error: 'A Run on target is an object with a type.' };
	}
	const record = value as Record<string, unknown>;
	if (record.type === 'provider') return { ok: true, target: { type: 'provider' } };
	if (record.type !== 'source') {
		return { ok: false, error: 'A Run on target is "provider" or a source and a model.' };
	}
	const endpointId = typeof record.endpointId === 'string' ? record.endpointId.trim() : '';
	if (endpointId === '') return { ok: false, error: 'A Run on target names a source.' };
	const model = typeof record.model === 'string' ? record.model.trim() : '';
	if (model === '') return { ok: false, error: 'A Run on target names a model.' };
	if (record.contextTokens === undefined || record.contextTokens === null) {
		return { ok: true, target: { type: 'source', endpointId, model } };
	}
	const problem = runOnContextProblem(record.contextTokens);
	if (problem) return { ok: false, error: problem };
	const contextTokens = record.contextTokens as number;
	return { ok: true, target: { type: 'source', endpointId, model, contextTokens } };
}

/** How a target is spelled on a command line and as a picker option's value. */
export const RUN_ON_PROVIDER_SPEC = 'provider';

/**
 * A target as one word: `provider`, or `<endpoint-id>:<model>`. The context
 * size is not part of it; it is a field of its own on every surface.
 */
export function formatRunOnSpec(target: RunOnTarget): string {
	return target.type === 'provider' ? RUN_ON_PROVIDER_SPEC : `${target.endpointId}:${target.model}`;
}

/**
 * Read a spelling written by {@link formatRunOnSpec}. The source's id ends at
 * the FIRST colon, because a model name may hold one (`qwen3:latest`) and an
 * endpoint id never does. The result has passed {@link parseRunOnTarget}.
 */
export function parseRunOnSpec(spec: string, contextTokens?: number): RunOnTargetParse {
	const trimmed = spec.trim();
	if (trimmed === '' || trimmed.toLowerCase() === RUN_ON_PROVIDER_SPEC) {
		return { ok: true, target: { type: 'provider' } };
	}
	const separator = trimmed.indexOf(':');
	if (separator < 0) {
		return {
			ok: false,
			error: `A Run on target is "${RUN_ON_PROVIDER_SPEC}" or <source id>:<model>.`,
		};
	}
	return parseRunOnTarget({
		type: 'source',
		endpointId: trimmed.slice(0, separator),
		model: trimmed.slice(separator + 1),
		...(contextTokens === undefined ? {} : { contextTokens }),
	});
}

/**
 * The context a target starts at when its writer names none: the catalog's
 * context for a model on the Maestro model server (the server runs it at that
 * size), and the smallest agent context for a model on any other source, which
 * does not report one. Never under {@link RUN_ON_MIN_CONTEXT_TOKENS}. The
 * picker's field and the CLI's `--run-on` both start here.
 */
export function runOnDefaultContextTokens(
	target: Pick<RunOnSourceTarget, 'endpointId' | 'model'>
): number {
	const entry =
		target.endpointId === MODEL_SERVER_ENDPOINT_ID ? getLocalModel(target.model) : undefined;
	return Math.max(
		entry?.defaultContext ?? RUN_ON_DEFAULT_CONTEXT_TOKENS,
		RUN_ON_MIN_CONTEXT_TOKENS
	);
}

/**
 * What a writer stores: a source target, or `undefined` for the provider's own
 * model, which is the absence of a target on the agent record.
 */
export type RunOnEdit =
	| { ok: true; target: RunOnSourceTarget | undefined }
	| { ok: false; error: string };

/**
 * Check a target someone is about to store on an agent: the Edit Agent dialog,
 * `create-agent` / `update-agent --run-on`, and the bridge that applies them.
 * On top of {@link parseRunOnTarget} it refuses a source for a provider whose
 * harness has no recipe, with that provider's reason, so no writer can store a
 * target every launch would then refuse.
 *
 * Pass `endpoints` (the saved sources) to also refuse a source id that names
 * nothing. A writer that takes the id as typed text does; the dialog does not,
 * because its picker cannot produce an unknown id and an agent whose source was
 * removed must still be able to save its other settings.
 */
export function parseRunOnEdit(
	toolType: string,
	value: unknown,
	endpoints?: readonly Pick<LocalModelEndpoint, 'id' | 'name'>[]
): RunOnEdit {
	const parsed = parseRunOnTarget(value);
	if (!parsed.ok) return parsed;
	if (parsed.target.type === 'provider') return { ok: true, target: undefined };
	const target = parsed.target;

	const support = agentRunOnSupport(toolType);
	if (!support.supported) return { ok: false, error: support.reason };

	if (
		endpoints &&
		target.endpointId !== MODEL_SERVER_ENDPOINT_ID &&
		!endpoints.some((endpoint) => endpoint.id === target.endpointId)
	) {
		const saved = endpoints.map((endpoint) => `${endpoint.id} (${endpoint.name})`);
		return {
			ok: false,
			error: `No source has the id "${target.endpointId}". Use ${MODEL_SERVER_ENDPOINT_ID} for the ${MODEL_SERVER_NAME}${
				saved.length > 0 ? `, or a saved source: ${saved.join(', ')}` : '; no other source is saved'
			}.`,
		};
	}
	return { ok: true, target };
}

/**
 * A target for a person: the catalog name on the Maestro model server, or
 * `<model> on <source name>`. A source that is gone is named by the model alone.
 */
export function runOnTargetLabel(
	target: RunOnSourceTarget,
	endpoints: readonly Pick<LocalModelEndpoint, 'id' | 'name'>[]
): string {
	return (
		localModelAssignmentSourceLabel(
			{ type: 'endpoint', endpointId: target.endpointId, model: target.model },
			endpoints
		) ?? target.model
	);
}

/**
 * Why an agent's gateway and token proxy mode do not apply while its Run on
 * target is a source. Shown beside both controls, which are disabled for it.
 */
export const RUN_ON_GATEWAY_SKIPPED_REASON =
	'Not applied while Run on is a source: the gateway routes requests to the provider, and this agent sends its requests to the source. Set Run on to Provider to use it.';

/**
 * Why a gateway edit cannot be stored on an agent whose Run on target is
 * `runOn`, or null when it can. The dialog disables both gateway controls for
 * such an agent; a writer that takes typed values (the CLI, the bridge) refuses
 * with the same reason, so nobody is told a gateway was set that no launch will
 * use, and the token proxy is not started for an agent that cannot reach it.
 * Clearing a gateway (no URL, mode `off`) is always allowed.
 */
export function runOnGatewayEditProblem(
	runOn: unknown,
	edit: { gatewayUrl?: unknown; tokenProxyMode?: unknown }
): string | null {
	const setsGateway =
		(typeof edit.gatewayUrl === 'string' && edit.gatewayUrl.trim() !== '') ||
		(typeof edit.tokenProxyMode === 'string' && edit.tokenProxyMode !== 'off');
	return setsGateway && storedRunOnNamesSource(runOn) ? RUN_ON_GATEWAY_SKIPPED_REASON : null;
}

/** What the Maestro model server is called on a turn's pill. */
const RUN_ON_PILL_SERVER_NAME = 'Maestro';

/**
 * A target as a turn's pill names it: the model, then where it ran
 * (`qwen3-coder-30b-a3b-q4km · Maestro`, `qwen3:latest · Ollama`). A source
 * that is gone is named by the model alone.
 */
export function runOnPillLabel(
	target: RunOnSourceTarget,
	endpoints: readonly Pick<LocalModelEndpoint, 'id' | 'name'>[]
): string {
	if (target.endpointId === MODEL_SERVER_ENDPOINT_ID) {
		const name = getLocalModel(target.model)?.displayName ?? target.model;
		return `${name} · ${RUN_ON_PILL_SERVER_NAME}`;
	}
	const source = endpoints.find((endpoint) => endpoint.id === target.endpointId)?.name;
	return source ? `${target.model} · ${source}` : target.model;
}

/**
 * Why a launch was refused.
 *
 * The first five are decided here, from the stored target and the source's
 * record. The last three need the network or the model server, so the main
 * process decides them and words them with {@link runOnUnavailable}.
 *
 *   - `run-on-unsupported-provider`: the harness has no verified recipe.
 *   - `run-on-invalid-target`: the stored target is not a source and a model.
 *   - `run-on-source-missing`: the source is no longer configured.
 *   - `run-on-source-disabled`: the source is switched off.
 *   - `run-on-loopback-on-remote`: an SSH remote cannot reach a loopback source.
 *   - `run-on-source-unreachable`: the source did not answer.
 *   - `run-on-model-not-served`: the source answered, without this model.
 *   - `run-on-server-failed`: the Maestro model server could not serve it.
 */
export type RunOnRefusalCode =
	| 'run-on-unsupported-provider'
	| 'run-on-invalid-target'
	| 'run-on-source-missing'
	| 'run-on-source-disabled'
	| 'run-on-loopback-on-remote'
	| RunOnUnavailableCode;

export type RunOnUnavailableCode =
	| 'run-on-source-unreachable'
	| 'run-on-model-not-served'
	| 'run-on-server-failed';

export interface RunOnRefusal {
	kind: 'refused';
	code: RunOnRefusalCode;
	message: string;
}

export type RunOnLaunchResolution =
	/** The agent runs on its provider's own model. */
	| { kind: 'none' }
	/**
	 * Set these variables on the agent's process, put `args` ahead of its own
	 * arguments and `subcommandArgs` after its batch subcommand, apply
	 * `envVarMerges` to the environment it would otherwise get, and launch it
	 * with `harnessModel` through the provider's `modelArgs` builder in place of
	 * the agent's stored model.
	 */
	| {
			kind: 'inject';
			envVars: Record<string, string>;
			args: string[];
			/** Arguments for the provider's batch subcommand (`placeSubcommandArgs`). */
			subcommandArgs: string[];
			/** The source's name for the model: what a person is shown. */
			model: string;
			/** The name the harness is launched with. `model`, unless the harness wraps it. */
			harnessModel: string;
			/** Variables built from the value the launch would otherwise carry (rule 6). */
			envVarMerges: Record<string, EnvVarMerge>;
			contextTokens: number;
			/** Recipe variables the agent sets itself, which were left alone (rule 3). */
			userOverrides: string[];
			/**
			 * The provider's own key variables, which `envVars` sets blank so the
			 * harness does not send them to the source (rule 5).
			 */
			clearedEnvVars: string[];
	  }
	/** The launch must fail with this message (rule 1). */
	| RunOnRefusal;

export interface RunOnLaunchInput {
	/** The agent's provider, e.g. `claude-code`. */
	toolType: string;
	/** The agent's stored target. Absent, or `provider`, means its provider's model. */
	target?: RunOnTarget | null;
	/**
	 * The source the target names, looked up by the caller: a record from the
	 * saved list, or `modelServerEndpoint(baseUrl)` for the Maestro model server.
	 * Null or absent when no such source is configured.
	 */
	endpoint?: LocalModelEndpoint | null;
	/** The source's key, resolved by the caller. Absent when it has none. */
	key?: string;
	/**
	 * The agent's effective custom vars: its own, or the provider-level set when
	 * it has none (`effectiveAgentCustomEnvVars`). The layer rule 3 reads.
	 */
	userEnvVars?: Record<string, string>;
	/** The SSH remote the agent runs on, when it runs on one. */
	remote?: { name: string } | null;
}

/**
 * Whether a stored `runOn` value names a source, read as data: the launch will
 * run on that source or be refused. A malformed value counts, because it is
 * refused and never runs on the provider's model.
 */
export function storedRunOnNamesSource(value: unknown): boolean {
	const parsed = parseRunOnTarget(value);
	return !parsed.ok || parsed.target.type === 'source';
}

/**
 * The mode a harness launches in when its agent runs on a source: the one its
 * recipe was measured in (rule 2). Claude Code runs as `claude --print`, not
 * through the maestro-p TUI, which exists to spend a subscription plan that a
 * source does not have. Codex runs as `codex exec`, not on its app-server.
 * Any other launch keeps the mode it chose.
 */
export function runOnHarnessMode<Mode extends string>(
	target: unknown,
	chosen: Mode,
	measured: Mode
): Mode {
	return storedRunOnNamesSource(target) ? measured : chosen;
}

/**
 * A stored target with its source already looked up: what a launch plan is
 * handed. The lookup needs the saved endpoints, Settings -> Environment and the
 * Maestro model server, so a process that has them does it (`prepareAgentRunOn`
 * in the main process) and the plan stays pure.
 */
export type ResolvedRunOn = Pick<RunOnLaunchInput, 'toolType' | 'target' | 'endpoint' | 'key'>;

const RECOVERY = 'Fix the source, or set Run on to Provider.';

/**
 * Decide what an agent's Run on target does to one launch. The single answer
 * behind every spawn surface.
 */
export function resolveRunOnLaunch(input: RunOnLaunchInput): RunOnLaunchResolution {
	// The stored record is read as data, not trusted as its type: a hand-edited
	// or half-written target must refuse the launch, not reach a recipe.
	const parsed = parseRunOnTarget(input.target);
	if (!parsed.ok) {
		return {
			kind: 'refused',
			code: 'run-on-invalid-target',
			message: `This agent's Run on target cannot be used: ${parsed.error} Pick a model again, or set Run on to Provider.`,
		};
	}
	if (parsed.target.type === 'provider') return { kind: 'none' };
	const target = parsed.target;
	const endpoint = input.endpoint ?? null;
	const label = runOnTargetLabel(target, endpoint ? [endpoint] : []);

	const support = agentRunOnSupport(input.toolType);
	if (!support.supported) {
		return {
			kind: 'refused',
			code: 'run-on-unsupported-provider',
			message: `This agent is set to run on ${label}, but ${lowerFirst(support.reason)} Set Run on to Provider to run the agent.`,
		};
	}

	if (!endpoint) {
		return {
			kind: 'refused',
			code: 'run-on-source-missing',
			message: `This agent is set to run on ${label}, but its source (${target.endpointId}) is no longer configured. Pick a model again, or set Run on to Provider.`,
		};
	}

	if (!endpoint.enabled) {
		return {
			kind: 'refused',
			code: 'run-on-source-disabled',
			message: `This agent is set to run on ${label}, but the source "${endpoint.name}" is disabled. Enable it, or set Run on to Provider.`,
		};
	}

	// An agent that sets the base URL itself is not sent to the source's address
	// (rule 3), so the address being loopback is not what its launch depends on.
	// The gateway checks in the same order.
	const userSetsBaseUrl =
		support.baseUrlEnvVar !== undefined && isEnvVarSet(input.userEnvVars, support.baseUrlEnvVar);
	if (input.remote && !userSetsBaseUrl && isLoopbackGatewayUrl(endpoint.baseUrl)) {
		return {
			kind: 'refused',
			code: 'run-on-loopback-on-remote',
			message: `This agent is set to run on ${label} (${endpoint.baseUrl}), which is a loopback address on this machine that SSH remote "${input.remote.name}" cannot reach. Pick a source the remote host can reach, or set Run on to Provider.`,
		};
	}

	const contextTokens = target.contextTokens ?? RUN_ON_DEFAULT_CONTEXT_TOKENS;
	const recipe = support.recipe({
		baseUrl: endpoint.baseUrl.replace(/\/+$/, ''),
		key: input.key?.trim() || RUN_ON_PLACEHOLDER_KEY,
		model: target.model,
		contextTokens,
	});

	const userOverrides = Object.keys(recipe.envVars).filter((name) =>
		isEnvVarSet(input.userEnvVars, name)
	);
	const withheld = new Set(userOverrides);
	if (userSetsBaseUrl) withheld.add(support.keyEnvVar);
	// Rule 5. Not when the agent routes itself: its request does not go to the
	// source, so its own key is its own business.
	const clearedEnvVars = userSetsBaseUrl ? [] : [...(support.providerKeyEnvVars ?? [])];

	return {
		kind: 'inject',
		envVars: {
			...Object.fromEntries(clearedEnvVars.map((name) => [name, ''])),
			...Object.fromEntries(Object.entries(recipe.envVars).filter(([name]) => !withheld.has(name))),
		},
		args: recipe.args,
		subcommandArgs: recipe.subcommandArgs ?? [],
		model: target.model,
		harnessModel: recipe.harnessModel ?? target.model,
		envVarMerges: recipe.envVarMerges ?? {},
		contextTokens,
		userOverrides,
		clearedEnvVars,
	};
}

/**
 * The refusal for a target whose source cannot serve the model right now. The
 * main process calls it after asking the source (or starting the Maestro model
 * server), so the three failures only it can see are worded in one place.
 * `detail` is what the source or the server said.
 */
export function runOnUnavailable(
	code: RunOnUnavailableCode,
	target: RunOnSourceTarget,
	endpoint: Pick<LocalModelEndpoint, 'id' | 'name'>,
	detail?: string
): RunOnRefusal {
	const label = runOnTargetLabel(target, [endpoint]);
	const said = detail?.trim() ? ` (${detail.trim().replace(/\.$/, '')})` : '';
	const what: Record<RunOnUnavailableCode, string> = {
		'run-on-source-unreachable': `the source "${endpoint.name}" did not answer${said}`,
		'run-on-model-not-served': `the source "${endpoint.name}" does not serve "${target.model}"${said}`,
		'run-on-server-failed': `the ${endpoint.name} could not serve it${said}`,
	};
	return {
		kind: 'refused',
		code,
		message: `This agent is set to run on ${label}, but ${what[code]}. ${RECOVERY}`,
	};
}

function lowerFirst(text: string): string {
	// A reason starts with "Maestro" or a provider's name; only an article is lowered.
	return /^(A|An|The) /.test(text) ? text.charAt(0).toLowerCase() + text.slice(1) : text;
}

/** The prompt a Run on test sends: one word back proves the whole route. */
export const RUN_ON_TEST_PROMPT = 'Reply with the single word: ready';

/** How much of the model's reply a test result carries. */
export const RUN_ON_TEST_REPLY_MAX_CHARS = 400;

/**
 * The parts of an agent a Run on test launches with. The stored agent supplies
 * them; a form that is not saved yet (New Agent, an Edit Agent with changes)
 * sends its own values on top.
 */
export interface RunOnTestSubject {
	/** The agent's provider, e.g. `claude-code`. */
	toolType: string;
	/** The directory the harness starts in (the remote path, on an SSH remote). */
	cwd: string;
	customPath?: string;
	customArgs?: string;
	customEnvVars?: Record<string, string>;
	sshRemoteConfig?: { enabled: boolean; remoteId: string | null; workingDirOverride?: string };
}

export interface RunOnTestRequest {
	/** The stored agent to test. Absent for an agent that does not exist yet. */
	agentId?: string;
	/**
	 * A form's values that are not saved yet. When present they are the agent's
	 * launch settings as a set: the custom path, arguments, variables and SSH
	 * remote are read from here and not from the stored agent, so a field the
	 * form cleared is tested as cleared. Only the provider and the directory fall
	 * back to the stored agent.
	 */
	subject?: Partial<RunOnTestSubject>;
	/** A target that is not saved yet, as data. Absent tests the stored one. */
	target?: unknown;
}

/**
 * Why a test did not produce a reply. A launch refusal keeps its own code; the
 * rest are the test's:
 *
 *   - `run-on-test-invalid-request`: no agent and no provider to test.
 *   - `run-on-test-provider-target`: the target is Provider, so there is no source to test.
 *   - `run-on-test-not-startable`: the harness could not be started (not installed, no batch mode, an SSH remote that is gone).
 *   - `run-on-test-timeout`: no reply within the budget.
 *   - `run-on-test-turn-failed`: the harness ran and the turn did not complete.
 */
export type RunOnTestFailureCode =
	| RunOnRefusalCode
	| 'run-on-test-invalid-request'
	| 'run-on-test-provider-target'
	| 'run-on-test-not-startable'
	| 'run-on-test-timeout'
	| 'run-on-test-turn-failed';

export type RunOnTestResult =
	| {
			ok: true;
			/** The source's name for the model that answered. */
			model: string;
			/** The target for a person (`runOnTargetLabel`). */
			label: string;
			/** What the model said, trimmed and capped. */
			reply: string;
			/** From the launch to the end of the turn. */
			durationMs: number;
			contextTokens: number;
	  }
	| { ok: false; code: RunOnTestFailureCode; message: string; durationMs?: number };

function optionalString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * Read a test request from anything that may hold one (an IPC argument, a
 * bridge message), keeping only the fields a test reads. Never throws: a field
 * of the wrong type is dropped, and the test then refuses what is missing.
 */
export function parseRunOnTestRequest(value: unknown): RunOnTestRequest {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
	const record = value as Record<string, unknown>;
	const request: RunOnTestRequest = {};
	const agentId = optionalString(record.agentId);
	if (agentId) request.agentId = agentId.trim();
	if ('target' in record && record.target !== undefined) request.target = record.target;

	const raw = record.subject;
	if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
		const from = raw as Record<string, unknown>;
		const subject: Partial<RunOnTestSubject> = {};
		const toolType = optionalString(from.toolType);
		if (toolType) subject.toolType = toolType.trim();
		const cwd = optionalString(from.cwd);
		if (cwd) subject.cwd = cwd.trim();
		const customPath = optionalString(from.customPath);
		if (customPath) subject.customPath = customPath.trim();
		const customArgs = optionalString(from.customArgs);
		if (customArgs) subject.customArgs = customArgs;
		const env = from.customEnvVars;
		if (typeof env === 'object' && env !== null && !Array.isArray(env)) {
			subject.customEnvVars = Object.fromEntries(
				Object.entries(env as Record<string, unknown>).filter(
					(entry): entry is [string, string] => typeof entry[1] === 'string'
				)
			);
		}
		const ssh = from.sshRemoteConfig;
		if (typeof ssh === 'object' && ssh !== null && !Array.isArray(ssh)) {
			const config = ssh as Record<string, unknown>;
			subject.sshRemoteConfig = {
				enabled: config.enabled === true,
				remoteId: typeof config.remoteId === 'string' ? config.remoteId : null,
				...(optionalString(config.workingDirOverride)
					? { workingDirOverride: (config.workingDirOverride as string).trim() }
					: {}),
			};
		}
		request.subject = subject;
	}
	return request;
}

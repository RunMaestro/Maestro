/**
 * The per-agent Local Models gateway: one URL on an agent that sends its
 * provider traffic through an HTTP proxy (Headroom, LiteLLM, or Maestro's own).
 *
 * A gateway is reached through the provider's base-URL environment variable
 * (and, for a CLI that does not read one, a config argument as well, or an
 * entry added to the config document it reads from a variable), so "how
 * is this provider pointed at a URL" is a per-provider fact and "may Maestro do
 * it" is a per-launch decision. Both live here, pure, so the launch plan, the
 * env provenance view, the settings UI and the CLI cannot disagree about them.
 *
 * Three rules every caller inherits:
 *
 * 1. An explicit user variable wins. An agent whose own environment (its own
 *    vars, or the provider-level set when it has none) already sets the
 *    base-URL variable keeps that value, and the gateway is not applied. For
 *    a config document (OpenCode), the user's document is the base the gateway
 *    is added to, and it wins only where it names a base URL itself.
 * 2. A provider whose base-URL variable Maestro does not know is refused, never
 *    guessed. A wrong variable name is ignored by the CLI, so the agent would
 *    run direct while the UI says it is proxied. A mapping is only as good as
 *    its last check against the real CLI: Codex's variable shipped unverified
 *    and was exactly this failure until its config argument was added.
 * 3. A gateway that cannot work is a launch failure that names the gateway. It
 *    is never dropped so the turn can go to another endpoint.
 */

import { isEnvVarSet, type EnvVarMerge } from '../agentEnvironment';
import type { AgentId } from '../agentIds';
import { getAgentDisplayName } from '../agentMetadata';
import {
	OPENCODE_CONFIG_ENV_VAR,
	openCodeConfigNamesBaseUrl,
	withOpenCodeGateway,
} from './opencode-config';

/** Whether an agent's traffic can be sent through a gateway, and how. */
export type AgentGatewaySupport =
	| {
			supported: true;
			/** The base-URL variable this provider's CLI reads. */
			envVar: string;
			/**
			 * Arguments that carry the gateway, for a CLI whose variable is not
			 * enough on its own. They go BEFORE the agent's own arguments (ahead of
			 * any subcommand), which is where a CLI reads a global option.
			 */
			configArgs?: (url: string) => string[];
			/**
			 * Arguments for the provider's batch subcommand, placed right after it
			 * (`placeSubcommandArgs`). OpenCode reads `--standalone` after `run`.
			 */
			subcommandArgs?: string[];
			/**
			 * The gateway URL is the API root WITH its version (`.../v1`), which
			 * is what an SDK `baseURL` takes (OpenCode), rather than the root a
			 * CLI appends `/v1/...` to (Claude Code's `ANTHROPIC_BASE_URL`).
			 */
			urlIncludesApiVersion?: true;
			/**
			 * For a CLI that reads its base URL from a config DOCUMENT held in
			 * `envVar` (OpenCode's inline JSON), how the gateway is added to that
			 * document instead of replacing it. The launch applies `merge` to the
			 * value it would otherwise carry (Maestro's permission block, its
			 * read-only override, or the user's own document), so nothing in it
			 * is lost. Rule 1 then reads the document: it wins only when it names
			 * a base URL itself.
			 */
			configDocument?: {
				merge: (current: string | undefined, url: string) => string;
				namesBaseUrl: (document: string) => boolean;
			};
	  }
	| {
			supported: false;
			/** One sentence for the user, shown beside the disabled field. */
			reason: string;
	  };

/** The advice for a provider whose base-URL setting is not known at all. */
const IF_IT_READS_A_VARIABLE =
	"If it reads a base-URL variable, set it in this agent's environment variables.";

/**
 * Keyed by `AgentId`, so a new provider fails to compile until it is given a
 * variable or a reason. Only variables the provider's CLI is known to read are
 * listed: an unverified name would fail silently (rule 2 above).
 */
const GATEWAY_SUPPORT: Record<AgentId, AgentGatewaySupport> = {
	'claude-code': { supported: true, envVar: 'ANTHROPIC_BASE_URL' },
	// Codex needs BOTH. Measured on 2026-10-11 against Codex CLI 0.162.1 with a
	// ChatGPT login: `OPENAI_BASE_URL` alone is ignored (the turn completed with
	// the variable pointed at a closed port), so an agent with a gateway ran
	// direct while every surface said it was proxied. The config override
	// `-c openai_base_url="<url>"` at the root of the command line IS honored
	// (the same closed port then refuses every attempt). The variable is still
	// set: it is what rule 1 reads to let a user's own value win, and other
	// Codex builds and logins may read it.
	codex: {
		supported: true,
		envVar: 'OPENAI_BASE_URL',
		// The value is parsed as TOML; a JSON string literal is a valid TOML
		// basic string for any URL `parseGatewayUrl` accepts.
		configArgs: (url) => ['-c', `openai_base_url=${JSON.stringify(url)}`],
	},
	'copilot-cli': {
		supported: false,
		reason: 'Copilot CLI ignores base-URL variables, so its traffic cannot go through a gateway.',
	},
	// OpenCode reads no base-URL variable: each provider's `options.baseURL`
	// lives in its config, and `OPENCODE_CONFIG_CONTENT` is an inline config
	// merged over the user's files. Measured on 2026-11-11 against OpenCode
	// 2.2.7 (`opencode run --standalone --format json`, a throwaway HOME and a
	// fake key): with `provider.anthropic.options.baseURL` (and, separately,
	// `provider.openai.options.baseURL`) set to `http://127.0.0.1:1/v1` every
	// attempt failed with ECONNREFUSED; without it the same key reached
	// Anthropic (401). A recording listener saw `POST /v1/messages?beta=true`
	// (Anthropic) and `POST /v1/responses` (OpenAI), so the gateway URL is the
	// API root WITH `/v1`. `enabled_providers` limited to those two makes a
	// model from any other provider fail ("Model unavailable") instead of
	// running direct. `--standalone` makes the run read this launch's document:
	// without it `run` talks to a background service when one is up, and
	// whether that service honors the per-run document was not measured.
	opencode: {
		supported: true,
		envVar: OPENCODE_CONFIG_ENV_VAR,
		subcommandArgs: ['--standalone'],
		urlIncludesApiVersion: true,
		configDocument: { merge: withOpenCodeGateway, namesBaseUrl: openCodeConfigNamesBaseUrl },
	},
	// Not verified (G03.2, 2026-11-11): no `droid` binary was installed where the
	// closed-port test runs, so nothing was measured. Factory documents a
	// `baseUrl` per BYOK custom model in `~/.factory/settings.json` (legacy
	// `config.json`: `base_url`), and third-party gateway guides report that
	// `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` override it. Neither is mapped
	// until a closed port proves the CLI reads it.
	'factory-droid': notVerified(
		'factory-droid',
		'It sets a base URL per custom model in ~/.factory/settings.json: point a custom model at the gateway there.'
	),
	antigravity: unknownVariable('antigravity'),
	'gemini-cli': unknownVariable('gemini-cli'),
	'qwen3-coder': unknownVariable('qwen3-coder'),
	hermes: unknownVariable('hermes'),
	pi: unknownVariable('pi'),
	// Not verified (G03.3, 2026-11-11): no `omp` binary was installed where the
	// closed-port test runs. Its docs set a provider's `baseUrl` in
	// `~/.omp/agent/models.yml` (migrated from `models.json`), applied over the
	// built-in providers. A file under HOME is not a per-launch setting, so a
	// verified route there needs a per-launch config path before it can be mapped.
	omp: notVerified(
		'omp',
		"It sets a provider's base URL in ~/.omp/agent/models.yml: point a provider at the gateway there."
	),
	// Not verified (G03.3, 2026-11-11): no `grok` binary was installed where the
	// closed-port test runs. xAI's settings reference names
	// `GROK_XAI_API_BASE_URL` (API-key auth); community Grok CLIs read
	// `GROK_BASE_URL` / `--base-url`. Neither is mapped until a closed port
	// proves the build Maestro runs reads it.
	grok: notVerified('grok', IF_IT_READS_A_VARIABLE),
	terminal: { supported: false, reason: 'A terminal is a shell, not an agent.' },
};

/**
 * A provider whose route was looked for and not proven by the closed-port test
 * (the binary was absent, or the setting was ignored). `hint` is one sentence
 * on where the user can point it at a gateway themselves.
 */
function notVerified(agentId: AgentId, hint: string): AgentGatewaySupport {
	return {
		supported: false,
		reason: `Maestro has not verified a gateway route for ${getAgentDisplayName(agentId)}. ${hint}`,
	};
}

function unknownVariable(agentId: AgentId): AgentGatewaySupport {
	return {
		supported: false,
		reason: `Maestro does not know a base-URL variable for ${getAgentDisplayName(agentId)}. If it has one, set it in this agent's environment variables.`,
	};
}

/** Whether (and through which variable) a provider can use a gateway. */
export function agentGatewaySupport(toolType: string): AgentGatewaySupport {
	return (
		(GATEWAY_SUPPORT as Record<string, AgentGatewaySupport | undefined>)[toolType] ?? {
			supported: false,
			reason: `Maestro does not know a base-URL variable for "${toolType}".`,
		}
	);
}

export type GatewayUrlParse = { ok: true; url: string } | { ok: false; error: string };

/**
 * Validate a gateway URL and put it in the one form that is stored and
 * injected: trimmed, with no trailing slash (a provider CLI appends its own
 * `/v1/...`, and a doubled slash is a different path to most proxies).
 */
export function parseGatewayUrl(raw: string): GatewayUrlParse {
	const trimmed = raw.trim();
	if (trimmed === '') return { ok: false, error: 'The gateway URL is empty.' };
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		return {
			ok: false,
			error: `"${trimmed}" is not a URL. Use a form like http://127.0.0.1:8787.`,
		};
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		return {
			ok: false,
			error: `A gateway URL starts with http:// or https://, not ${parsed.protocol}//.`,
		};
	}
	if (parsed.hostname === '') {
		return { ok: false, error: `"${trimmed}" has no host.` };
	}
	if (parsed.search !== '' || parsed.hash !== '') {
		return {
			ok: false,
			error: 'A gateway URL is a base URL: it cannot carry a query string or a fragment.',
		};
	}
	return { ok: true, url: trimmed.replace(/\/+$/, '') };
}

/**
 * Whether a gateway URL names the machine it is resolved on. A loopback gateway
 * on this machine is unreachable from an SSH remote, where the same address
 * means the remote host.
 */
export function isLoopbackGatewayUrl(url: string): boolean {
	let hostname: string;
	try {
		hostname = new URL(url).hostname.toLowerCase();
	} catch {
		return false;
	}
	// WHATWG URL keeps the brackets on an IPv6 host.
	const host = hostname.replace(/^\[|\]$/g, '');
	if (host === 'localhost' || host.endsWith('.localhost')) return true;
	if (host === '::1' || host === '0:0:0:0:0:0:0:1' || host === '::' || host === '0.0.0.0') {
		return true;
	}
	return /^127(\.\d{1,3}){3}$/.test(host);
}

export type AgentGatewayRefusalCode =
	| 'gateway-unsupported-provider'
	| 'gateway-invalid-url'
	| 'gateway-loopback-on-remote';

export type AgentGatewayResolution =
	/** The agent has no gateway. */
	| { kind: 'none' }
	/**
	 * Set `envVars` on the agent's process (or, for a config document, apply
	 * `envVarMerges` to the value it would otherwise carry), put `args` ahead of
	 * its own arguments, and `subcommandArgs` after its batch subcommand. Each is
	 * empty when the provider does not need it.
	 */
	| {
			kind: 'inject';
			envVar: string;
			url: string;
			envVars: Record<string, string>;
			envVarMerges: Record<string, EnvVarMerge>;
			args: string[];
			subcommandArgs: string[];
	  }
	/**
	 * The agent sets the variable itself; the gateway is not applied (rule 1).
	 * `inDocument` when the variable is a config document that names a base URL.
	 */
	| { kind: 'user-override'; envVar: string; url: string; userValue: string; inDocument?: true }
	/** The launch must fail with this message (rule 3). */
	| { kind: 'refused'; code: AgentGatewayRefusalCode; message: string };

export interface AgentGatewayInput {
	/** The agent's provider, e.g. `claude-code`. */
	toolType: string;
	/** The agent's stored gateway URL. Blank or absent means no gateway. */
	gatewayUrl?: string | null;
	/**
	 * The agent's effective custom vars: its own, or the provider-level set when
	 * it has none (`effectiveAgentCustomEnvVars`). The layer rule 1 reads.
	 */
	userEnvVars?: Record<string, string>;
	/** The SSH remote the agent runs on, when it runs on one. */
	remote?: { name: string } | null;
}

/**
 * Decide what an agent's gateway does to one launch. The single answer behind
 * the launch plan, the env provenance view and the settings table.
 */
export function resolveAgentGateway(input: AgentGatewayInput): AgentGatewayResolution {
	const raw = input.gatewayUrl?.trim() ?? '';
	if (raw === '') return { kind: 'none' };

	const support = agentGatewaySupport(input.toolType);
	if (!support.supported) {
		return {
			kind: 'refused',
			code: 'gateway-unsupported-provider',
			message: `This agent has a Local Models gateway (${raw}), but ${support.reason} Clear the gateway to run the agent.`,
		};
	}

	const parsed = parseGatewayUrl(raw);
	if (!parsed.ok) {
		return {
			kind: 'refused',
			code: 'gateway-invalid-url',
			message: `This agent's Local Models gateway cannot be used: ${parsed.error}`,
		};
	}

	const userValue = input.userEnvVars?.[support.envVar];
	const userSetsUrl = support.configDocument
		? isEnvVarSet(input.userEnvVars, support.envVar) &&
			support.configDocument.namesBaseUrl(userValue as string)
		: isEnvVarSet(input.userEnvVars, support.envVar);
	if (userSetsUrl) {
		return {
			kind: 'user-override',
			envVar: support.envVar,
			url: parsed.url,
			userValue: userValue as string,
			...(support.configDocument ? { inDocument: true as const } : {}),
		};
	}

	if (input.remote && isLoopbackGatewayUrl(parsed.url)) {
		return {
			kind: 'refused',
			code: 'gateway-loopback-on-remote',
			message: `This agent's Local Models gateway (${parsed.url}) is a loopback address on this machine, which SSH remote "${input.remote.name}" cannot reach. Give the agent a gateway URL the remote host can reach, or clear the gateway.`,
		};
	}

	const document = support.configDocument;
	return {
		kind: 'inject',
		envVar: support.envVar,
		url: parsed.url,
		envVars: document ? {} : { [support.envVar]: parsed.url },
		envVarMerges: document
			? { [support.envVar]: (current) => document.merge(current, parsed.url) }
			: {},
		args: support.configArgs?.(parsed.url) ?? [],
		subcommandArgs: support.subcommandArgs ?? [],
	};
}

/**
 * The variable a gateway would set, for the env provenance view
 * (`resolveAgentEnvironment`'s `gateway` layer, which applies rule 1 itself).
 * Undefined when the agent has no usable gateway.
 */
export function gatewayEnvVarsFor(
	toolType: string,
	gatewayUrl: string | null | undefined
): Record<string, string> | undefined {
	const resolution = resolveAgentGateway({ toolType, gatewayUrl });
	if (resolution.kind !== 'inject') return undefined;
	// A config document is shown with only the gateway's part in it: the
	// launch adds that part to whatever document the agent carries.
	const merged = Object.fromEntries(
		Object.entries(resolution.envVarMerges).map(([key, merge]) => [key, merge(undefined)])
	);
	return { ...resolution.envVars, ...merged };
}

export type GatewayUrlEdit =
	/** Store this URL. */
	| { ok: true; gatewayUrl: string }
	/** Clear the agent's gateway. */
	| { ok: true; gatewayUrl: null }
	| { ok: false; error: string };

/**
 * Turn what a person typed (a field, or `--gateway-url`) into the value to
 * store. Blank and `none` clear the gateway; anything else must be a valid URL
 * for a provider that can use one. Shared by the Edit Agent field, the Local
 * Models gateway table, the CLI and the bridge handler, so none of them can
 * store a value the launch would then refuse.
 */
export function parseGatewayUrlEdit(toolType: string, raw: string): GatewayUrlEdit {
	const trimmed = raw.trim();
	if (trimmed === '' || trimmed.toLowerCase() === 'none') return { ok: true, gatewayUrl: null };
	const support = agentGatewaySupport(toolType);
	if (!support.supported) return { ok: false, error: support.reason };
	const parsed = parseGatewayUrl(trimmed);
	return parsed.ok ? { ok: true, gatewayUrl: parsed.url } : parsed;
}

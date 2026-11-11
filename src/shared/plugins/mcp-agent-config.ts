/**
 * Per-agent ephemeral MCP-config adapters (pure, bundle-safe).
 *
 * Maestro exposes registered plugin tools to a spawned agent's model by pointing
 * the agent at an MCP server it launches over stdio (`maestro-cli mcp serve`).
 * Crucially there is **no global config mutation**: each agent ingests the server
 * spec via an ephemeral, per-invocation mechanism (a CLI flag, a `-c` override, or
 * an env var pointing at a temp file we own). This module is the single source of
 * truth for how each agent is injected.
 *
 * The installed agents claude + codex were verified against the live CLIs and
 * auto-inject: claude uses `--mcp-config <json>` (additive - the user's own MCP servers stay loaded); codex has
 * `-c, --config <key=value>` overrides that also apply to `exec` (both additive /
 * isolated, so they can't disturb Maestro's existing spawn flags). opencode and
 * the remaining agents are best-guess (`verified: false`) and are NOT auto-injected
 * - the spawn wiring only injects verified strategies.
 *
 * Pure: no Node, no Electron. The caller writes `files`, merges `env`, and
 * merges `globalArgs` into the agent argv with {@link mergeMcpInjectionArgs}.
 * The caller asks {@link mcpInjectionProblem} first: an answer means no
 * injection at all for this spawn, never a partial or guessed one.
 */

import { stringify as stringifyToml } from 'smol-toml';

export type McpInjectionStrategy =
	/** claude: `--mcp-config <inline-json>` (additive, no temp file; user MCP servers preserved). */
	| 'claude-mcp-config'
	/** codex: `-c mcp_servers.<name>.*` overrides in the active subcommand scope. */
	| 'codex-config-override'
	/** opencode: `OPENCODE_CONFIG=<temp opencode.json>` with an `mcp` block. */
	| 'opencode-env-config'
	/** grok: `GROK_CONFIG_PATH=<temp config.toml>` holding one `[mcp_servers.maestro]`
	 *  table. The file is an overlay on the account's own `config.toml` (which is
	 *  never written), so the user's servers, disabled entries and policy stay as
	 *  they are; the overlay adds the Maestro bridge and nothing else. */
	| 'grok-config-overlay'
	/** Generic: write a `{ mcpServers }` temp file and (optionally) point an env
	 *  var at it. Used as a best-guess for gemini/qwen/copilot/droid-style CLIs. */
	| 'mcp-json-file';

/** The bridge invocation an agent will spawn to reach the running app. */
export interface McpServerSpec {
	/** Absolute command the agent spawns (e.g. the Electron/node binary). */
	command: string;
	/** Args to that command (e.g. [cliScript, 'mcp', 'serve', '--tab', id]). */
	args: string[];
	/** Extra env for the spawned bridge (e.g. ELECTRON_RUN_AS_NODE=1). */
	env?: Record<string, string>;
}

/** Declares how an agent ingests an ephemeral MCP server config. Lives on the
 *  agent definition so adding an agent is a data change, not new code. */
export interface McpConfigCapability {
	strategy: McpInjectionStrategy;
	/** True when the mechanism was verified against the installed CLI; false =
	 *  best-guess from docs (the spawn wiring does not auto-inject these). */
	verified: boolean;
	/** For env/file strategies: the env var the agent reads for its config path. */
	envVar?: string;
	/** For file strategies: the temp file basename to write. */
	fileName?: string;
	/**
	 * Exact reported CLI versions the native config schema is qualified on. Absent:
	 * the mechanism is not version-bound (claude, codex). Present: only a spawn whose
	 * observed version is listed may be injected, so an empty list injects nothing.
	 * A newer release is unqualified, never a member of an assumed semver range.
	 */
	qualifiedVersions?: readonly string[];
	/** For overlay strategies: the native source revision whose schema the payload follows. */
	schemaSource?: string;
	/**
	 * What proves a run that required plugin tools actually had them.
	 * `'observed'`: the host's own record of the run's bridge decides, through
	 * `pluginToolEvidenceProblem()`; a turn whose bridge never listed the tools, or
	 * listed a required tool it never executed, fails, whatever the provider says.
	 * Absent: today's semantics (pre-spawn gates, receipts read as returned) until
	 * that provider has its own evidence.
	 */
	toolEvidence?: 'observed';
}

/**
 * Why a spawn gets no MCP injection. Every one is a refusal, not a degraded
 * injection: the spawn runs without Maestro tools, and a caller that requires
 * them (the plugin runner, `--require-plugin-tools`) refuses on its own gate.
 */
export type McpInjectionProblem =
	/** No strategy is registered for this agent. */
	| 'no-strategy'
	/** The mechanism has not been verified against the installed CLI. */
	| 'unverified'
	/** The strategy is version-bound and this spawn's version is not qualified (or unknown). */
	| 'version-unqualified'
	/** The bridge reaches the app over a local socket a remote host cannot see, and an
	 *  owned temp file would land on the wrong machine. */
	| 'remote-unsupported'
	/** The effective environment already points the agent's config variable at the
	 *  user's own file; replacing it would drop their configuration. */
	| 'config-path-conflict'
	/** grok: the effective environment ungates folder trust (`GROK_FOLDER_TRUST` off),
	 *  which lets untrusted project hooks/MCP/LSP load beside the bridge. */
	| 'folder-trust-ungated'
	/** grok: a trust or compatibility-scanner variable holds a value whose meaning the
	 *  pinned source does not establish, so the effective trust cannot be stated. */
	| 'trust-setting-invalid'
	/** grok: the caller did not read the native configuration the overlay lands in
	 *  (or could not), so a disabled or shadowing entry cannot be ruled out. */
	| 'native-config-unread'
	/** grok: the user disabled a server with the bridge's name; the overlay's
	 *  `enabled = true` would undo that choice, so nothing is injected. */
	| 'server-disabled'
	/** grok: a project config defines a server with the bridge's name, which replaces
	 *  the overlay entry whole (the deepest file wins), so the bridge would not load. */
	| 'server-shadowed';

/**
 * What the caller read of the native configuration an overlay joins (grok): the
 * user config's disabled servers (`disabled_mcp_servers`, or an entry whose
 * `enabled = false`) and the server names project configs define. Read facts only,
 * never written back: disabling and project files stay the user's.
 */
export interface NativeMcpConfigFacts {
	disabledServers: readonly string[];
	projectServers: readonly string[];
}

export interface McpInjectionContext {
	/** The spawn targets an SSH remote host. */
	remote?: boolean;
	/** The CLI version observed for this exact executable, when one was observed. */
	version?: string | null;
	/** The effective spawn environment (inherited plus the agent's own variables). */
	env?: Readonly<Record<string, string | undefined>>;
	/** grok-config-overlay only: the native configuration facts; absent refuses. */
	nativeConfig?: NativeMcpConfigFacts;
}

// ============================================================================
// Grok native trust. The pinned grok-build source loads skills,
// rules, agents, MCP servers, hooks and sessions from Claude, Cursor and Codex
// compatibility scanners unless `GROK_<VENDOR>_<RESOURCE>_ENABLED` is off, and
// `GROK_FOLDER_TRUST=0` ungates (does not disable) project hooks/MCP/LSP. The
// snapshot below is what the effective environment says of each source; it is
// part of the spawn environment, so the config generation a resumed session is
// bound to moves when any source is enabled or disabled between turns.
// ============================================================================

export const GROK_COMPAT_VENDORS = ['claude', 'cursor', 'codex'] as const;
export const GROK_COMPAT_RESOURCES = [
	'skills',
	'rules',
	'agents',
	'mcps',
	'hooks',
	'sessions',
] as const;
export type GrokCompatVendor = (typeof GROK_COMPAT_VENDORS)[number];
export type GrokCompatResource = (typeof GROK_COMPAT_RESOURCES)[number];

/** `GROK_CLAUDE_SKILLS_ENABLED` and its 17 siblings. */
export function grokCompatScannerEnvName(
	vendor: GrokCompatVendor,
	resource: GrokCompatResource
): string {
	return `GROK_${vendor.toUpperCase()}_${resource.toUpperCase()}_ENABLED`;
}

export const GROK_FOLDER_TRUST_ENV = 'GROK_FOLDER_TRUST';

/**
 * One trust source as the environment states it. `native-default` means the
 * environment says nothing (blank or unset) and the native config, whose source
 * default is on, decides; it is never read as off. `invalid` is a value the
 * pinned source does not establish.
 */
export type GrokTrustCell = 'enabled' | 'disabled' | 'native-default' | 'invalid';

export interface GrokNativeTrustSnapshot {
	/** `GROK_FOLDER_TRUST`: `ungated` when it is off, else the native rule. */
	folderTrust: 'native' | 'ungated' | 'invalid';
	/** Keyed by the scanner variable name. */
	scanners: Record<string, GrokTrustCell>;
}

function grokTrustCell(value: string | undefined): GrokTrustCell {
	if (value === undefined || value.trim() === '') return 'native-default';
	switch (value.trim().toLowerCase()) {
		case '1':
		case 'true':
			return 'enabled';
		case '0':
		case 'false':
			return 'disabled';
		default:
			return 'invalid';
	}
}

/** What the effective spawn environment says of every Grok trust source. Pure. */
export function readGrokNativeTrust(
	env: Readonly<Record<string, string | undefined>> = {}
): GrokNativeTrustSnapshot {
	const scanners: Record<string, GrokTrustCell> = {};
	for (const vendor of GROK_COMPAT_VENDORS) {
		for (const resource of GROK_COMPAT_RESOURCES) {
			const name = grokCompatScannerEnvName(vendor, resource);
			scanners[name] = grokTrustCell(env[name]);
		}
	}
	const folder = grokTrustCell(env[GROK_FOLDER_TRUST_ENV]);
	return {
		folderTrust: folder === 'disabled' ? 'ungated' : folder === 'invalid' ? 'invalid' : 'native',
		scanners,
	};
}

/** The first trust problem of a snapshot, or `undefined` when the sources are stated. */
export function grokNativeTrustProblem(
	snapshot: GrokNativeTrustSnapshot
): 'folder-trust-ungated' | 'trust-setting-invalid' | undefined {
	if (snapshot.folderTrust === 'invalid') return 'trust-setting-invalid';
	if (snapshot.folderTrust === 'ungated') return 'folder-trust-ungated';
	if (Object.values(snapshot.scanners).includes('invalid')) return 'trust-setting-invalid';
	return undefined;
}

// ============================================================================
// Grok MCP server state. Authentication and handshake states are
// never tool readiness: only a server the host saw advertise tools is `ready`,
// and only one the host saw execute is `executed`. Maestro never opens a login;
// every auth state is a bounded outcome naming the native place to fix it.
// ============================================================================

export type GrokMcpServerState =
	| 'disabled'
	| 'oauth-required'
	| 'auth-pending'
	| 'auth-denied'
	| 'auth-expired'
	| 'auth-unsupported'
	| 'handshake-failed'
	| 'installed'
	| 'ready'
	| 'executed';

/** A sanitized observation of one native MCP server. */
export interface GrokMcpServerObservation {
	name: string;
	/** Effective enabled state after the user's disable list and project overrides. */
	enabled: boolean;
	/** Authentication channel; anything else is a channel Maestro cannot drive. */
	auth?: 'none' | 'bearer-token' | 'oauth' | (string & {});
	authState?: 'authorized' | 'required' | 'pending' | 'denied' | 'expired';
	handshake?: 'ok' | 'pending' | 'failed' | 'timeout';
	/** The host observed this server advertise tools to the run. */
	advertised?: boolean;
	/** The host observed an executed call (a receipt), not a provider claim. */
	executed?: boolean;
}

export interface GrokMcpServerOutcome {
	name: string;
	state: GrokMcpServerState;
	/** Tools from this server may be offered to the model this run. */
	usable: boolean;
	/** What the user does next; `null` when nothing is needed (or a disable is kept). */
	action: string | null;
	/** Maestro never starts an interactive login for a native server. */
	interactiveLogin: false;
}

const KNOWN_GROK_MCP_AUTH = new Set(['none', 'bearer-token', 'oauth']);

/** A server name safe to put in a user-facing line (bounded, plain characters). */
function displayServerName(name: string): string {
	const plain = name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64);
	return plain === '' ? '(unnamed)' : plain;
}

function grokMcpServerAction(state: GrokMcpServerState, name: string): string | null {
	const server = `MCP server "${displayServerName(name)}"`;
	const fix = "in Grok's own /mcps view (press i) for this account, then retry";
	switch (state) {
		case 'oauth-required':
			return `${server} needs OAuth authorization. Maestro does not open a login: authorize it ${fix}.`;
		case 'auth-pending':
			return `${server} authorization is still pending. Finish it ${fix}.`;
		case 'auth-denied':
			return `${server} authorization was denied. Re-authorize it ${fix}, or disable the server.`;
		case 'auth-expired':
			return `${server} authorization expired. Re-authorize it ${fix}.`;
		case 'auth-unsupported':
			return `${server} uses an authentication channel Maestro cannot drive. Configure a bearer_token_file for it, or authorize it in Grok directly, then retry.`;
		case 'handshake-failed':
			return `${server} did not complete its handshake. Check logs/mcp/${displayServerName(name)}.stderr.log under the Grok home or run grok mcp doctor.`;
		default:
			return null;
	}
}

/** Classify one native MCP server observation. Pure; never a login, never a guess. */
export function classifyGrokMcpServer(observation: GrokMcpServerObservation): GrokMcpServerOutcome {
	const state = grokMcpServerStateOf(observation);
	return {
		name: observation.name,
		state,
		usable: state === 'ready' || state === 'executed',
		action: grokMcpServerAction(state, observation.name),
		interactiveLogin: false,
	};
}

function grokMcpServerStateOf(o: GrokMcpServerObservation): GrokMcpServerState {
	// A disabled server is preserved as disabled: never started, never re-enabled.
	if (!o.enabled) return 'disabled';
	const auth = o.auth ?? 'none';
	if (!KNOWN_GROK_MCP_AUTH.has(auth)) return 'auth-unsupported';
	if (o.authState === 'denied') return 'auth-denied';
	if (o.authState === 'expired') return 'auth-expired';
	if (o.authState === 'pending') return 'auth-pending';
	if (o.authState === 'required') return 'oauth-required';
	if (auth === 'oauth' && o.authState !== 'authorized') return 'oauth-required';
	if (o.handshake === 'failed' || o.handshake === 'timeout') return 'handshake-failed';
	if (o.handshake !== 'ok' || !o.advertised) return 'installed';
	return o.executed ? 'executed' : 'ready';
}

/**
 * The one admission rule for an ephemeral MCP injection. `undefined` means the
 * caller may build and apply {@link buildMcpInjection}; any problem means it
 * must apply nothing. Pure, so the desktop, CLI and Cue boundaries share it.
 */
export function mcpInjectionProblem(
	cap: McpConfigCapability | undefined,
	ctx: McpInjectionContext = {}
): McpInjectionProblem | undefined {
	if (!cap) return 'no-strategy';
	if (!cap.verified) return 'unverified';
	if (cap.qualifiedVersions) {
		const version = ctx.version?.trim();
		if (!version || !cap.qualifiedVersions.includes(version)) return 'version-unqualified';
	}
	if (ctx.remote) return 'remote-unsupported';
	if (cap.strategy === 'grok-config-overlay' || cap.strategy === 'opencode-env-config') {
		const envVar = cap.envVar;
		const existing = envVar ? ctx.env?.[envVar] : undefined;
		if (existing !== undefined && existing.trim() !== '') return 'config-path-conflict';
	}
	if (cap.strategy === 'grok-config-overlay') {
		const trust = grokNativeTrustProblem(readGrokNativeTrust(ctx.env));
		if (trust) return trust;
		const facts = ctx.nativeConfig;
		if (!facts) return 'native-config-unread';
		if (facts.disabledServers.includes(MCP_SERVER_NAME)) return 'server-disabled';
		if (facts.projectServers.includes(MCP_SERVER_NAME)) return 'server-shadowed';
	}
	return undefined;
}

/** The ephemeral mutation to apply to one agent spawn. */
export interface McpInjection {
	/** Agent config args, positioned by {@link mergeMcpInjectionArgs}.
	 * Empty for env/file-only strategies. */
	globalArgs: string[];
	/** Env vars to merge into the agent's spawn environment. */
	env: Record<string, string>;
	/** Temp files to write (absolute paths) before spawning. */
	files: Array<{ path: string; content: string }>;
}

export interface BuildMcpInjectionOpts {
	/** Directory for any temp config files the strategy needs. */
	tmpDir: string;
	/** Path join (injected so this module stays Node-free and testable). */
	join: (...parts: string[]) => string;
}

/** Fixed server name used across every strategy's config payload. */
export const MCP_SERVER_NAME = 'maestro';

/**
 * Place the bridge config in the agent's active CLI parser scope.
 * Codex 0.159 drops root-level `-c` overrides when `exec` / `exec resume`
 * receives its own `-c` options (model effort or user custom args). Put MCP
 * overrides beside those options, before the prompt's `--` separator.
 * Claude still requires its global `--mcp-config` before the other args.
 */
export function mergeMcpInjectionArgs(
	cap: McpConfigCapability | undefined,
	agentArgs: readonly string[],
	injectionArgs: readonly string[]
): string[] {
	if (cap?.strategy !== 'codex-config-override') return [...injectionArgs, ...agentArgs];
	const separator = agentArgs.indexOf('--');
	const insertion = separator < 0 ? agentArgs.length : separator;
	return [...agentArgs.slice(0, insertion), ...injectionArgs, ...agentArgs.slice(insertion)];
}

/** `{ mcpServers: { maestro: { command, args, env? } } }` - the claude/generic shape. */
function mcpServersJson(spec: McpServerSpec): string {
	const entry: Record<string, unknown> = { command: spec.command, args: spec.args };
	if (spec.env && Object.keys(spec.env).length > 0) entry.env = spec.env;
	return JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: entry } });
}

/**
 * Build the ephemeral injection for an agent's MCP strategy. Pure and
 * deterministic given its inputs; the caller is responsible for writing `files`,
 * merging `env`, and placing `globalArgs` with `mergeMcpInjectionArgs`.
 */
export function buildMcpInjection(
	cap: McpConfigCapability,
	spec: McpServerSpec,
	opts: BuildMcpInjectionOpts
): McpInjection {
	switch (cap.strategy) {
		case 'claude-mcp-config':
			return {
				globalArgs: ['--mcp-config', mcpServersJson(spec)],
				env: {},
				files: [],
			};

		case 'codex-config-override': {
			// codex `-c key=value` parses the value as TOML. Our inputs (paths/flags)
			// have no control chars, so a JSON string literal is a valid TOML basic
			// string; this `toml` callback formats command/args/env entries.
			const toml = (s: string): string => JSON.stringify(s);
			const key = `mcp_servers.${MCP_SERVER_NAME}`;
			const globalArgs: string[] = [
				'-c',
				`${key}.command=${toml(spec.command)}`,
				'-c',
				`${key}.args=[${spec.args.map(toml).join(', ')}]`,
			];
			if (spec.env && Object.keys(spec.env).length > 0) {
				const table = Object.entries(spec.env)
					.map(([k, v]) => `${k} = ${toml(v)}`)
					.join(', ');
				globalArgs.push('-c', `${key}.env={ ${table} }`);
			}
			return { globalArgs, env: {}, files: [] };
		}

		case 'opencode-env-config': {
			const file = opts.join(opts.tmpDir, cap.fileName ?? 'opencode.json');
			const server: Record<string, unknown> = {
				type: 'local',
				command: [spec.command, ...spec.args],
				enabled: true,
			};
			if (spec.env && Object.keys(spec.env).length > 0) server.environment = spec.env;
			const content = JSON.stringify({
				$schema: 'https://opencode.ai/config.json',
				mcp: { [MCP_SERVER_NAME]: server },
			});
			return {
				globalArgs: [],
				env: { [cap.envVar ?? 'OPENCODE_CONFIG']: file },
				files: [{ path: file, content }],
			};
		}

		case 'grok-config-overlay': {
			// Schema: `[mcp_servers.<name>]` with command/args/env/enabled, as the
			// pinned source documents (`schemaSource`). TOML is serialized, never
			// templated, so paths and env values cannot break out of their strings.
			const file = opts.join(opts.tmpDir, cap.fileName ?? 'config.toml');
			const server: Record<string, unknown> = {
				command: spec.command,
				args: [...spec.args],
				enabled: true,
			};
			if (spec.env && Object.keys(spec.env).length > 0) server.env = { ...spec.env };
			const content = `${stringifyToml({ mcp_servers: { [MCP_SERVER_NAME]: server } })}\n`;
			return {
				globalArgs: [],
				env: { [cap.envVar ?? 'GROK_CONFIG_PATH']: file },
				files: [{ path: file, content }],
			};
		}

		case 'mcp-json-file': {
			const file = opts.join(opts.tmpDir, cap.fileName ?? 'mcp.json');
			return {
				globalArgs: [],
				env: cap.envVar ? { [cap.envVar]: file } : {},
				files: [{ path: file, content: mcpServersJson(spec) }],
			};
		}

		default:
			return { globalArgs: [], env: {}, files: [] };
	}
}

/**
 * MCP-config strategy per Maestro agent id. claude + codex were verified against
 * `--help` and auto-inject; the rest (incl. opencode - see its note) are
 * best-guess, flagged `verified: false`. The spawn wiring auto-injects ONLY
 * verified strategies, so a wrong/uncertain shape can never break an agent's
 * startup - it stays inert metadata until confirmed.
 *
 * Static string-keyed table -> `Record` (not a Map): membership is fixed at
 * authoring time.
 */
export const MCP_CONFIG_BY_AGENT: Record<string, McpConfigCapability> = {
	// Verified against the installed CLIs.
	'claude-code': { strategy: 'claude-mcp-config', verified: true },
	codex: { strategy: 'codex-config-override', verified: true },
	// opencode: installed, and the config strategy is written + tested - BUT Maestro
	// drives opencode in batch mode via `OPENCODE_CONFIG_CONTENT` (inline JSON that
	// sets permission/`question: deny` to stop prompt hangs). It is unconfirmed
	// whether a separate `OPENCODE_CONFIG` file MERGES with that inline content or
	// replaces it; replacing would re-enable prompts and hang the agent. Kept
	// best-guess (not auto-injected) until a live run confirms the merge.
	opencode: {
		strategy: 'opencode-env-config',
		verified: false,
		envVar: 'OPENCODE_CONFIG',
		fileName: 'maestro-opencode-mcp.json',
	},
	// Best-guess (not auto-injected): gemini/qwen read a `{ mcpServers }` settings
	// file; copilot/droid likewise expose an MCP config file. Shapes are our best
	// reading of their docs and need live verification before flipping `verified`.
	'gemini-cli': { strategy: 'mcp-json-file', verified: false, fileName: 'maestro-gemini-mcp.json' },
	'qwen3-coder': { strategy: 'mcp-json-file', verified: false, fileName: 'maestro-qwen-mcp.json' },
	'copilot-cli': {
		strategy: 'mcp-json-file',
		verified: false,
		fileName: 'maestro-copilot-mcp.json',
	},
	'factory-droid': {
		strategy: 'mcp-json-file',
		verified: false,
		fileName: 'maestro-droid-mcp.json',
	},
	// grok: the overlay shape follows the `[mcp_servers.<name>]` schema of the pinned
	// grok-build source, and `GROK_CONFIG_PATH` overlays (does not replace) the
	// account's config. No exact binary is qualified yet (parity P25/P26/S08 have no
	// supported range), so `qualifiedVersions` is empty and nothing is injected;
	// Phase 11 adds a version only with live evidence that the effective process
	// loads the overlay and advertises the bridge. A project `.grok/config.toml`
	// defining its own `maestro` server is a native precedence case to qualify then.
	grok: {
		strategy: 'grok-config-overlay',
		verified: false,
		envVar: 'GROK_CONFIG_PATH',
		fileName: 'config.toml',
		qualifiedVersions: [],
		schemaSource: 'xai-org/grok-build@2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8',
		// A required run is proven only by what the host observed of its bridge.
		toolEvidence: 'observed',
	},
	// hermes / pi: MCP support is unconfirmed. Carried as inert best-guess entries
	// (the generic `{ mcpServers }` file shape) so the map covers every shipping
	// agent id; never auto-injected while `verified: false`.
	hermes: { strategy: 'mcp-json-file', verified: false, fileName: 'maestro-hermes-mcp.json' },
	pi: { strategy: 'mcp-json-file', verified: false, fileName: 'maestro-pi-mcp.json' },
};

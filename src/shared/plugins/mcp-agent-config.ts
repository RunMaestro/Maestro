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
 * The installed agents' strategies were verified against the live CLIs
 * (`claude/codex/opencode --help`): claude has `--mcp-config <json>` +
 * `--strict-mcp-config`; codex has `-c, --config <key=value>` overrides that also
 * apply to `exec`; opencode reads a config file pointed at by `OPENCODE_CONFIG`.
 * Other agents are best-guess from public docs and flagged `verified: false` - the
 * spawn wiring only auto-injects verified strategies.
 *
 * Pure: no Node, no Electron. The caller writes `files`, merges `env`, and
 * prepends `globalArgs` to the agent argv.
 */

export type McpInjectionStrategy =
	/** claude: `--mcp-config <inline-json>` + `--strict-mcp-config` (no temp file). */
	| 'claude-mcp-config'
	/** codex: `-c mcp_servers.<name>.*` overrides, placed before the subcommand. */
	| 'codex-config-override'
	/** opencode: `OPENCODE_CONFIG=<temp opencode.json>` with an `mcp` block. */
	| 'opencode-env-config'
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
}

/** The ephemeral mutation to apply to one agent spawn. */
export interface McpInjection {
	/** Args inserted at the FRONT of the agent argv (global flags, before any
	 *  subcommand like codex's `exec`). Empty for env/file-only strategies. */
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

/** `{ mcpServers: { maestro: { command, args, env? } } }` - the claude/generic shape. */
function mcpServersJson(spec: McpServerSpec): string {
	const entry: Record<string, unknown> = { command: spec.command, args: spec.args };
	if (spec.env && Object.keys(spec.env).length > 0) entry.env = spec.env;
	return JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: entry } });
}

/**
 * Build the ephemeral injection for an agent's MCP strategy. Pure and
 * deterministic given its inputs; the caller is responsible for writing `files`,
 * merging `env`, and prepending `globalArgs`.
 */
export function buildMcpInjection(
	cap: McpConfigCapability,
	spec: McpServerSpec,
	opts: BuildMcpInjectionOpts
): McpInjection {
	switch (cap.strategy) {
		case 'claude-mcp-config':
			return {
				globalArgs: ['--mcp-config', mcpServersJson(spec), '--strict-mcp-config'],
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
 * MCP-config strategy per Maestro agent id. The installed CLIs
 * (claude/codex/opencode) were verified against `--help`; the rest are
 * best-guess from public docs and flagged `verified: false`. The spawn wiring
 * auto-injects ONLY verified strategies, so a wrong best-guess shape can never
 * break an unverified agent's startup - it stays inert metadata until confirmed.
 *
 * Static string-keyed table -> `Record` (not a Map): membership is fixed at
 * authoring time.
 */
export const MCP_CONFIG_BY_AGENT: Record<string, McpConfigCapability> = {
	// Verified against the installed CLIs.
	'claude-code': { strategy: 'claude-mcp-config', verified: true },
	codex: { strategy: 'codex-config-override', verified: true },
	opencode: {
		strategy: 'opencode-env-config',
		verified: true,
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
	// hermes / pi: MCP support is unconfirmed. Carried as inert best-guess entries
	// (the generic `{ mcpServers }` file shape) so the map covers every shipping
	// agent id; never auto-injected while `verified: false`.
	hermes: { strategy: 'mcp-json-file', verified: false, fileName: 'maestro-hermes-mcp.json' },
	pi: { strategy: 'mcp-json-file', verified: false, fileName: 'maestro-pi-mcp.json' },
};

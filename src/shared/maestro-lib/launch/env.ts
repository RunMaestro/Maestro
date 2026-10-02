import * as os from 'os';
import * as path from 'path';
import { buildExpandedPath, detectNodeVersionManagerBinPaths } from '../../pathUtils';
import { isWindows } from '../../platformDetection';
import { DEFAULT_QUERY_SOURCE, QUERY_SOURCE_ENV_VAR, type QuerySource } from '../../querySource';
import { buildSpawnPath, STANDARD_UNIX_PATHS } from './spawn-path';
import { isBlankEnvKey, isBlankEnvValue } from '../../agentEnvironment';
import { CALLER_AGENT_ID_ENV_VAR, CALLER_TAB_ID_ENV_VAR } from '../../agentDelegation';
import { PROVIDER_ENV_VAR_SUGGESTIONS } from '../../envVarCatalog';

/**
 * Build the base PATH for macOS/Linux with detected Node version manager paths.
 *
 * Automatically detects and prepends paths for common Node version managers (nvm, fnm, etc.)
 * to ensure Node tools are discoverable in PATH. This is critical for agents and tools that
 * depend on specific Node versions.
 *
 * @returns {string} The expanded PATH value with version manager paths first, then standard paths
 *
 * @example
 * // Returns something like:
 * // /Users/john/.nvm/versions/node/v20.11.0/bin:/usr/local/bin:/usr/bin:/bin
 */
export function buildUnixBasePath(): string {
	const versionManagerPaths = detectNodeVersionManagerBinPaths();

	if (versionManagerPaths.length > 0) {
		return versionManagerPaths.join(':') + ':' + STANDARD_UNIX_PATHS;
	}

	return STANDARD_UNIX_PATHS;
}

/**
 * Build environment for PTY terminal sessions.
 *
 * This function creates the environment for terminal sessions (PTY-based shells). It preserves
 * most of the parent process environment but ensures consistent terminal settings.
 *
 * Platform-specific behavior:
 * - **Windows**: Inherits full parent environment + TERM setting
 * - **Unix/Linux/macOS**: Inherits full parent environment with Electron/IDE variables stripped,
 *   TERM forced to xterm-256color, and an expanded PATH that includes Node version manager paths
 *
 * @param {Record<string, string>} [shellEnvVars] - Optional custom environment variables to merge.
 *        These override process defaults. Supports `~/` path expansion (e.g., `~/workspace`).
 *
 * @returns {NodeJS.ProcessEnv} The complete environment object for the PTY session
 *
 * @example
 * // Basic usage with no custom variables
 * const env = buildPtyTerminalEnv();
 * spawn('bash', { env });
 *
 * @example
 * // With global environment variables from Settings
 * const globalEnvVars = {
 *   'ANTHROPIC_API_KEY': 'sk-proj-xxxxx',
 *   'DEBUG': 'maestro:*',
 *   'WORKSPACE': '~/projects'
 * };
 * const env = buildPtyTerminalEnv(globalEnvVars);
 * // WORKSPACE will expand to /Users/john/projects (with path expansion)
 *
 * @note Path expansion (`~/` → home directory) is applied to all values
 * @note On Windows, the full environment is inherited without stripping. On Unix/Linux/macOS,
 *       Electron/IDE variables listed in STRIPPED_ENV_VARS are removed to avoid shell/plugin issues.
 */
export function buildPtyTerminalEnv(shellEnvVars?: Record<string, string>): NodeJS.ProcessEnv {
	let env: NodeJS.ProcessEnv;

	if (isWindows()) {
		env = {
			...process.env,
			TERM: 'xterm-256color',
		};
	} else {
		// Use the full expanded PATH so common user install locations
		// (~/.local/bin, ~/.claude/local, ~/.opencode/bin, Homebrew, npm-global, etc.)
		// are available even when the user's shell doesn't source an rc file that
		// augments PATH. bash falls through to .bashrc for login+interactive on
		// Debian, but zsh only sources .zprofile/.zshrc if they exist - users
		// without those would otherwise see `command not found` for tools like
		// `claude` and `codex` that live in ~/.local/bin.
		// Use buildSpawnPath() so the user's cached login-shell PATH is also
		// included - covers custom node/python installs outside the standard
		// version-manager paths we hardcode in buildExpandedPath().
		env = {
			...process.env,
			TERM: 'xterm-256color',
			LANG: process.env.LANG || 'en_US.UTF-8',
			PATH: buildSpawnPath(),
		};
		for (const key of STRIPPED_ENV_VARS) {
			delete env[key];
		}
	}

	// A Command Terminal is a shell the USER drives, not an agent turn, so it
	// must never carry the query-source marker. It can arrive two ways: Maestro
	// itself launched from an agent shell that had it set (the normal case in
	// development), or the Windows branch above, which inherits process.env
	// wholesale and strips nothing. Deleted unconditionally rather than added to
	// STRIPPED_ENV_VARS, because buildChildProcessEnv() sets this variable on
	// purpose and must keep doing so.
	delete env[QUERY_SOURCE_ENV_VAR];
	// Same for the caller identity: a dispatch typed into a terminal is the user's,
	// and attributing it to whichever agent launched Maestro would be a lie.
	delete env[CALLER_AGENT_ID_ENV_VAR];
	delete env[CALLER_TAB_ID_ENV_VAR];

	// Vim arrow-key ergonomics: when users launch `vi`/`vim` with distro defaults
	// that force compatible mode, insert-mode arrows can degrade to literal ABCD.
	// Provide a safe default for terminal sessions, but never override explicit user config.
	if (!env.VIMINIT) {
		env.VIMINIT = process.env.VIMINIT || 'set nocompatible | set esckeys';
	}

	// Apply custom shell environment variables
	if (shellEnvVars && Object.keys(shellEnvVars).length > 0) {
		const homeDir = os.homedir();
		for (const [key, value] of Object.entries(shellEnvVars)) {
			env[key] = value.startsWith('~/') ? path.join(homeDir, value.slice(2)) : value;
		}
	}

	return env;
}

/**
 * Environment variables to strip from child processes (agents).
 * These are set by Electron or IDE extensions and can interfere with agent
 * authentication or behavior when inherited by spawned CLI tools.
 *
 * Rationale:
 * - **ELECTRON_\***: Electron internals that may cause Electron-based CLIs to
 *   misidentify their execution context (e.g., Claude Code CLI thinking it's
 *   running inside Electron instead of standalone)
 * - **CLAUDECODE** and related: VSCode extension markers that can cause agents
 *   to use IDE-specific credentials or API endpoints instead of their configured ones
 * - **NODE_ENV**: Maestro's own NODE_ENV should not leak to agent processes,
 *   which may have different NODE_ENV requirements (e.g., agent needs NODE_ENV=production)
 *
 * @see buildChildProcessEnv() for where these are applied
 */
const STRIPPED_ENV_VARS = [
	// Electron internals - can cause Electron-based CLIs (e.g. Claude Code) to
	// misidentify their execution context
	'ELECTRON_RUN_AS_NODE',
	'ELECTRON_NO_ASAR',
	'ELECTRON_EXTRA_LAUNCH_ARGS',
	// VSCode / Claude Code extension markers - when inherited, agents may use
	// IDE-specific credentials or API paths instead of their own CLI auth
	'CLAUDECODE',
	'CLAUDE_CODE_ENTRYPOINT',
	'CLAUDE_AGENT_SDK_VERSION',
	'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING',
	// Claude session-identity markers. If Maestro itself was launched from
	// within a Claude session (e.g. `claude` spawned the app, or a dev shell
	// inherited them), these leak into spawned claude-code turns and the
	// maestro-p TUI it drives, making that child claude run as a NESTED session
	// that never writes its own JSONL transcript. maestro-p reads only the
	// JSONL, so the run times out with an empty result and no History entry is
	// recorded. Strip them here so no spawn surface forwards them; maestro-p
	// also strips them itself as a second line of defense.
	'CLAUDE_CODE_SESSION_ID',
	'CLAUDE_CODE_CHILD_SESSION',
	// Caller identity inherited from whatever launched Maestro (an agent shell, in
	// development). The real identity is re-applied from the session layer, which
	// is merged after this list is stripped, so only a stale inherited copy dies.
	CALLER_AGENT_ID_ENV_VAR,
	CALLER_TAB_ID_ENV_VAR,
	// Maestro's own NODE_ENV should not leak to agents
	'NODE_ENV',
];

/**
 * Build environment for child process (non-PTY) spawning - typically for AI agents.
 *
 * This is the core function for setting up environments for spawned AI agents (Claude Code,
 * Codex, Factory Droid, etc.) and other child processes. It implements a strict precedence
 * order and safety measures to prevent agent authentication failures.
 *
 * **Environment Precedence (highest to lowest)**:
 * 1. **Session-level custom env vars** (from spawn request, highest priority)
 *    - Set per-session in the spawn config
 *    - Intended for temporary overrides
 *    - Example: Override API_KEY for a specific test session
 *
 * 2. **Global shell env vars** (from Settings → General → Shell Configuration)
 *    - Set once by user, applies to all agents and terminals
 *    - Persisted in electron-store
 *    - Example: ANTHROPIC_API_KEY, PROXY_URL
 *
 * 3. **Process environment** (with Electron/IDE vars stripped, lowest priority)
 *    - Parent process environment as baseline
 *    - Problematic vars removed to prevent auth failures
 *
 * **Safety Features**:
 * - Strips Electron internals (ELECTRON_RUN_AS_NODE, etc.)
 * - Strips IDE markers (CLAUDECODE, etc.)
 * - Strips Maestro's NODE_ENV to avoid conflicts
 * - Applies path expansion for `~/` syntax
 * - Sets MAESTRO_SESSION_RESUMED flag when resuming sessions
 *
 * @param {Record<string, string>} [customEnvVars] - Session-level environment variables that
 *        override global and defaults. These are typically set per-spawn for session-specific
 *        needs. Supports `~/` path expansion. Optional - if not provided, only global vars are used.
 *
 * @param {boolean} [isResuming] - Whether this process is being resumed (vs. fresh spawn).
 *        When true, sets MAESTRO_SESSION_RESUMED=1 in environment so agents can detect resumption.
 *        Optional, defaults to false.
 *
 * @param {Record<string, string>} [globalShellEnvVars] - Global environment variables from
 *        Settings that should apply to all agents. These come from Settings → General → Shell
 *        Configuration. Supports `~/` path expansion. Optional - if not provided, no global
 *        vars are applied.
 *
 * @returns {NodeJS.ProcessEnv} The complete environment object ready to pass to spawn/exec.
 *          Includes all three levels of vars merged with correct precedence.
 *
 * @example
 * // Spawn agent with only global vars (typical use)
 * const globalVars = {
 *   'ANTHROPIC_API_KEY': 'sk-proj-xxxxx',
 *   'DEBUG': 'maestro:*'
 * };
 * const env = buildChildProcessEnv(undefined, false, globalVars);
 * spawn('claude-code', [], { env });
 *
 * @example
 * // Spawn agent with session override of global var
 * const sessionVars = { 'DEBUG': 'off' };  // Override global DEBUG setting
 * const env = buildChildProcessEnv(sessionVars, false, globalVars);
 * // Result: ANTHROPIC_API_KEY from global, DEBUG='off' from session (session wins)
 *
 * @example
 * // Spawn agent on resume with session-specific tracking
 * const env = buildChildProcessEnv(undefined, true, globalVars);
 * // Sets MAESTRO_SESSION_RESUMED=1 so agent knows session was resumed
 *
 * @note Path expansion is applied to all values at all levels (e.g., ~/workspace → /home/user/workspace)
 * @note Variables at higher precedence levels completely replace lower levels (no merging for same key)
 * @note Electron/IDE variables are stripped FIRST before any merging, ensuring they never appear
 *
 * @see STRIPPED_ENV_VARS - List of variables that are always removed
 * @see buildPtyTerminalEnv() - Similar function for PTY terminal environments
 */
/**
 * Collect the environment variables that Maestro is explicitly setting on a
 * spawned process, in the same precedence order as the build* helpers below
 * (global → session-level, with session overriding global). The MAESTRO_SESSION_RESUMED
 * marker is included when applicable. Inherited system env vars are deliberately
 * excluded - this is the set the user can act on (Settings → Shell Configuration
 * and per-agent / per-session overrides), surfaced in the Process Details modal.
 *
 * Applies `~/` path expansion the same way the build helpers do.
 */
export function collectMaestroEnvVars(
	globalShellEnvVars?: Record<string, string>,
	customEnvVars?: Record<string, string>,
	isResuming?: boolean,
	querySource?: QuerySource
): Record<string, string> {
	const home = os.homedir();
	const expand = (value: string): string =>
		value.startsWith('~/') ? path.join(home, value.slice(2)) : value;
	const result: Record<string, string> = {};
	// Merge first, strip blanks second: a blank at the session layer has to be
	// able to cancel a value set globally, which it cannot do if it is dropped
	// before the merge. See stripBlankEnvVars() for why blanks are not exported.
	const merged: Record<string, string> = {
		...(globalShellEnvVars || {}),
		...(customEnvVars || {}),
	};
	for (const [key, value] of Object.entries(merged)) {
		// An unnamed row is a half-finished editor entry, not a variable.
		if (isBlankEnvKey(key) || isBlankEnvValue(value)) continue;
		result[key] = expand(value);
	}
	if (isResuming) {
		result.MAESTRO_SESSION_RESUMED = '1';
	}
	// Only present when the caller resolved one. Terminal PTYs build their env
	// through buildPtyTerminalEnv(), which does not stamp the marker, and this
	// list is meant to mirror what the process actually got - not to advertise a
	// variable the user would then fail to find.
	if (querySource) {
		result[QUERY_SOURCE_ENV_VAR] = querySource;
	}
	return result;
}

export function buildChildProcessEnv(
	customEnvVars?: Record<string, string>,
	isResuming?: boolean,
	globalShellEnvVars?: Record<string, string>,
	extraPathDirs?: string[],
	querySource?: QuerySource
): NodeJS.ProcessEnv {
	const env = { ...process.env };

	// Strip environment variables that could interfere with agent behaviour.
	// Electron and IDE extension vars can cause agents to misidentify their
	// execution context, leading to auth failures or incorrect API paths.
	for (const key of STRIPPED_ENV_VARS) {
		delete env[key];
	}

	// Build PATH that merges Maestro's hardcoded paths with the user's cached
	// login-shell PATH and any caller-supplied dirs (typically the parent dir
	// of the detected agent binary, so its shebang's interpreter resolves).
	env.PATH = buildSpawnPath(extraPathDirs);

	// Never let a Maestro-spawned agent hijack the user's browser. When an
	// interactive claude (the maestro-p TUI) finds its OAuth token needs a
	// refresh, its URL opener execs `$BROWSER <authorize-url>` - and if BROWSER
	// is unset it falls back to the OS default opener - popping a real browser
	// tab mid-turn even though the turn itself still succeeds on the current
	// access token. Force BROWSER to a no-op so that self-heal can never open a
	// tab; a genuinely dead token then surfaces as Maestro's normal auth-expired
	// error instead. Set BEFORE the global/session loops so a user who *wants*
	// an explicit BROWSER (Settings → Shell Configuration or a per-session
	// override) still wins. Mirrors the guard in claude-usage-sampler.ts; a
	// value that can't be exec'd (e.g. on Windows) still fails closed = no tab.
	env.BROWSER = '/usr/bin/true';

	if (isResuming) {
		env.MAESTRO_SESSION_RESUMED = '1';
	} else {
		delete env.MAESTRO_SESSION_RESUMED;
	}

	// Apply the user-editable layers: global shell vars first, then session-level
	// overrides on top. Merged before they are applied so a blank session value
	// can cancel a global one instead of being overwritten by it.
	applyEnvRecord(env, {
		...(globalShellEnvVars || {}),
		...(customEnvVars || {}),
	});

	// Who asked for this turn. Stamped after the user-editable layers rather than
	// before them: this is Maestro stating a fact about the spawn, not a default
	// the user is offering an opinion on, and a stray global var of the same name
	// would otherwise silently mislabel every turn on the machine.
	env[QUERY_SOURCE_ENV_VAR] = querySource ?? DEFAULT_QUERY_SOURCE;

	return env;
}

/**
 * Write a merged env record onto a process env. `~/` values are expanded; a
 * blank value REMOVES the variable, inherited value included, because blank
 * means "do not set this" (exporting `FOO=` is what made a blank
 * CLAUDE_CONFIG_DIR crash the agent inside `mkdir('')`); and an unnamed row is
 * a half-finished editor entry, so it neither sets nor cancels anything.
 */
function applyEnvRecord(env: NodeJS.ProcessEnv, record: Record<string, string>): void {
	const home = os.homedir();
	for (const [key, value] of Object.entries(record)) {
		if (isBlankEnvKey(key)) continue;
		if (isBlankEnvValue(value)) {
			delete env[key];
			continue;
		}
		env[key] = value.startsWith('~/') ? path.join(home, value.slice(2)) : value;
	}
}

/**
 * Which surface is launching the agent.
 *
 * Desktop chat, the CLI and Cue have each layered an agent's environment their
 * own way since before this library existed, and they do not agree. The
 * builders below reproduce each surface exactly as it was. A shared function is
 * not licence to change what any of them does: making the three agree is a
 * product change, to be proposed and accepted on its own.
 *
 * | Surface   | Inherited env                    | Provider defaults            | Global Settings vars       |
 * | --------- | -------------------------------- | ---------------------------- | -------------------------- |
 * | `desktop` | Electron and IDE vars stripped   | over the inherited value     | BELOW the provider defaults |
 * | `cli`     | as inherited                     | only where the shell set none | not applied                |
 * | `cue`     | as inherited                     | over the inherited value     | not applied                |
 */
export type AgentEnvSurface = 'desktop' | 'cli' | 'cue';

/**
 * The configurable sources of an agent's environment, each named for where it
 * is set.
 */
export interface AgentEnvLayers {
	/** The provider definition's `defaultEnvVars`: what Maestro needs by default. */
	defaultEnvVars?: Record<string, string>;
	/**
	 * The provider definition's `batchModeEnvVars`. Only the CLI's batch spawns
	 * pass these; they sit with the defaults, just above them.
	 */
	batchModeEnvVars?: Record<string, string>;
	/**
	 * Settings -> Environment. Desktop only: it is applied to the local process
	 * BENEATH the provider defaults. It is not in `resolveAgentEnvVars()`, but
	 * desktop's SSH wrapper (`wrap-spawn-for-ssh.ts`) still merges it beneath
	 * that record into the remote environment, as `rc` does. The CLI and Cue do
	 * not apply it.
	 */
	globalShellEnvVars?: Record<string, string>;
	/** Settings -> Agents, per provider. */
	agentCustomEnvVars?: Record<string, string>;
	/**
	 * This agent's own vars. When present (even empty) they REPLACE
	 * `agentCustomEnvVars` rather than layering over them, the rule
	 * `effectiveAgentCustomEnvVars` and `resolveAgentEnvironment` share, so usage
	 * attribution describes the process that actually runs.
	 */
	sessionCustomEnvVars?: Record<string, string>;
	/**
	 * The provider's `readOnlyEnvOverrides`, passed only for a read-only turn.
	 * Applied over everything the user set: read-only enforcement must not be
	 * undone by a per-agent var.
	 */
	readOnlyEnvOverrides?: Record<string, string>;
}

/**
 * Merge the layers Maestro sets on an agent into one record, lowest precedence
 * first:
 *
 *   defaultEnvVars < batchModeEnvVars
 *     < (sessionCustomEnvVars ?? agentCustomEnvVars) < readOnlyEnvOverrides
 *
 * The same on every surface. This is the record that crosses to an SSH remote,
 * where `process.env` does not exist, and the one Process Details shows. The
 * global Settings vars are NOT in it: on desktop they sit beneath this record.
 * They are not kept off the remote, though: desktop's SSH wrapper
 * (`wrap-spawn-for-ssh.ts`) merges them beneath this record into the remote
 * environment, as `rc` does. Keeping them local, since a path that names a
 * directory here names nothing there, would be a behavior change of its own.
 * Returns undefined when no layer sets anything.
 */
export function resolveAgentEnvVars(layers: AgentEnvLayers): Record<string, string> | undefined {
	const userEnvVars = layers.sessionCustomEnvVars ?? layers.agentCustomEnvVars;
	const merged: Record<string, string> = {
		...(layers.defaultEnvVars ?? {}),
		...(layers.batchModeEnvVars ?? {}),
		...(userEnvVars ?? {}),
		...(layers.readOnlyEnvOverrides ?? {}),
	};
	for (const key of Object.keys(merged)) {
		if (isBlankEnvKey(key)) delete merged[key];
	}
	return Object.keys(merged).length > 0 ? merged : undefined;
}

/** Everything `buildAgentEnvironment` needs beyond the layers. */
export interface BuildAgentEnvironmentOptions extends AgentEnvLayers {
	/** Whose rules to build the environment by. */
	surface: AgentEnvSurface;
	/**
	 * Vars Maestro states about this spawn (caller identity, an MCP bridge, the
	 * acting web user). Applied over every user layer: they are facts, not
	 * preferences.
	 */
	maestroEnvVars?: Record<string, string>;
	/** Desktop and CLI: stamps MAESTRO_SESSION_RESUMED=1 (Cue runs are never resumed). */
	isResuming?: boolean;
	/** Who asked for this turn; stamped last. Defaults to `user`. */
	querySource?: QuerySource;
	/** Desktop only: directories to put in front of PATH. */
	extraPathDirs?: string[];
	/**
	 * Cue only: inherit just the allowlisted part of `process.env` (see
	 * {@link filterServerProcessEnv}). Also on when `MAESTRO_SERVER_MODE=1`.
	 */
	isServerMode?: boolean;
}

/**
 * The complete environment for a LOCAL agent process, by the rules of the
 * surface that launches it (see {@link AgentEnvSurface}).
 */
export function buildAgentEnvironment(options: BuildAgentEnvironmentOptions): NodeJS.ProcessEnv {
	switch (options.surface) {
		case 'cli':
			return buildCliAgentEnvironment(options);
		case 'cue':
			return buildCueAgentEnvironment(options);
		default:
			return buildDesktopAgentEnvironment(options);
	}
}

/**
 * Desktop chat:
 *
 *   process.env < globalShellEnvVars < defaultEnvVars
 *     < (sessionCustomEnvVars ?? agentCustomEnvVars) < readOnlyEnvOverrides
 *     < maestroEnvVars < MAESTRO_QUERY_SOURCE
 *
 * `process.env` is inherited with the Electron/IDE/caller-identity vars in
 * `STRIPPED_ENV_VARS` removed, PATH rebuilt, and BROWSER disarmed (see
 * `buildChildProcessEnv`). A blank value unsets the variable and `~/` expands.
 */
function buildDesktopAgentEnvironment(options: BuildAgentEnvironmentOptions): NodeJS.ProcessEnv {
	const record = {
		...(resolveAgentEnvVars(options) ?? {}),
		...(options.maestroEnvVars ?? {}),
	};
	return buildChildProcessEnv(
		record,
		options.isResuming,
		options.globalShellEnvVars,
		options.extraPathDirs,
		options.querySource
	);
}

/**
 * The CLI (`maestro-cli send`, Auto Run, playbooks):
 *
 *   defaultEnvVars and batchModeEnvVars fill only what the shell has NOT set
 *     < (sessionCustomEnvVars ?? agentCustomEnvVars) < readOnlyEnvOverrides
 *     < maestroEnvVars < MAESTRO_QUERY_SOURCE
 *
 * The shell wins over the provider defaults, so a value exported in the shell
 * that runs the command survives; the user's own vars override it, because the
 * user explicitly opted into them. `process.env` is inherited as it is, with
 * PATH expanded. Values are written as given: no `~/` expansion, and a blank
 * value is exported blank. MAESTRO_SESSION_RESUMED is set for a resumed turn
 * and cleared otherwise, as on desktop, so a marker inherited from the shell
 * that ran the command never reaches a fresh turn.
 */
function buildCliAgentEnvironment(options: BuildAgentEnvironmentOptions): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	env.PATH = buildExpandedPath();
	if (options.isResuming) {
		env.MAESTRO_SESSION_RESUMED = '1';
	} else {
		delete env.MAESTRO_SESSION_RESUMED;
	}

	// Merged first so a batch-mode value beats a default for the same key, then
	// applied only to slots the shell left empty.
	const defaults = { ...(options.defaultEnvVars ?? {}), ...(options.batchModeEnvVars ?? {}) };
	for (const [key, value] of Object.entries(defaults)) {
		if (!env[key]) env[key] = value;
	}
	Object.assign(env, options.sessionCustomEnvVars ?? options.agentCustomEnvVars ?? {});
	Object.assign(env, options.readOnlyEnvOverrides ?? {});
	Object.assign(env, options.maestroEnvVars ?? {});
	env[QUERY_SOURCE_ENV_VAR] = options.querySource ?? DEFAULT_QUERY_SOURCE;
	return env;
}

/**
 * Cue:
 *
 *   process.env < defaultEnvVars < (sessionCustomEnvVars ?? agentCustomEnvVars)
 *     < readOnlyEnvOverrides < maestroEnvVars < MAESTRO_QUERY_SOURCE
 *
 * `process.env` is inherited as it is, with PATH rebuilt the way the desktop
 * agent spawn rebuilds it (a Dock or Finder launch hands Maestro launchd's bare
 * PATH, which hides Homebrew and other user installs). Values are written as
 * given.
 *
 * In server mode the inherited layer is cut down to an allowlist first (see
 * {@link filterServerProcessEnv}); every layer above it is applied unchanged.
 */
function buildCueAgentEnvironment(options: BuildAgentEnvironmentOptions): NodeJS.ProcessEnv {
	const inherited = isServerModeActive(options.isServerMode)
		? filterServerProcessEnv(process.env)
		: process.env;
	return {
		...inherited,
		PATH: buildSpawnPath(options.extraPathDirs),
		...(resolveAgentEnvVars(options) ?? {}),
		...(options.maestroEnvVars ?? {}),
		[QUERY_SOURCE_ENV_VAR]: options.querySource ?? DEFAULT_QUERY_SOURCE,
	};
}

// ─── Server mode ─────────────────────────────────────────────────────────────

/** Set to `1` to run Cue with the server-mode environment allowlist. */
export const SERVER_MODE_ENV_VAR = 'MAESTRO_SERVER_MODE';
/** Comma-separated extra variable names an operator lets through in server mode. */
export const SERVER_ENV_ALLOW_ENV_VAR = 'MAESTRO_SERVER_ENV_ALLOW';

/**
 * Whether server mode is on: the caller said so, or the operator set
 * `MAESTRO_SERVER_MODE=1`. Never inferred from the runner kind - a standalone
 * engine on a laptop is the user's own shell environment and keeps all of it.
 */
export function isServerModeActive(isServerMode?: boolean): boolean {
	return isServerMode === true || process.env[SERVER_MODE_ENV_VAR] === '1';
}

/** Exact names a server-mode child inherits. Compared case-insensitively. */
const SERVER_ENV_ALLOWED_NAMES: readonly string[] = [
	// Essential system variables.
	'PATH',
	'HOME',
	'USER',
	'LOGNAME',
	'SHELL',
	'LANG',
	'TERM',
	'TMPDIR',
	// Windows equivalents, without which a child cannot find its own runtime.
	'SYSTEMROOT',
	'COMSPEC',
	'PATHEXT',
	'USERPROFILE',
	'APPDATA',
	'LOCALAPPDATA',
	'TEMP',
	'TMP',
	// Network proxy and TLS trust.
	'HTTP_PROXY',
	'HTTPS_PROXY',
	'ALL_PROXY',
	'NO_PROXY',
	'SSL_CERT_FILE',
	'SSL_CERT_DIR',
	'NODE_EXTRA_CA_CERTS',
	'REQUESTS_CA_BUNDLE',
	// Common dev toolchains.
	'NVM_DIR',
	'JAVA_HOME',
	'GOPATH',
	'CARGO_HOME',
	'PYTHONPATH',
	'DENO_INSTALL_ROOT',
];

/** Name prefixes a server-mode child inherits. */
const SERVER_ENV_ALLOWED_PREFIXES: readonly string[] = ['LC_', 'XDG_', 'SSH_', 'MAESTRO_'];

/**
 * `MAESTRO_*` names that are NOT inherited even though the prefix is: the
 * caller identity and the query source describe whoever launched THIS
 * process, and the Cue spawn restates both itself (see `STRIPPED_ENV_VARS`).
 */
const SERVER_ENV_DENIED_NAMES: readonly string[] = [
	CALLER_AGENT_ID_ENV_VAR,
	CALLER_TAB_ID_ENV_VAR,
	QUERY_SOURCE_ENV_VAR,
];

/** Every provider credential and account-dir name the env catalog knows. */
const PROVIDER_ENV_NAMES: readonly string[] = Object.values(PROVIDER_ENV_VAR_SUGGESTIONS).flatMap(
	(entries) => entries.map((entry) => entry.key)
);

function operatorAllowedNames(): string[] {
	const raw = process.env[SERVER_ENV_ALLOW_ENV_VAR];
	if (!raw) return [];
	return raw
		.split(',')
		.map((name) => name.trim())
		.filter((name) => name !== '');
}

/**
 * The part of an inherited environment a server-mode child may see.
 *
 * On a shared server the engine's own environment holds secrets meant for the
 * engine alone (the 0DIN token, webhook secrets resolved through
 * `secret_env`, deploy credentials), and an agent prompted by third-party text
 * must not be able to read them back out. So this is an ALLOWLIST, never a
 * blocklist: anything not named here is dropped, and an operator who needs
 * more names them in `MAESTRO_SERVER_ENV_ALLOW`.
 *
 * Names are compared case-insensitively: Windows treats them that way, and
 * the lowercase proxy spellings (`https_proxy`) are the ones curl reads.
 */
export function filterServerProcessEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const allowed = new Set(
		[...SERVER_ENV_ALLOWED_NAMES, ...PROVIDER_ENV_NAMES, ...operatorAllowedNames()].map((name) =>
			name.toUpperCase()
		)
	);
	const denied = new Set(SERVER_ENV_DENIED_NAMES.map((name) => name.toUpperCase()));

	const filtered: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(env)) {
		const upper = key.toUpperCase();
		if (denied.has(upper)) continue;
		if (allowed.has(upper) || SERVER_ENV_ALLOWED_PREFIXES.some((p) => upper.startsWith(p))) {
			filtered[key] = value;
		}
	}
	return filtered;
}

import * as os from 'os';
import * as path from 'path';
import { STANDARD_UNIX_PATHS } from '../constants';
import { detectNodeVersionManagerBinPaths } from '../../../shared/pathUtils';
import { isWindows } from '../../../shared/platformDetection';
import { buildSpawnPath } from '../../utils/spawnPath';

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
	isResuming?: boolean
): Record<string, string> {
	const home = os.homedir();
	const expand = (value: string): string =>
		value.startsWith('~/') ? path.join(home, value.slice(2)) : value;
	const result: Record<string, string> = {};
	if (globalShellEnvVars) {
		for (const [key, value] of Object.entries(globalShellEnvVars)) {
			result[key] = expand(value);
		}
	}
	if (customEnvVars) {
		for (const [key, value] of Object.entries(customEnvVars)) {
			result[key] = expand(value);
		}
	}
	if (isResuming) {
		result.MAESTRO_SESSION_RESUMED = '1';
	}
	return result;
}

export function buildChildProcessEnv(
	customEnvVars?: Record<string, string>,
	isResuming?: boolean,
	globalShellEnvVars?: Record<string, string>,
	extraPathDirs?: string[]
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

	// Apply global shell environment variables (lower priority than session overrides)
	const home = os.homedir();
	if (globalShellEnvVars && Object.keys(globalShellEnvVars).length > 0) {
		for (const [key, value] of Object.entries(globalShellEnvVars)) {
			env[key] = value.startsWith('~/') ? path.join(home, value.slice(2)) : value;
		}
	}

	// Apply session-level custom environment variables (highest priority - override global)
	if (customEnvVars && Object.keys(customEnvVars).length > 0) {
		for (const [key, value] of Object.entries(customEnvVars)) {
			env[key] = value.startsWith('~/') ? path.join(home, value.slice(2)) : value;
		}
	}

	return env;
}

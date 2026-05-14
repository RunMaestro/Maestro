import * as os from 'os';
import * as path from 'path';
import { STANDARD_UNIX_PATHS } from '../constants';
import { detectNodeVersionManagerBinPaths, buildExpandedPath } from '../../../shared/pathUtils';
import { isWindows } from '../../../shared/platformDetection';

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
 * - **Unix/Linux/macOS**: Creates a minimal clean environment with essential variables and
 *   an expanded PATH that includes Node version manager paths
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
 * @note Terminal sessions do NOT strip Electron/IDE variables (full environment inherited on Windows)
 */
export function buildPtyTerminalEnv(shellEnvVars?: Record<string, string>): NodeJS.ProcessEnv {
	let env: NodeJS.ProcessEnv;

	if (isWindows()) {
		env = {
			...process.env,
			TERM: 'xterm-256color',
		};
	} else {
		const basePath = buildUnixBasePath();
		env = {
			HOME: process.env.HOME,
			USER: process.env.USER,
			SHELL: process.env.SHELL,
			TERM: 'xterm-256color',
			LANG: process.env.LANG || 'en_US.UTF-8',
			PATH: basePath,
		};
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
	// Electron internals — can cause Electron-based CLIs (e.g. Claude Code) to
	// misidentify their execution context
	'ELECTRON_RUN_AS_NODE',
	'ELECTRON_NO_ASAR',
	'ELECTRON_EXTRA_LAUNCH_ARGS',
	// VSCode / Claude Code extension markers — when inherited, agents may use
	// IDE-specific credentials or API paths instead of their own CLI auth
	'CLAUDECODE',
	'CLAUDE_CODE_ENTRYPOINT',
	'CLAUDE_AGENT_SDK_VERSION',
	'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING',
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
export function buildChildProcessEnv(
	customEnvVars?: Record<string, string>,
	isResuming?: boolean,
	globalShellEnvVars?: Record<string, string>
): NodeJS.ProcessEnv {
	const env = { ...process.env };

	// Strip environment variables that could interfere with agent behaviour.
	// Electron and IDE extension vars can cause agents to misidentify their
	// execution context, leading to auth failures or incorrect API paths.
	for (const key of STRIPPED_ENV_VARS) {
		delete env[key];
	}

	// Use the shared expanded PATH
	env.PATH = buildExpandedPath();

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

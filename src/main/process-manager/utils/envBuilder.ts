import * as os from 'os';
import * as path from 'path';
import { STANDARD_UNIX_PATHS } from '../constants';
import { detectNodeVersionManagerBinPaths, buildExpandedPath } from '../../../shared/pathUtils';

/**
 * Build the base PATH for macOS/Linux with detected Node version manager paths.
 */
export function buildUnixBasePath(): string {
	const versionManagerPaths = detectNodeVersionManagerBinPaths();

	if (versionManagerPaths.length > 0) {
		return versionManagerPaths.join(':') + ':' + STANDARD_UNIX_PATHS;
	}

	return STANDARD_UNIX_PATHS;
}

/**
 * Build environment for PTY terminal sessions
 */
export function buildPtyTerminalEnv(shellEnvVars?: Record<string, string>): NodeJS.ProcessEnv {
	const isWindows = process.platform === 'win32';
	let env: NodeJS.ProcessEnv;

	if (isWindows) {
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
 * Build environment for child process (non-PTY) spawning
 */
export function buildChildProcessEnv(
	customEnvVars?: Record<string, string>,
	isResuming?: boolean
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
	}

	// Apply custom environment variables
	if (customEnvVars && Object.keys(customEnvVars).length > 0) {
		const home = os.homedir();
		for (const [key, value] of Object.entries(customEnvVars)) {
			env[key] = value.startsWith('~/') ? path.join(home, value.slice(2)) : value;
		}
	}

	return env;
}

import * as os from 'os';
import * as path from 'path';
import { STANDARD_UNIX_PATHS } from '../constants';
import { detectNodeVersionManagerBinPaths } from '../../../shared/pathUtils';

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
 * Build environment for child process (non-PTY) spawning
 */
export function buildChildProcessEnv(
	customEnvVars?: Record<string, string>,
	isResuming?: boolean
): NodeJS.ProcessEnv {
	const isWindows = process.platform === 'win32';
	const home = os.homedir();
	const env = { ...process.env };

	// Platform-specific standard paths
	let standardPaths: string;
	let checkPath: string;

	if (isWindows) {
		const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
		const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
		const programFiles = process.env.ProgramFiles || 'C:\\Program Files';

		standardPaths = [
			path.join(appData, 'npm'),
			path.join(localAppData, 'npm'),
			path.join(programFiles, 'nodejs'),
			path.join(programFiles, 'Git', 'cmd'),
			path.join(programFiles, 'Git', 'bin'),
			path.join(process.env.SystemRoot || 'C:\\Windows', 'System32'),
		].join(';');
		checkPath = path.join(appData, 'npm');
	} else {
		standardPaths = buildUnixBasePath();
		checkPath = '/opt/homebrew/bin';
	}

	if (env.PATH) {
		if (!env.PATH.includes(checkPath)) {
			env.PATH = `${standardPaths}${path.delimiter}${env.PATH}`;
		}
	} else {
		env.PATH = standardPaths;
	}

	if (isResuming) {
		env.MAESTRO_SESSION_RESUMED = '1';
	}

	// Apply custom environment variables
	if (customEnvVars && Object.keys(customEnvVars).length > 0) {
		for (const [key, value] of Object.entries(customEnvVars)) {
			env[key] = value.startsWith('~/') ? path.join(home, value.slice(2)) : value;
		}
	}

	return env;
}

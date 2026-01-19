/**
 * Windows Diagnostics Collector
 *
 * Collects Windows-specific diagnostic information for troubleshooting
 * agent detection and process spawning issues on Windows platforms.
 *
 * This collector is only active on Windows (process.platform === 'win32').
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { execFileNoThrow } from '../../utils/execFile';
import { sanitizePath } from './settings';

export interface WindowsDiagnosticsInfo {
	isWindows: boolean;
	// Only populated on Windows
	environment?: {
		pathext: string[]; // PATHEXT extensions (what Windows considers executable)
		pathDirs: string[]; // Sanitized PATH directories
		pathDirsCount: number;
		appData: string; // Sanitized APPDATA path
		localAppData: string; // Sanitized LOCALAPPDATA path
		programFiles: string; // Sanitized Program Files path
		userProfile: string; // Sanitized user profile (home) path
	};
	agentProbing?: {
		// For each agent, show what paths were probed and what was found
		claude: AgentProbeResult;
		codex: AgentProbeResult;
		opencode: AgentProbeResult;
		gemini: AgentProbeResult;
		aider: AgentProbeResult;
	};
	whereResults?: {
		// Results from 'where' command for each agent
		claude: WhereResult;
		codex: WhereResult;
		opencode: WhereResult;
		gemini: WhereResult;
		aider: WhereResult;
	};
	npmInfo?: {
		npmGlobalPrefix: string | null; // npm config get prefix (sanitized)
		npmVersion: string | null;
		nodeVersion: string | null;
	};
	fileSystemChecks?: {
		// Check if common installation directories exist
		npmGlobalDir: DirectoryCheck;
		localBinDir: DirectoryCheck;
		wingetLinksDir: DirectoryCheck;
		scoopShimsDir: DirectoryCheck;
		chocolateyBinDir: DirectoryCheck;
		pythonScriptsDir: DirectoryCheck;
	};
}

export interface AgentProbeResult {
	probedPaths: Array<{
		path: string; // Sanitized path
		exists: boolean;
		isFile: boolean;
		extension: string;
	}>;
	foundPath: string | null; // First path that was found (sanitized)
}

export interface WhereResult {
	success: boolean;
	exitCode: number | string; // Number for exit codes, string for system errors (ENOENT, etc.)
	paths: string[]; // Sanitized paths returned by where
	error?: string;
}

export interface DirectoryCheck {
	path: string; // Sanitized path
	exists: boolean;
	isDirectory: boolean;
	files?: string[]; // List of executables found (if exists)
}

/**
 * Collect Windows-specific diagnostics.
 * Returns minimal info on non-Windows platforms.
 */
export async function collectWindowsDiagnostics(): Promise<WindowsDiagnosticsInfo> {
	const isWindows = process.platform === 'win32';

	if (!isWindows) {
		return { isWindows: false };
	}

	const result: WindowsDiagnosticsInfo = {
		isWindows: true,
	};

	// Collect environment info
	result.environment = collectEnvironmentInfo();

	// Probe for agent binaries
	result.agentProbing = {
		claude: await probeAgentPaths('claude'),
		codex: await probeAgentPaths('codex'),
		opencode: await probeAgentPaths('opencode'),
		gemini: await probeAgentPaths('gemini'),
		aider: await probeAgentPaths('aider'),
	};

	// Run 'where' command for each agent
	result.whereResults = {
		claude: await runWhereCommand('claude'),
		codex: await runWhereCommand('codex'),
		opencode: await runWhereCommand('opencode'),
		gemini: await runWhereCommand('gemini'),
		aider: await runWhereCommand('aider'),
	};

	// Collect npm info
	result.npmInfo = await collectNpmInfo();

	// Check common installation directories
	result.fileSystemChecks = await checkInstallationDirectories();

	return result;
}

function collectEnvironmentInfo(): WindowsDiagnosticsInfo['environment'] {
	const home = os.homedir();
	const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
	const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
	const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
	const pathext = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
	const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);

	return {
		pathext,
		pathDirs: pathDirs.map((p) => sanitizePath(p)),
		pathDirsCount: pathDirs.length,
		appData: sanitizePath(appData),
		localAppData: sanitizePath(localAppData),
		programFiles: sanitizePath(programFiles),
		userProfile: sanitizePath(home),
	};
}

async function probeAgentPaths(binaryName: string): Promise<AgentProbeResult> {
	const home = os.homedir();
	const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
	const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
	const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
	const chocolateyInstall = process.env.ChocolateyInstall || 'C:\\ProgramData\\chocolatey';

	// Known installation paths for each agent
	const knownPaths: Record<string, string[]> = {
		claude: [
			// PowerShell installer location
			path.join(home, '.local', 'bin', 'claude.exe'),
			// winget locations
			path.join(localAppData, 'Microsoft', 'WinGet', 'Links', 'claude.exe'),
			path.join(programFiles, 'WinGet', 'Links', 'claude.exe'),
			// npm global locations
			path.join(appData, 'npm', 'claude.cmd'),
			path.join(localAppData, 'npm', 'claude.cmd'),
			// Windows Apps (Microsoft Store / App Installer)
			path.join(localAppData, 'Microsoft', 'WindowsApps', 'claude.exe'),
		],
		codex: [
			path.join(appData, 'npm', 'codex.cmd'),
			path.join(localAppData, 'npm', 'codex.cmd'),
			path.join(home, '.local', 'bin', 'codex.exe'),
		],
		opencode: [
			path.join(home, 'scoop', 'shims', 'opencode.exe'),
			path.join(home, 'scoop', 'apps', 'opencode', 'current', 'opencode.exe'),
			path.join(chocolateyInstall, 'bin', 'opencode.exe'),
			path.join(home, 'go', 'bin', 'opencode.exe'),
			path.join(appData, 'npm', 'opencode.cmd'),
		],
		gemini: [path.join(appData, 'npm', 'gemini.cmd'), path.join(localAppData, 'npm', 'gemini.cmd')],
		aider: [
			path.join(appData, 'Python', 'Scripts', 'aider.exe'),
			path.join(localAppData, 'Programs', 'Python', 'Python312', 'Scripts', 'aider.exe'),
			path.join(localAppData, 'Programs', 'Python', 'Python311', 'Scripts', 'aider.exe'),
			path.join(localAppData, 'Programs', 'Python', 'Python310', 'Scripts', 'aider.exe'),
		],
	};

	const pathsToProbe = knownPaths[binaryName] || [];
	const probedPaths: AgentProbeResult['probedPaths'] = [];
	let foundPath: string | null = null;

	for (const probePath of pathsToProbe) {
		let exists = false;
		let isFile = false;

		try {
			const stats = fs.statSync(probePath);
			exists = true;
			isFile = stats.isFile();
			if (isFile && !foundPath) {
				foundPath = probePath;
			}
		} catch {
			// Path doesn't exist
		}

		probedPaths.push({
			path: sanitizePath(probePath),
			exists,
			isFile,
			extension: path.extname(probePath).toLowerCase(),
		});
	}

	return {
		probedPaths,
		foundPath: foundPath ? sanitizePath(foundPath) : null,
	};
}

async function runWhereCommand(binaryName: string): Promise<WhereResult> {
	try {
		const result = await execFileNoThrow('where', [binaryName]);
		const paths = result.stdout
			.split(/\r?\n/)
			.map((p) => p.trim())
			.filter(Boolean)
			.map((p) => sanitizePath(p));

		return {
			success: result.exitCode === 0,
			exitCode: result.exitCode,
			paths,
			error: result.exitCode !== 0 ? result.stderr : undefined,
		};
	} catch (error) {
		return {
			success: false,
			exitCode: -1,
			paths: [],
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

async function collectNpmInfo(): Promise<WindowsDiagnosticsInfo['npmInfo']> {
	let npmGlobalPrefix: string | null = null;
	let npmVersion: string | null = null;
	let nodeVersion: string | null = null;

	try {
		const prefixResult = await execFileNoThrow('npm', ['config', 'get', 'prefix']);
		if (prefixResult.exitCode === 0) {
			npmGlobalPrefix = sanitizePath(prefixResult.stdout.trim());
		}
	} catch {
		// npm not available
	}

	try {
		const versionResult = await execFileNoThrow('npm', ['--version']);
		if (versionResult.exitCode === 0) {
			npmVersion = versionResult.stdout.trim();
		}
	} catch {
		// npm not available
	}

	try {
		const nodeResult = await execFileNoThrow('node', ['--version']);
		if (nodeResult.exitCode === 0) {
			nodeVersion = nodeResult.stdout.trim();
		}
	} catch {
		// node not available
	}

	return {
		npmGlobalPrefix,
		npmVersion,
		nodeVersion,
	};
}

async function checkInstallationDirectories(): Promise<WindowsDiagnosticsInfo['fileSystemChecks']> {
	const home = os.homedir();
	const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
	const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
	const chocolateyInstall = process.env.ChocolateyInstall || 'C:\\ProgramData\\chocolatey';

	const dirsToCheck: Record<string, string> = {
		npmGlobalDir: path.join(appData, 'npm'),
		localBinDir: path.join(home, '.local', 'bin'),
		wingetLinksDir: path.join(localAppData, 'Microsoft', 'WinGet', 'Links'),
		scoopShimsDir: path.join(home, 'scoop', 'shims'),
		chocolateyBinDir: path.join(chocolateyInstall, 'bin'),
		pythonScriptsDir: path.join(appData, 'Python', 'Scripts'),
	};

	const result: Record<string, DirectoryCheck> = {};

	for (const [key, dirPath] of Object.entries(dirsToCheck)) {
		const check: DirectoryCheck = {
			path: sanitizePath(dirPath),
			exists: false,
			isDirectory: false,
		};

		try {
			const stats = fs.statSync(dirPath);
			check.exists = true;
			check.isDirectory = stats.isDirectory();

			if (check.isDirectory) {
				// List executable files in the directory
				try {
					const files = fs.readdirSync(dirPath);
					const executables = files.filter((f) => {
						const ext = path.extname(f).toLowerCase();
						return ['.exe', '.cmd', '.bat', '.com'].includes(ext);
					});
					// Only include first 20 executables to avoid huge output
					check.files = executables.slice(0, 20);
				} catch {
					// Can't read directory contents
				}
			}
		} catch {
			// Directory doesn't exist
		}

		result[key] = check;
	}

	return result as WindowsDiagnosticsInfo['fileSystemChecks'];
}

/**
 * Windows Diagnostics Collector
 *
 * Collects Windows-specific diagnostic information for troubleshooting
 * process spawning issues on Windows platforms.
 *
 * Privacy: No agent binary paths, installation locations, or directory
 * file listings are included. Only structural info (does the dir exist,
 * PATH entry count, versions) is collected.
 *
 * This collector is only active on Windows (process.platform === 'win32').
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { execFileNoThrow } from '../../utils/execFile';
import { isWindows } from '../../../shared/platformDetection';

export interface WindowsDiagnosticsInfo {
	isWindows: boolean;
	environment?: {
		pathext: string[];
		pathDirsCount: number;
	};
	npmInfo?: {
		npmVersion: string | null;
		nodeVersion: string | null;
	};
	fileSystemChecks?: {
		npmGlobalDir: DirectoryCheck;
		localBinDir: DirectoryCheck;
		wingetLinksDir: DirectoryCheck;
		scoopShimsDir: DirectoryCheck;
		chocolateyBinDir: DirectoryCheck;
		pythonScriptsDir: DirectoryCheck;
	};
}

export interface DirectoryCheck {
	exists: boolean;
	isDirectory: boolean;
}

/**
 * Collect Windows-specific diagnostics.
 * Returns minimal info on non-Windows platforms.
 */
export async function collectWindowsDiagnostics(): Promise<WindowsDiagnosticsInfo> {
	if (!isWindows()) {
		return { isWindows: false };
	}

	const result: WindowsDiagnosticsInfo = {
		isWindows: true,
	};

	// Collect environment info (no paths, just structural data)
	const pathext = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
	const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
	result.environment = {
		pathext,
		pathDirsCount: pathDirs.length,
	};

	// Collect npm/node versions only (no paths)
	result.npmInfo = await collectNpmInfo();

	// Check whether common installation directories exist (no paths or file listings)
	result.fileSystemChecks = checkInstallationDirectories();

	return result;
}

async function collectNpmInfo(): Promise<WindowsDiagnosticsInfo['npmInfo']> {
	let npmVersion: string | null = null;
	let nodeVersion: string | null = null;

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

	return { npmVersion, nodeVersion };
}

function checkInstallationDirectories(): WindowsDiagnosticsInfo['fileSystemChecks'] {
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
			exists: false,
			isDirectory: false,
		};

		try {
			const stats = fs.statSync(dirPath);
			check.exists = true;
			check.isDirectory = stats.isDirectory();
		} catch {
			// Directory doesn't exist
		}

		result[key] = check;
	}

	return result as WindowsDiagnosticsInfo['fileSystemChecks'];
}

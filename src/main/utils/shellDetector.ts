import { execFileNoThrow } from './execFile';

export interface ShellInfo {
	id: string;
	name: string;
	available: boolean;
	path?: string;
}

/**
 * Detect available shells on the system
 * Checks for platform-appropriate shells
 */
export async function detectShells(): Promise<ShellInfo[]> {
	const isWindows = process.platform === 'win32';

	// Platform-specific shell definitions
	const shells = isWindows
		? [
				// Windows shells
				{ id: 'powershell', name: 'PowerShell' },
				{ id: 'pwsh', name: 'PowerShell Core' },
				{ id: 'cmd', name: 'Command Prompt' },
				{ id: 'bash', name: 'Bash (Git Bash/WSL)' },
				{ id: 'wsl', name: 'WSL' },
			]
		: [
				// Unix-like shells
				{ id: 'zsh', name: 'Zsh' },
				{ id: 'bash', name: 'Bash' },
				{ id: 'sh', name: 'Bourne Shell (sh)' },
				{ id: 'fish', name: 'Fish' },
				{ id: 'tcsh', name: 'Tcsh' },
			];

	const shellInfos: ShellInfo[] = [];

	for (const shell of shells) {
		const info = await detectShell(shell.id, shell.name);
		shellInfos.push(info);
	}

	return shellInfos;
}

/**
 * Check if a specific shell is available on the system
 */
async function detectShell(shellId: string, shellName: string): Promise<ShellInfo> {
	try {
		const isWindows = process.platform === 'win32';

		// Map shell IDs to executable names for Windows
		let executableName = shellId;
		if (isWindows) {
			switch (shellId) {
				case 'powershell':
					executableName = 'powershell.exe';
					break;
				case 'pwsh':
					executableName = 'pwsh.exe';
					break;
				case 'cmd':
					executableName = 'cmd.exe';
					break;
				case 'wsl':
					executableName = 'wsl.exe';
					break;
				case 'bash':
					executableName = 'bash.exe';
					break;
			}
		}

		// Use 'which' on Unix-like systems, 'where' on Windows
		const command = isWindows ? 'where' : 'which';
		const result = await execFileNoThrow(command, [executableName]);

		if (result.exitCode === 0 && result.stdout.trim()) {
			return {
				id: shellId,
				name: shellName,
				available: true,
				path: result.stdout.trim().split('\n')[0], // Take first result if multiple
			};
		}

		return {
			id: shellId,
			name: shellName,
			available: false,
		};
	} catch {
		return {
			id: shellId,
			name: shellName,
			available: false,
		};
	}
}

/**
 * Get the command for a shell by its ID
 * Returns the shell executable name
 */
export function getShellCommand(shellId: string): string {
	// For Windows, map to appropriate commands
	if (process.platform === 'win32') {
		switch (shellId) {
			case 'powershell':
				return 'powershell.exe';
			case 'pwsh':
				return 'pwsh.exe';
			case 'cmd':
				return 'cmd.exe';
			case 'wsl':
				return 'wsl.exe';
			case 'bash':
			case 'sh':
				// On Windows, bash is typically from Git Bash or WSL
				return 'bash.exe';
			default:
				// Default to PowerShell on Windows for unknown shells
				return 'powershell.exe';
		}
	}

	// On Unix-like systems, use the shell ID directly
	return shellId;
}

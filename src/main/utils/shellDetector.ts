import { execFileNoThrow } from './execFile';
import { isWindows, getWhichCommand } from '../../shared/platformDetection';
import type { ShellInfo } from '../../shared/types';
export type { ShellInfo } from '../../shared/types';

/**
 * Detect available shells on the system
 * Checks for platform-appropriate shells
 */
export async function detectShells(): Promise<ShellInfo[]> {
	// Platform-specific shell definitions
	const shells = isWindows()
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
		// Map shell IDs to executable names for Windows
		let executableName = shellId;
		if (isWindows()) {
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
		const command = getWhichCommand();
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

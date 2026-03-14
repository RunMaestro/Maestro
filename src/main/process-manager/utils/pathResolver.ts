import * as fs from 'fs';
import { COMMON_SHELL_PATHS } from '../constants';
import { isWindows } from '../../../shared/platformDetection';

// Cache for shell path resolution
const shellPathCache = new Map<string, string>();

/**
 * Resolve a shell name to its full path.
 * Uses caching to avoid repeated filesystem checks.
 */
export function resolveShellPath(shell: string): string {
	const shellName =
		shell
			.split(/[/\\]/)
			.pop()
			?.replace(/\.exe$/i, '') || shell;

	if (isWindows()) {
		if (shellName === 'powershell' && !shell.includes('\\')) {
			return 'powershell.exe';
		} else if (shellName === 'pwsh' && !shell.includes('\\')) {
			return 'pwsh.exe';
		} else if (shellName === 'cmd' && !shell.includes('\\')) {
			return 'cmd.exe';
		}
		return shell;
	}

	// Unix: check if already a full path
	if (shell.includes('/')) {
		return shell;
	}

	// Check cache first
	const cachedPath = shellPathCache.get(shell);
	if (cachedPath) {
		return cachedPath;
	}

	// Search common paths
	for (const prefix of COMMON_SHELL_PATHS) {
		try {
			const fullPath = prefix + shell;
			fs.accessSync(fullPath, fs.constants.X_OK);
			shellPathCache.set(shell, fullPath);
			return fullPath;
		} catch {
			// Try next path
		}
	}

	return shell;
}

/**
 * Build a wrapped command with shell config sourcing for runCommand
 */
export function buildWrappedCommand(command: string, shellName: string): string {
	if (isWindows()) {
		return command;
	}

	if (shellName === 'fish') {
		return command;
	}

	if (shellName === 'zsh') {
		const escapedCommand = command.replace(/'/g, "'\\''");
		return `source ~/.zprofile 2>/dev/null; source ~/.zshrc 2>/dev/null; eval '${escapedCommand}'`;
	}

	if (shellName === 'bash') {
		const escapedCommand = command.replace(/'/g, "'\\''");
		return `source ~/.bash_profile 2>/dev/null; source ~/.bashrc 2>/dev/null; eval '${escapedCommand}'`;
	}

	return command;
}

/**
 * Build shell arguments for interactive one-off PTY commands.
 * Terminal aliases like `ls` -> `eza` only render correctly when the shell has a real PTY.
 */
export function buildInteractiveShellArgs(command: string, shellName: string): string[] {
	if (isWindows()) {
		return [command];
	}

	if (shellName === 'zsh' || shellName === 'bash') {
		return ['-l', '-i', '-c', command];
	}

	if (shellName === 'fish') {
		return ['-i', '-c', command];
	}

	return ['-c', command];
}

/**
 * Clear the shell path cache (useful for testing)
 */
export function clearShellPathCache(): void {
	shellPathCache.clear();
}

import { logger } from '../../utils/logger';
/**
 * Windows shell selection for agent execution.
 *
 * The cmd.exe and PowerShell argument escapers moved into maestro-lib
 * (`src/shared/maestro-lib/launch/windows-command.ts`) so a launcher with no
 * desktop around it applies the same rules. They are re-exported here so every
 * existing import, and every test that mocks this module, keeps resolving
 * unchanged.
 */
export {
	escapeCmdArg,
	escapeCmdArgs,
	escapePowerShellArg,
	escapePowerShellArgs,
	escapeArgsForShell,
	isPowerShellShell,
} from '../../../shared/maestro-lib/launch/windows-command';

/**
 * Configuration options for Windows shell selection.
 */
export interface WindowsShellConfig {
	/**
	 * User-configured custom shell path (takes highest priority).
	 * This is typically from settingsStore.get('customShellPath').
	 */
	customShellPath?: string;
	/**
	 * Currently selected shell (e.g., from settings or terminal config).
	 * Used if no customShellPath is provided.
	 */
	currentShell?: string;
}

/**
 * Result of Windows shell selection.
 */
export interface WindowsShellResult {
	/**
	 * The shell path to use for spawning processes.
	 */
	shell: string;
	/**
	 * Whether shell execution should be enabled (runInShell: true).
	 */
	useShell: boolean;
	/**
	 * The source of the shell selection (for logging).
	 */
	source: 'custom' | 'current' | 'powershell-default';
}

/**
 * Get the preferred shell for Windows agent execution.
 *
 * This function implements the shell selection priority for Windows to avoid
 * cmd.exe command line length limits (~8191 characters). The priority is:
 *
 * 1. User-configured custom shell path (if provided)
 * 2. Currently selected shell (if provided and not cmd.exe)
 * 3. PowerShell (default fallback to avoid cmd.exe limits)
 *
 * Why avoid cmd.exe:
 * - cmd.exe has a hard limit of ~8191 characters for command lines
 * - Long prompts (especially with system prompts) can easily exceed this
 * - The error message is: "Die Befehlszeile ist zu lang" (German for "The command line is too long")
 * - PowerShell has a much higher limit (32KB or more depending on version)
 *
 * @param config - Configuration options for shell selection
 * @returns The shell to use and whether to enable shell execution
 */
export function getWindowsShellForAgentExecution(
	config: WindowsShellConfig = {}
): WindowsShellResult {
	const { customShellPath, currentShell } = config;

	// 1. User-configured custom shell path takes priority
	if (customShellPath && customShellPath.trim()) {
		return {
			shell: customShellPath.trim(),
			useShell: true,
			source: 'custom',
		};
	}

	// 2. Use current shell if provided (and not cmd.exe, which has limits)
	if (currentShell && currentShell.trim()) {
		const shellLower = currentShell.toLowerCase();
		// Check basename to avoid false positives (e.g., C:\Users\commander\bash.exe)
		const basename = shellLower.split(/[\\/]/).pop() || '';
		const isCmdExe = basename === 'cmd' || basename === 'cmd.exe';
		// Skip cmd.exe to avoid command line length limits
		if (!isCmdExe) {
			return {
				shell: currentShell.trim(),
				useShell: true,
				source: 'current',
			};
		}
	}

	// 3. Default to PowerShell to avoid cmd.exe limits
	// Try multiple PowerShell paths in order of preference:
	// - PSHOME environment variable (most reliable)
	// - PowerShell Core (pwsh.exe) if installed
	// - Windows PowerShell (powershell.exe)
	// - Fall back to ComSpec (cmd.exe) as last resort with warning
	const fs = require('fs');
	const possiblePaths: string[] = [];

	// Add PSHOME path if environment variable is set
	if (process.env.PSHOME) {
		possiblePaths.push(`${process.env.PSHOME}\\powershell.exe`);
	}

	// Add common PowerShell locations
	possiblePaths.push(
		// Windows PowerShell (built into Windows)
		`${process.env.SystemRoot || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
		// PowerShell Core (if installed)
		`${process.env.ProgramFiles || 'C:\\Program Files'}\\PowerShell\\7\\pwsh.exe`,
		// Fallback to bare name (relies on PATH)
		'powershell.exe'
	);

	// Try each path and use the first that exists
	for (const shellPath of possiblePaths) {
		// For bare names like 'powershell.exe', assume it's in PATH
		if (!shellPath.includes('\\') && !shellPath.includes('/')) {
			return {
				shell: shellPath,
				useShell: true,
				source: 'powershell-default',
			};
		}
		// For full paths, check if file exists
		try {
			if (fs.existsSync(shellPath)) {
				return {
					shell: shellPath,
					useShell: true,
					source: 'powershell-default',
				};
			}
		} catch {
			// Ignore filesystem errors, continue to next path
		}
	}

	// Last resort: fall back to ComSpec (cmd.exe)
	// This may cause command line length issues, but at least it will work
	const comSpec = process.env.ComSpec || 'cmd.exe';
	logger.warn(
		`[shellEscape] PowerShell not found, falling back to ${comSpec}. ` +
			`Long commands may fail due to cmd.exe's ~8191 character limit.`
	);

	return {
		shell: comSpec,
		useShell: true,
		source: 'powershell-default', // Keep source consistent for logging
	};
}

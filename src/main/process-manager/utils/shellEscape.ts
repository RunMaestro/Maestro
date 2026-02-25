/**
 * Shell argument escaping utilities for Windows cmd.exe and PowerShell.
 *
 * These functions handle escaping command line arguments to prevent injection
 * and ensure proper argument passing when spawning processes via shell.
 *
 * References:
 * - cmd.exe escaping: https://docs.microsoft.com/en-us/windows-server/administration/windows-commands/cmd
 * - PowerShell escaping: https://docs.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_quoting_rules
 *
 * For production use, consider using the 'shescape' npm package which provides
 * more comprehensive cross-platform shell escaping with extensive testing.
 */

/**
 * Characters that require quoting in cmd.exe.
 * Based on cmd.exe special characters: https://ss64.com/nt/syntax-esc.html
 */
const CMD_SPECIAL_CHARS = /[ &|<>^%!()"\n\r#?*]/;

/**
 * Characters that require quoting in PowerShell.
 * Based on PowerShell special characters: https://ss64.com/ps/syntax-esc.html
 */
const POWERSHELL_SPECIAL_CHARS = /[ &|<>^%!()"\n\r#?*`$@{}[\]';,]/;

/**
 * Escape a single argument for use in cmd.exe.
 *
 * Strategy:
 * 1. If the argument contains special characters or is long, wrap in double quotes
 * 2. Escape existing double quotes by doubling them
 * 3. Escape carets (^) as they're the escape character in cmd.exe
 *
 * @param arg - The argument to escape
 * @returns The escaped argument safe for cmd.exe
 */
export function escapeCmdArg(arg: string): string {
	// If no special characters and not too long, return as-is
	if (!CMD_SPECIAL_CHARS.test(arg) && arg.length <= 100) {
		return arg;
	}

	// Escape double quotes by doubling them, and carets by doubling
	const escaped = arg.replace(/"/g, '""').replace(/\^/g, '^^');

	// Wrap in double quotes
	return `"${escaped}"`;
}

/**
 * Escape a single argument for use in PowerShell.
 *
 * Strategy:
 * 1. If the argument contains special characters or is long, wrap in single quotes
 * 2. Escape existing single quotes by doubling them (PowerShell's single-quote escape)
 *
 * Single quotes in PowerShell treat the content as a literal string, which is
 * safer than double quotes (which allow variable expansion).
 *
 * @param arg - The argument to escape
 * @returns The escaped argument safe for PowerShell
 */
export function escapePowerShellArg(arg: string): string {
	// If no special characters and not too long, return as-is
	if (!POWERSHELL_SPECIAL_CHARS.test(arg) && arg.length <= 100) {
		return arg;
	}

	// Escape single quotes by doubling them (PowerShell's escape mechanism)
	const escaped = arg.replace(/'/g, "''");

	// Wrap in single quotes (prevents variable expansion)
	return `'${escaped}'`;
}

/**
 * Escape an array of arguments for use in cmd.exe.
 *
 * @param args - The arguments to escape
 * @returns The escaped arguments safe for cmd.exe
 */
export function escapeCmdArgs(args: string[]): string[] {
	return args.map(escapeCmdArg);
}

/**
 * Escape an array of arguments for use in PowerShell.
 *
 * @param args - The arguments to escape
 * @returns The escaped arguments safe for PowerShell
 */
export function escapePowerShellArgs(args: string[]): string[] {
	return args.map(escapePowerShellArg);
}

/**
 * Detect if a shell path refers to PowerShell.
 *
 * @param shellPath - The shell path to check
 * @returns True if the shell is PowerShell (either Windows PowerShell or PowerShell Core)
 */
export function isPowerShellShell(shellPath: string | undefined): boolean {
	if (!shellPath) return false;
	const lower = shellPath.toLowerCase();
	return lower.includes('powershell') || lower.includes('pwsh');
}

/**
 * Escape arguments based on the target shell.
 *
 * @param args - The arguments to escape
 * @param shell - The shell path or name (optional, defaults to cmd.exe behavior)
 * @returns The escaped arguments
 */
export function escapeArgsForShell(args: string[], shell?: string): string[] {
	if (isPowerShellShell(shell)) {
		return escapePowerShellArgs(args);
	}
	return escapeCmdArgs(args);
}

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
	console.warn(
		`[shellEscape] PowerShell not found, falling back to ${comSpec}. ` +
			`Long commands may fail due to cmd.exe's ~8191 character limit.`
	);

	return {
		shell: comSpec,
		useShell: true,
		source: 'powershell-default', // Keep source consistent for logging
	};
}

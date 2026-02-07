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
 * Escape prompt content for PowerShell stdin delivery.
 *
 * When sending prompt content via stdin in raw mode to a PowerShell process,
 * PowerShell may attempt to parse certain lines as PowerShell code rather than
 * plain text. This function escapes content that would be misinterpreted.
 *
 * Specifically, lines that contain (possibly after whitespace) PowerShell operators
 * (-, @, $, etc.) are wrapped in a comment to prevent interpretation as code.
 *
 * Example:
 *   Input:  "Please do:\n- Run tests\n- Check logs"
 *   Output: "Please do:\n# - Run tests\n# - Check logs"
 *
 * This prevents errors like:
 *   "Ausdruck fehlt nach dem unären Operator '-'"
 *   (Expression missing after unary operator '-')
 *
 * @param content - The prompt content to escape
 * @returns The escaped content safe for PowerShell stdin
 */
export function escapePowerShellPromptContent(content: string): string {
	// Lines that need escaping: those with PowerShell special characters after optional whitespace
	// - : operator/parameter
	// @ : array/splatting
	// $ : variable
	// + : plus operator
	// & : ampersand (call operator)
	// | : pipe
	// < > : redirection
	// ( ) [ ] { } : grouping/subexpression
	// ! : history expansion
	// % : percentage
	// ^ : caret (escape char in cmd.exe)
	// ` : backtick (escape in PowerShell)
	// ; : statement separator
	const powerShellSpecialStartChars = /^(\s*)[-@$+&|<>()[\]{}!%^`; ]/;

	return content
		.split('\n')
		.map((line) => {
			// If line contains a PowerShell special character after optional whitespace,
			// insert '#' after the whitespace to make it a comment
			const match = powerShellSpecialStartChars.exec(line);
			if (match) {
				const leadingWhitespace = match[1];
				const restOfLine = line.slice(leadingWhitespace.length);
				return leadingWhitespace + '# ' + restOfLine;
			}
			return line;
		})
		.join('\n');
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
		// Skip cmd.exe to avoid command line length limits
		if (!shellLower.includes('cmd')) {
			return {
				shell: currentShell.trim(),
				useShell: true,
				source: 'current',
			};
		}
	}

	// 3. Default to PowerShell to avoid cmd.exe limits
	// Use PSHOME environment variable if available for a more reliable path
	const powerShellPath = process.env.PSHOME
		? `${process.env.PSHOME}\\powershell.exe`
		: 'powershell.exe';

	return {
		shell: powerShellPath,
		useShell: true,
		source: 'powershell-default',
	};
}

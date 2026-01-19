/**
 * Utility functions for cleaning and filtering terminal output
 * Removes control sequences, escape codes, and other non-visible content
 */

/**
 * Filter out shell prompts and command echoes from terminal output
 * This is used in Command Terminal mode to show ONLY stdout/stderr
 *
 * Removes:
 * - Lines that look like shell prompts (e.g., [user:~/path], user@host:~$)
 * - Lines that match the last command sent (command echoes)
 * - Git branch indicators (e.g., (main), (master))
 * - Standalone prompt markers
 */
function filterTerminalPrompts(text: string, lastCommand?: string): string {
	const lines = text.split('\n');
	const filteredLines: string[] = [];

	for (const line of lines) {
		const trimmedLine = line.trim();

		// Skip empty lines
		if (!trimmedLine) {
			continue;
		}

		// Skip lines that look like shell prompts
		// Patterns:
		// - [user:~/path] or [user:~/path]$
		// - user@host:~$
		// - ~/path $
		// - (main) or (master) - git branch indicators alone
		// - Lines ending with $ or # (common prompt endings)
		if (
			/^\[[\w\-\.]+:.*?\]/.test(trimmedLine) || // [user:~/path]
			/^[\w\-\.]+@[\w\-\.]+:.*?[\$#%>]/.test(trimmedLine) || // user@host:~$
			/^~?\/.*?[\$#%>]\s*$/.test(trimmedLine) || // ~/path $
			/^\([\w\-\/]+\)\s*$/.test(trimmedLine) || // (main) alone
			/^[\$#%>]\s*$/.test(trimmedLine) || // Just a prompt character
			/^\[.*?\]\s*\([\w\-\/]+\)\s*[\$#%>]?\s*$/.test(trimmedLine) // [user:~/path] (main) $
		) {
			continue;
		}

		// Skip command echoes (lines that match the last command sent)
		if (lastCommand && trimmedLine === lastCommand) {
			continue;
		}

		// Remove git branch indicators from the line (e.g., " (main)" or "(main) ")
		let cleanedLine = line.replace(/\s*\([\w\-\/]+\)\s*/g, ' ');

		// Remove trailing prompt characters if present
		cleanedLine = cleanedLine.replace(/[\$#%>]\s*$/, '');

		// If after all cleaning the line is empty, skip it
		if (cleanedLine.trim()) {
			filteredLines.push(cleanedLine);
		}
	}

	return filteredLines.join('\n');
}

/**
 * Strip terminal control sequences from raw PTY output
 * This removes:
 * - OSC sequences (Operating System Commands) like title changes
 * - CSI sequences (Control Sequence Introducer) like cursor positioning
 * - SGR sequences (Select Graphic Rendition) that aren't visible content
 * - Shell prompt markers and other non-content control codes
 * - Shell prompts (for terminal mode only)
 * - Command echoes (for terminal mode only)
 * - Git branch indicators (for terminal mode only)
 *
 * @param text - Raw terminal output
 * @param lastCommand - Last command sent to terminal (for filtering echoes)
 * @param isTerminal - Whether this is terminal mode (enables aggressive filtering)
 *
 * Note: This preserves ANSI color codes which are handled by ansi-to-html in the renderer
 */
export function stripControlSequences(
	text: string,
	lastCommand?: string,
	isTerminal: boolean = false
): string {
	let cleaned = text;

	// Remove OSC (Operating System Command) sequences
	// Format: ESC ] ... (BEL or ST)
	// Examples: window title changes, hyperlinks, custom sequences
	cleaned = cleaned.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '');

	// Remove CSI (Control Sequence Introducer) sequences that aren't color codes
	// Format: ESC [ ... letter
	// Keep: SGR color codes (end with 'm')
	// Remove: cursor movement, scrolling, etc.
	cleaned = cleaned.replace(/\x1b\[[\d;]*[A-KSTfHJhlp]/gi, '');

	// Remove shell integration markers (VSCode, iTerm2, etc.)
	// Format: ESC ] 133 ; ... BEL/ST
	cleaned = cleaned.replace(/\x1b\]133;[^\x07\x1b]*(\x07|\x1b\\)/g, '');
	cleaned = cleaned.replace(/\x1b\]1337;[^\x07\x1b]*(\x07|\x1b\\)/g, '');
	cleaned = cleaned.replace(/\x1b\]7;[^\x07\x1b]*(\x07|\x1b\\)/g, '');

	// Remove BARE shell integration sequences (without ESC prefix)
	// SSH interactive shells emit these when .zshrc/.bashrc loads shell integration
	// Format: ]1337;Key=Value]1337;Key=Value...actual content (no ESC prefix)
	// Process BEL-terminated sequences first
	cleaned = cleaned.replace(/\]1337;[^\x07]*\x07/g, '');
	cleaned = cleaned.replace(/\]133;[^\x07]*\x07/g, '');
	cleaned = cleaned.replace(/\]7;[^\x07]*\x07/g, '');
	// Handle chained sequences (followed by another ])
	cleaned = cleaned.replace(/\]1337;[^\]\x07\x1b]*(?=\])/g, '');
	cleaned = cleaned.replace(/\]133;[^\]\x07\x1b]*(?=\])/g, '');
	cleaned = cleaned.replace(/\]7;[^\]\x07\x1b]*(?=\])/g, '');
	// Handle last sequence in chain (ShellIntegrationVersion followed by content)
	cleaned = cleaned.replace(/\]1337;ShellIntegrationVersion=[\d;a-zA-Z=]*/g, '');
	cleaned = cleaned.replace(/\]1337;(?:RemoteHost|CurrentDir|User|HostName)=[^\/\]\x07\{]*/g, '');
	// Handle sequences at end of string
	cleaned = cleaned.replace(/^\]1337;[^\]\x07]*$/g, '');
	cleaned = cleaned.replace(/^\]133;[^\]\x07]*$/g, '');
	cleaned = cleaned.replace(/^\]7;[^\]\x07]*$/g, '');

	// Remove other OSC sequences by number
	cleaned = cleaned.replace(/\x1b\][0-9];[^\x07\x1b]*(\x07|\x1b\\)/g, '');

	// Remove soft hyphen and other invisible formatting
	cleaned = cleaned.replace(/\u00AD/g, '');

	// Remove carriage returns that are followed by newlines (Windows-style)
	// But keep standalone \r for terminal overwrites
	cleaned = cleaned.replace(/\r\n/g, '\n');

	// Remove any remaining standalone escape sequences without parameters
	cleaned = cleaned.replace(/\x1b[()][AB012]/g, '');

	// Remove BEL (bell) character
	cleaned = cleaned.replace(/\x07/g, '');

	// Remove other control characters except newline, tab, and ANSI escape start
	cleaned = cleaned.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1A\x1C-\x1F]/g, '');

	// For terminal mode, apply aggressive filtering to show ONLY command output
	if (isTerminal) {
		cleaned = filterTerminalPrompts(cleaned, lastCommand);
	}

	return cleaned;
}

/**
 * Strip ALL ANSI escape codes from text (including color codes).
 * This is more aggressive than stripControlSequences and removes everything.
 * Use this for stderr from AI agents where we don't want any formatting.
 *
 * NOTE: This is intentionally more comprehensive than shared/stringUtils.stripAnsiCodes().
 * The shared version handles basic SGR color/style codes (sufficient for UI display cleanup).
 * This version also handles: OSC sequences, character set selection, BEL, and control chars.
 * This comprehensive version is needed for raw terminal output from AI agents.
 *
 * @see src/shared/stringUtils.ts for the basic version
 */
export function stripAllAnsiCodes(text: string): string {
	// Remove all ANSI escape sequences including color codes
	// Format: ESC [ ... m (SGR sequences for colors/styles)
	// Format: ESC [ ... other letters (cursor, scrolling, etc.)
	// Format: ESC ] ... BEL/ST (OSC sequences)
	return text
		.replace(/\x1b\[[0-9;]*m/g, '') // SGR color/style codes
		.replace(/\x1b\[[\d;]*[A-Za-z]/g, '') // Other CSI sequences
		.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '') // OSC sequences
		.replace(/\x1b[()][AB012]/g, '') // Character set selection
		.replace(/\x07/g, '') // BEL character
		.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1A\x1C-\x1F]/g, ''); // Other control chars
}

/**
 * Detect if a line is likely a command echo in terminal output
 * This helps identify when the terminal is echoing back the command the user typed
 *
 * @internal This function is exported for testing purposes only.
 * It is not used in production code - the echo detection logic is
 * handled within filterTerminalPrompts() instead.
 */
export function isCommandEcho(line: string, lastCommand?: string): boolean {
	if (!lastCommand) return false;

	const trimmedLine = line.trim();
	const trimmedCommand = lastCommand.trim();

	// Exact match
	if (trimmedLine === trimmedCommand) return true;

	// Line starts with the command (may have prompt prefix)
	if (trimmedLine.endsWith(trimmedCommand)) return true;

	return false;
}

/**
 * Extract the actual command from user input (without prompt)
 *
 * @internal This function is exported for testing purposes only.
 * It is not used in production code.
 */
export function extractCommand(input: string): string {
	// Remove common prompt patterns from the beginning
	const withoutPrompt = input.replace(/^[^$#%>]*[$#%>]\s*/, '');
	return withoutPrompt.trim();
}

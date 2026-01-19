/**
 * Shared string utility functions
 *
 * This module provides string manipulation utilities used across
 * multiple parts of the application (main, renderer, web).
 */

/**
 * Strip ANSI escape codes and terminal control sequences from text
 *
 * Web interfaces don't render terminal colors, so we remove ANSI codes
 * for clean display. This handles:
 * - Standard SGR (Select Graphic Rendition) escape sequences for terminal coloring
 * - OSC (Operating System Command) sequences with ESC prefix
 * - iTerm2/VSCode shell integration sequences (]1337;, ]133;, ]7;)
 *   Both with and without ESC prefix (SSH shells may emit bare sequences)
 *
 * @param text - The input text potentially containing escape sequences
 * @returns The text with all escape sequences removed
 *
 * @example
 * ```typescript
 * // Remove color codes from terminal output
 * const clean = stripAnsiCodes('\x1b[31mError:\x1b[0m Something went wrong');
 * // Returns: 'Error: Something went wrong'
 *
 * // Handle complex sequences
 * const text = stripAnsiCodes('\x1b[1;32mSuccess\x1b[0m');
 * // Returns: 'Success'
 *
 * // Handle iTerm2 shell integration (common in SSH connections)
 * const ssh = stripAnsiCodes(']1337;RemoteHost=user@host]1337;CurrentDir=/homeHello');
 * // Returns: 'Hello'
 * ```
 */
export function stripAnsiCodes(text: string): string {
	// Matches ANSI escape sequences: ESC[ followed by params and command letter
	// ESC is \x1b (decimal 27), followed by [ and then zero or more params
	// (digits or semicolons) ending with a letter command
	let result = text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');

	// Remove OSC sequences WITH ESC prefix: ESC ] ... (BEL or ST)
	// Common patterns: window title, hyperlinks, shell integration
	result = result.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '');

	// IMPORTANT: Process BEL-terminated sequences FIRST before bare sequences
	// This prevents partial matches that leave path fragments behind
	// Remove bare OSC sequences terminated by BEL (\x07)
	result = result.replace(/\]1337;[^\x07]*\x07/g, '');
	result = result.replace(/\]133;[^\x07]*\x07/g, '');
	result = result.replace(/\]7;[^\x07]*\x07/g, '');

	// Remove iTerm2/VSCode shell integration sequences WITHOUT ESC prefix
	// SSH interactive shells emit these when .zshrc/.bashrc loads shell integration
	// Format: ]1337;Key=Value or ]133;... or ]7;...
	// These appear concatenated: ]1337;RemoteHost=user@host]1337;CurrentDir=/home
	// Pattern: Match ]1337;Key=Value where next char is ] or end of visible content
	result = result.replace(/\]1337;[^\]\x07\x1b]*(?=\])/g, '');
	result = result.replace(/\]133;[^\]\x07\x1b]*(?=\])/g, '');
	result = result.replace(/\]7;[^\]\x07\x1b]*(?=\])/g, '');

	// Handle the LAST sequence in a chain (not followed by another ] and no BEL)
	// Content typically starts with: / (paths), { (JSON), [ (arrays), or alphanumeric
	// The sequence value for ShellIntegrationVersion is: digits, semicolons, "shell=", and shell name
	// Example: ]1337;ShellIntegrationVersion=13;shell=zsh/opt/homebrew/bin/codex -> /opt/homebrew/bin/codex
	// Example: ]1337;ShellIntegrationVersion=13;shell=zsh{"type":"system"} -> {"type":"system"}
	// Match the sequence prefix + key=value where value contains only expected chars
	result = result.replace(/\]1337;ShellIntegrationVersion=[\d;a-zA-Z=]*/g, '');
	// For other keys, the value ends when we hit content start chars (/, {, [, or after certain patterns)
	result = result.replace(/\]1337;(?:RemoteHost|User|HostName)=[^\/\]\x07\{]*/g, '');
	result = result.replace(/\]1337;CurrentDir=[^\]\x07\{]*(?=[\{\/]|$)/g, '');
	result = result.replace(/\]133;[A-Z](?=[\/\{])/g, '');
	result = result.replace(/\]7;[^\/\]\x07\{]*(?=[\/\{])/g, '');

	// Handle sequences at TRUE end of string (no content follows at all)
	// Only match if the sequence is the entire remaining string
	result = result.replace(/^\]1337;[^\]\x07]*$/g, '');
	result = result.replace(/^\]133;[^\]\x07]*$/g, '');
	result = result.replace(/^\]7;[^\]\x07]*$/g, '');

	// Remove BEL character itself
	result = result.replace(/\x07/g, '');

	return result;
}

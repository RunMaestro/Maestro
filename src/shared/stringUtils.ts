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
/**
 * Escape special regex characters so a literal string can be embedded in a
 * `RegExp` without being interpreted as a pattern.
 *
 * @example
 * ```typescript
 * new RegExp(escapeRegExp('file (1).txt'), 'g'); // matches the literal name
 * ```
 */
export function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Percent-decode a string, returning it unchanged when decoding would throw
 *
 * `decodeURIComponent` throws `URIError` on malformed percent encoding, which
 * is easy to hit with user-supplied input: a Windows path containing `%`, a
 * hand-typed deep link, or a markdown image src that was never encoded. Use
 * this wherever the input is not guaranteed to be well-formed.
 *
 * @param value - The possibly percent-encoded string
 * @returns The decoded string, or the original value if decoding fails
 *
 * @example
 * ```typescript
 * safeDecodeURIComponent('my%20file.md'); // 'my file.md'
 * safeDecodeURIComponent('100%');         // '100%' (would throw URIError)
 * ```
 */
export function safeDecodeURIComponent(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch (err) {
		// Malformed percent encoding (a bare '%', a truncated '%E0%A4') throws
		// URIError. Callers handle user-supplied strings that may not be encoded at
		// all, so fall back to the original value instead of failing.
		//
		// ONLY URIError is swallowed. A bare catch here would also hide unexpected
		// failures (a RangeError from a pathological input, a TypeError from a
		// future refactor) and keep them out of Sentry, which is exactly the
		// silent-failure pattern CLAUDE.md warns about. This also matches the
		// implementation already on rc, so the two branches converge instead of
		// conflicting on this function.
		if (err instanceof URIError) return value;
		throw err;
	}
}

export function stripAnsiCodes(text: string): string {
	// Matches ANSI CSI sequences, including DEC private modes like ESC[?1h.
	let result = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');

	// Remove standalone keypad/application mode toggles used by interactive CLIs.
	result = result.replace(/\x1b[=>]/g, '');

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

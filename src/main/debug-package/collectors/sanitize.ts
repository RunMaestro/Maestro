/**
 * Sanitization Utilities
 *
 * Shared sanitization functions for debug package collectors.
 * Centralizes path sanitization and sensitive content scrubbing.
 */

import os from 'os';

/**
 * Sanitize a file path by replacing the home directory with ~
 */
export function sanitizePath(pathStr: string): string {
	if (typeof pathStr !== 'string') return pathStr;
	const homeDir = os.homedir();
	// Handle both forward and backward slashes
	const normalizedPath = pathStr.replace(/\\/g, '/');
	const normalizedHome = homeDir.replace(/\\/g, '/');
	return normalizedPath.replace(normalizedHome, '~');
}

/**
 * Sanitize a free-text string that may contain embedded file paths.
 * Replaces home directory occurrences within arbitrary text.
 */
export function sanitizeText(text: string): string {
	if (typeof text !== 'string') return text;
	const homeDir = os.homedir();
	// Replace both slash styles using split/join for pre-ES2021 compat
	let result = text.split(homeDir).join('~');
	const windowsHome = homeDir.replace(/\//g, '\\');
	if (windowsHome !== homeDir) {
		result = result.split(windowsHome).join('~');
	}
	return result;
}

/**
 * Sanitize a log entry's message and data fields.
 * Removes embedded paths and truncates overly long messages
 * that likely contain prompts or conversation content.
 */
export function sanitizeLogMessage(message: string): string {
	let sanitized = sanitizeText(message);
	// Truncate messages over 500 chars — long messages are likely prompts or conversation content
	if (sanitized.length > 500) {
		sanitized = sanitized.slice(0, 500) + ' [TRUNCATED]';
	}
	return sanitized;
}

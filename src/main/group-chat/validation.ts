/**
 * @file validation.ts
 * @description Input validation for Group Chat IPC boundary.
 *
 * All IPC handlers that accept parameters from the renderer must validate
 * inputs before processing. This module provides reusable validators for
 * group chat IDs, participant names, message content, images, and custom args.
 */

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CONTROL_OR_UNSAFE_CHARS = /[\x00-\x1f\x7f|\\\/\n\r]/;

const SHELL_METACHAR_REGEX = /[`]|\$\(|\$\{|&&|\|\||[;<>|]/;

const ENV_VAR_KEY_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Validates that a group chat ID is a valid UUID v4 string.
 *
 * @param id - Value to validate
 * @returns The validated ID string
 * @throws Error if id is not a valid UUID v4
 */
export function validateGroupChatId(id: unknown): string {
	if (typeof id !== 'string' || !UUID_V4_REGEX.test(id)) {
		throw new Error('Invalid group chat ID: must be a valid UUID');
	}
	return id;
}

/**
 * Validates a participant name for safety and sanity.
 *
 * @param name - Value to validate
 * @returns The validated and trimmed name
 * @throws Error if name is invalid
 */
export function validateParticipantName(name: unknown): string {
	if (typeof name !== 'string') {
		throw new Error('Invalid participant name: must be a string');
	}

	const trimmed = name.trim();

	if (trimmed.length === 0) {
		throw new Error('Invalid participant name: must not be empty');
	}

	if (trimmed.length > 100) {
		throw new Error('Invalid participant name: must be 100 characters or fewer');
	}

	if (CONTROL_OR_UNSAFE_CHARS.test(trimmed)) {
		throw new Error('Invalid participant name: contains unsafe characters');
	}

	return trimmed;
}

/**
 * Validates message content for size limits.
 *
 * @param content - Value to validate
 * @param maxLength - Maximum allowed character length (default 512000)
 * @returns The validated content string
 * @throws Error if content is invalid or too large
 */
export function validateMessageContent(content: unknown, maxLength = 512000): string {
	if (typeof content !== 'string') {
		throw new Error('Invalid message content: must be a string');
	}

	if (content.length === 0) {
		throw new Error('Invalid message content: must not be empty');
	}

	if (content.length > maxLength) {
		throw new Error(
			`Message too large: ${content.length} characters exceeds maximum of ${maxLength}`
		);
	}

	return content;
}

/**
 * Validates base64-encoded image data for size limits.
 *
 * @param data - Value to validate
 * @param maxSizeBytes - Maximum decoded size in bytes (default 20MB)
 * @returns The validated base64 string
 * @throws Error if data is invalid or too large
 */
export function validateBase64Image(data: unknown, maxSizeBytes = 20 * 1024 * 1024): string {
	if (typeof data !== 'string') {
		throw new Error('Invalid image data: must be a string');
	}

	// Approximate decoded size: base64 uses ~4/3 ratio
	const estimatedSize = data.length * 0.75;
	if (estimatedSize > maxSizeBytes) {
		throw new Error(
			`Image too large: estimated ${Math.round(estimatedSize)} bytes exceeds maximum of ${maxSizeBytes}`
		);
	}

	return data;
}

/**
 * Validates custom args for shell safety.
 *
 * @param args - Value to validate
 * @returns The validated args string, or undefined if nullish
 * @throws Error if args contain shell metacharacters
 */
export function validateCustomArgs(args: unknown): string | undefined {
	if (args == null) {
		return undefined;
	}

	if (typeof args !== 'string') {
		throw new Error('Custom args must be a string');
	}

	if (SHELL_METACHAR_REGEX.test(args)) {
		throw new Error('Custom args contain unsafe characters');
	}

	return args;
}

/**
 * Validates and sanitizes custom environment variables.
 *
 * @param vars - Value to validate
 * @returns Validated env vars record, or undefined if nullish
 * @throws Error if keys or values are invalid
 */
export function sanitizeCustomEnvVars(vars: unknown): Record<string, string> | undefined {
	if (vars == null) {
		return undefined;
	}

	if (typeof vars !== 'object' || Array.isArray(vars)) {
		throw new Error('Custom env vars must be an object');
	}

	const record = vars as Record<string, unknown>;

	for (const key of Object.keys(record)) {
		if (!ENV_VAR_KEY_REGEX.test(key)) {
			throw new Error(`Invalid environment variable key: '${key}'`);
		}
		if (typeof record[key] !== 'string') {
			throw new Error(`Environment variable '${key}' must have a string value`);
		}
	}

	return record as Record<string, string>;
}

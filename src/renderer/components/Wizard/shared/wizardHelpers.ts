/**
 * Shared utility functions for Wizard and InlineWizard components.
 */

/**
 * Check if a string contains any emoji characters.
 */
export function containsEmoji(str: string): boolean {
	const emojiRegex =
		/[\u{1F300}-\u{1FAFF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|[\u{1F600}-\u{1F64F}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]|[\u{1F900}-\u{1FAFF}]|[\u{2300}-\u{23FF}]|[\u{200D}]|[\u{FE0F}]/u;
	return emojiRegex.test(str);
}

/**
 * Format agent name with robot emoji prefix if no emoji present.
 */
export function formatAgentName(name: string): string {
	if (!name) return '🤖 Agent';
	return containsEmoji(name) ? name : `🤖 ${name}`;
}

/**
 * Safely convert a value to a string for rendering.
 * Returns the string if it's already a string, otherwise null.
 * This prevents objects from being passed to React as children.
 */
export function safeString(value: unknown): string | null {
	return typeof value === 'string' ? value : null;
}

/**
 * Extract a descriptive detail string from tool input.
 * Looks for common properties like command, pattern, file_path, query.
 * Only returns actual strings - objects are safely ignored to prevent React errors.
 */
export function getToolDetail(input: unknown): string | null {
	if (!input || typeof input !== 'object') return null;
	const inputObj = input as Record<string, unknown>;
	return (
		safeString(inputObj.command) ||
		safeString(inputObj.pattern) ||
		safeString(inputObj.file_path) ||
		safeString(inputObj.query) ||
		safeString(inputObj.path) ||
		null
	);
}

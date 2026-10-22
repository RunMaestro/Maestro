/**
 * The two stats helpers a row's value depends on, shared by the desktop's stats module
 * (`src/main/stats/utils.ts` re-exports them) and the runtime's turn recorder, so a row
 * written by either reads the same to the Usage Dashboard.
 */

/**
 * Generate a unique ID for database entries.
 *
 * Uses timestamp-random format (e.g., `1712345-abc123`) rather than UUID
 * because the stats DB treats this format as a load-bearing invariant
 * (primary keys, foreign keys, and backward compatibility with existing
 * data rely on it). Do not replace with generateUUID().
 */
export function generateId(): string {
	return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * Normalize file paths to use forward slashes consistently across platforms.
 *
 * This ensures that paths stored in the database use a consistent format
 * regardless of the operating system, enabling cross-platform data portability
 * and consistent filtering by project path.
 *
 * - Converts Windows-style backslashes to forward slashes
 * - Preserves UNC paths (\\server\share -> //server/share)
 * - Handles null/undefined by returning null
 *
 * @param filePath - The file path to normalize (may be Windows or Unix style)
 * @returns The normalized path with forward slashes, or null if input is null/undefined
 */
export function normalizePath(filePath: string | null | undefined): string | null {
	if (filePath == null) {
		return null;
	}
	// Replace all backslashes with forward slashes
	return filePath.replace(/\\/g, '/');
}

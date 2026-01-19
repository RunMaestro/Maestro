/**
 * Simple UUID v4 generator.
 *
 * Generates RFC 4122 compliant version 4 UUIDs using Math.random().
 * This is suitable for non-cryptographic purposes like session IDs
 * and history entry IDs.
 *
 * @returns A UUID v4 string (e.g., "550e8400-e29b-41d4-a716-446655440000")
 */
export function generateUUID(): string {
	return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
		const r = (Math.random() * 16) | 0;
		const v = c === 'x' ? r : (r & 0x3) | 0x8;
		return v.toString(16);
	});
}

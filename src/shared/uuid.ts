/**
 * Simple UUID v4 generator.
 *
 * Generates RFC 4122 compliant version 4 UUIDs using a cryptographically
 * secure random number source.
 *
 * @returns A UUID v4 string (e.g., "550e8400-e29b-41d4-a716-446655440000")
 */
export function generateUUID(): string {
	const cryptoObject = (globalThis as any).crypto;
	if (cryptoObject?.randomUUID) {
		return cryptoObject.randomUUID();
	}

	if (!cryptoObject?.getRandomValues) {
		throw new Error('Secure UUID generation is not supported in this environment');
	}

	const bytes = new Uint8Array(16);
	cryptoObject.getRandomValues(bytes);
	bytes[6] = (bytes[6] & 0x0f) | 0x40;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;

	const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

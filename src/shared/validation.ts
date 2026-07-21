/**
 * Returns whether any defined optional property is not a string.
 *
 * Empty and whitespace-only strings are valid here; field-specific validators
 * remain responsible for stricter content policies.
 */
export function hasInvalidOptionalStrings(
	raw: Record<string, unknown>,
	keys: readonly string[]
): boolean {
	return keys.some((key) => raw[key] !== undefined && typeof raw[key] !== 'string');
}

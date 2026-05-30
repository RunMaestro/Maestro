/**
 * JSON parsing helpers shared by main and renderer code.
 */

/**
 * JSON.parse rejects a leading UTF-8 BOM even though some editors and sync
 * tools can write one into otherwise-valid JSON files.
 */
export function stripJsonBom(value: string): string {
	return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

export function parseJsonWithBom<T = unknown>(value: string): T {
	return JSON.parse(stripJsonBom(value)) as T;
}

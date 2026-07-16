import fs from 'fs/promises';

/** A persisted cache that is invalidated by its schema version. */
export interface VersionedJson {
	version: number;
}

/** Narrows parsed JSON to one caller-owned persisted shape. */
export type JsonDecoder<T> = (value: unknown) => value is T;

function isJsonObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read a versioned JSON cache as a safe miss.
 *
 * Each cache owns its decoder: this helper deliberately handles only file I/O,
 * JSON parsing, and version invalidation. Callers retain their write, logging,
 * and fallback policies.
 */
export async function readVersionedJsonCache<T extends VersionedJson>(
	filePath: string,
	expectedVersion: number,
	decode: JsonDecoder<T>
): Promise<T | null> {
	try {
		const parsed: unknown = JSON.parse(await fs.readFile(filePath, 'utf-8'));
		if (!decode(parsed) || parsed.version !== expectedVersion) return null;
		return parsed;
	} catch {
		return null;
	}
}

/**
 * Read a JSON object containing a typed array under one known key as a safe miss.
 *
 * The caller supplies the element decoder so persisted schema ownership stays at
 * the callsite rather than being hidden behind a broad storage abstraction.
 */
export async function readKeyedJsonArray<T>(
	filePath: string,
	key: string,
	decodeElement: JsonDecoder<T>
): Promise<T[] | null> {
	try {
		const root: unknown = JSON.parse(await fs.readFile(filePath, 'utf-8'));
		if (!isJsonObject(root) || !Object.hasOwn(root, key)) return null;

		const candidate = root[key];
		if (!Array.isArray(candidate)) return null;

		const values: T[] = [];
		for (const entry of candidate) {
			if (!decodeElement(entry)) return null;
			values.push(entry);
		}
		return values;
	} catch {
		return null;
	}
}

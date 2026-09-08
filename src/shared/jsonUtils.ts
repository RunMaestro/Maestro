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

/**
 * Largest serialized payload we still round-trip through `JSON.parse` as a
 * final integrity check before writing it over a good file.
 *
 * Above this size the check costs more than the write it guards. The agent-runs
 * store reached 20MB, where a re-parse is ~40ms - paid on the Electron main
 * thread, which is also the thread that answers every IPC call, on every single
 * store write. A field trace attributed 82% of active main-process CPU to this
 * class of synchronous JSON work.
 */
const JSON_ROUND_TRIP_LIMIT_BYTES = 1024 * 1024;

/** Index of the last non-whitespace character, or -1. Scans without copying. */
function lastNonWhitespaceIndex(value: string): number {
	for (let index = value.length - 1; index >= 0; index -= 1) {
		const code = value.charCodeAt(index);
		// space, \t, \n, \v, \f, \r
		if (code !== 32 && (code < 9 || code > 13)) return index;
	}
	return -1;
}

/**
 * Guard a serialized JSON payload before it can replace an on-disk file.
 *
 * The failure this exists to stop is `JSON.stringify` returning `undefined`
 * (for `undefined`, a function, or a symbol), which `writeFile` would happily
 * persist as the literal text "undefined" - unparseable, and a silent way to
 * clobber good data. The empty string is rejected for the same reason.
 *
 * Beyond that, `JSON.stringify` cannot produce malformed JSON: a value either
 * serializes correctly or throws (circular references) before we get here. So
 * the round-trip parse only ever catches truncation, which cannot happen to a
 * string still in memory. We keep it for small payloads because it is free, and
 * fall back to a balanced-delimiter check above
 * {@link JSON_ROUND_TRIP_LIMIT_BYTES} so a large store does not pay ~40ms of
 * redundant parsing on every write.
 *
 * `target` is the file path or store name, used only in the error message.
 */
export function assertSerializedJsonIsSafe(
	serialized: string | undefined,
	target: string
): asserts serialized is string {
	if (serialized === undefined || serialized.length === 0) {
		throw new Error(`Refusing to write empty/undefined JSON to ${target}`);
	}

	if (serialized.length > JSON_ROUND_TRIP_LIMIT_BYTES) {
		const end = lastNonWhitespaceIndex(serialized);
		const first = serialized[0];
		const last = end >= 0 ? serialized[end] : '';
		const balanced = (first === '{' && last === '}') || (first === '[' && last === ']');
		if (!balanced) {
			throw new Error(`Refusing to write malformed JSON document to ${target}`);
		}
		return;
	}

	try {
		JSON.parse(serialized);
	} catch (err) {
		throw new Error(`Refusing to write unparseable JSON to ${target}: ${err}`);
	}
}

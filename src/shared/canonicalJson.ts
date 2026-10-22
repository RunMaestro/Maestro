/**
 * Deterministic JSON: the same value always gives the same text.
 *
 * `JSON.stringify` writes an object's keys in the order they were added, so
 * two objects that hold the same data can serialize differently. That does no
 * harm in storage. It is wrong for anything that hashes or compares the text:
 * a content hash, a cache key, an equality check, a payload that gets signed.
 * `canonicalJson` is for those.
 *
 * THE RULES
 * They are the rules of RFC 8785 (JSON Canonicalization Scheme), so a reader
 * written in another language can produce the same bytes:
 *   - no whitespace
 *   - object keys sorted by UTF-16 code unit, at every depth
 *   - array elements in the order given
 *   - strings and numbers written the way `JSON.stringify` writes them
 * Encode the text as UTF-8 before you hash it.
 *
 * WHAT IT LEAVES OUT
 * An object member whose value is `undefined`, so `{ a: 1, b: undefined }` and
 * `{ a: 1 }` give the same text. They are the same JSON document, and an
 * optional field that was set to `undefined` is the usual way to get one.
 *
 * WHAT IT REFUSES
 * It throws a `TypeError` for anything that is not a JSON value:
 *   - a non-finite number (`NaN`, `Infinity`, `-Infinity`)
 *   - `undefined` anywhere but an object member: at the top, in an array, or
 *     as the hole of a sparse array
 *   - a bigint, a function, or a symbol
 *   - an object that is not an array or a plain object: a `Date`, a `Map`, a
 *     class instance. Convert it first.
 *   - a circular reference
 * `JSON.stringify` writes `null` for `NaN` and `{}` for a `Map`. A canonical
 * form that changes a value on the way out makes two different values compare
 * equal, so this one refuses instead. The message names the kind of value and
 * never its content, so it is safe to log.
 *
 * ONE DIFFERENCE FROM RFC 8785
 * That scheme refuses a string that holds a lone surrogate. This writes it as
 * an escape (`\ud800`), the way `JSON.stringify` does, so the text never
 * holds one and its UTF-8 encoding loses nothing.
 *
 * ROUND TRIP
 * The text is valid JSON, and `canonicalJson(JSON.parse(text))` gives the same
 * text again. So a value can be written to disk in any key order, read back,
 * and still give the bytes it gave before.
 */
export function canonicalJson(value: unknown): string {
	return serialize(value, new Set());
}

function fail(what: string): never {
	throw new TypeError(`canonicalJson cannot serialize ${what}`);
}

/**
 * `ancestors` holds the containers on the path from the root to `value`. It is
 * not every container seen so far: the same object in two places is not a
 * circle, and it serializes twice.
 *
 * The text is built here, piece by piece. Copying the value into a new object
 * with its keys added in sorted order and calling `JSON.stringify` on the copy
 * does not sort it: an engine lists integer-like keys first, in numeric order,
 * whatever order they were added in.
 */
function serialize(value: unknown, ancestors: Set<object>): string {
	if (value === null) return 'null';
	if (typeof value === 'boolean') return value ? 'true' : 'false';
	if (typeof value === 'string') return JSON.stringify(value);
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) fail(`the non-finite number ${value}`);
		return JSON.stringify(value);
	}
	if (value === undefined) fail('undefined');
	if (typeof value !== 'object') fail(`a ${typeof value}`);

	if (ancestors.has(value)) fail('a circular reference');
	ancestors.add(value);
	const text = Array.isArray(value)
		? serializeArray(value, ancestors)
		: serializeObject(value, ancestors);
	ancestors.delete(value);
	return text;
}

function serializeArray(value: unknown[], ancestors: Set<object>): string {
	const elements: string[] = [];
	// By index, not `map`: `map` skips the holes of a sparse array, and a hole
	// must be refused like any other `undefined`.
	for (let index = 0; index < value.length; index += 1) {
		elements.push(serialize(value[index], ancestors));
	}
	return `[${elements.join(',')}]`;
}

function serializeObject(value: object, ancestors: Set<object>): string {
	const prototype: unknown = Object.getPrototypeOf(value);
	if (prototype !== null && prototype !== Object.prototype) {
		const name: unknown = (prototype as { constructor?: { name?: unknown } }).constructor?.name;
		fail(typeof name === 'string' && name ? `an instance of ${name}` : 'a non-plain object');
	}

	const members: string[] = [];
	// The default sort compares UTF-16 code units, which is the order the rules
	// call for. Not `localeCompare`: its result depends on the machine's locale.
	for (const key of Object.keys(value).sort()) {
		const member = (value as Record<string, unknown>)[key];
		if (member === undefined) continue;
		members.push(`${JSON.stringify(key)}:${serialize(member, ancestors)}`);
	}
	return `{${members.join(',')}}`;
}

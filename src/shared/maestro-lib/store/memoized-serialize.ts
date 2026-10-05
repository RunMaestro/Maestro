/**
 * Per-element serialization memo for the sessions document (DG4).
 *
 * `maestro-sessions.json` is one array entry per agent, each carrying its tabs and transcripts: 5 to 13 MB.
 * Re-serializing the whole file on every write is what made the desktop un-typeable during streaming
 * (issue #1501). This module serializes each array element once and reuses the text while the element
 * object is unchanged. The output is byte for byte what conf writes (`JSON.stringify(doc, undefined,
 * '\t')`), so the file format does not change.
 *
 * Hoisted out of `src/main/stores/deferred-writes.ts` (which re-exports `serializeWithMemoizedArray`) so
 * the library's store writer and the desktop's electron-store wrapper share one memo and one format.
 */

/**
 * Memoized JSON for a single session, keyed by the session object itself.
 *
 * Keyed by reference rather than by id on purpose: an id-keyed cache would go
 * stale the moment a session changed, and would need every mutator to
 * invalidate it. Reference identity gets that for free - a mutated session is a
 * different object, so it simply misses. A WeakMap also lets removed sessions
 * fall out with no bookkeeping.
 *
 * Module-scoped so a re-wrapped store (tests) keeps the memo.
 */
const serializedByValue = new WeakMap<object, string>();

/** Indent every line of `json` after the first by `depth` tabs. */
function indentJson(json: string, depth: number): string {
	if (depth <= 0) return json;
	const pad = '\t'.repeat(depth);
	return json.split('\n').join(`\n${pad}`);
}

/**
 * Depth every memoized array element is rendered at. The memo below stores the
 * ALREADY-INDENTED string, so it is only valid for this one depth - re-indenting
 * a cache hit was most of what the memo was supposed to save. A field trace put
 * `indentJson` at 75ms of main-process CPU, roughly twice `serializeWithMemoizedArray`
 * itself, because every write re-ran a split/join over every unchanged session.
 */
const MEMOIZED_ELEMENT_DEPTH = 2;

/**
 * Serialize one array element at {@link MEMOIZED_ELEMENT_DEPTH}, reusing the
 * memo when the object is unchanged.
 *
 * Returns the indented text, ready to concatenate - not the raw
 * `JSON.stringify` output.
 */
function serializeElement(value: unknown): string | undefined {
	// Only objects can be WeakMap keys. Primitives are cheap anyway.
	if (typeof value !== 'object' || value === null) {
		const primitive = JSON.stringify(value, undefined, '\t');
		// `undefined` and functions stringify to undefined; the caller renders
		// those array slots as `null`, so pass the miss through unindented.
		return primitive === undefined ? undefined : indentJson(primitive, MEMOIZED_ELEMENT_DEPTH);
	}
	const cached = serializedByValue.get(value);
	if (cached !== undefined) return cached;
	const json = JSON.stringify(value, undefined, '\t');
	// `undefined` (a non-serializable value) is not cacheable and JSON.stringify
	// renders such array slots as `null` anyway - let the caller handle it.
	if (json === undefined) return undefined;
	const indented = indentJson(json, MEMOIZED_ELEMENT_DEPTH);
	serializedByValue.set(value, indented);
	return indented;
}

/**
 * Serialize `data` exactly as conf would (`JSON.stringify(data, undefined,
 * '\t')`), but reusing memoized JSON for the elements of `memoKey`'s array.
 *
 * Falls back to a plain stringify whenever the shape is not the one this
 * optimization understands, so a surprising document is never mis-serialized.
 */
export function serializeWithMemoizedArray(data: unknown, memoKey: string): string {
	if (typeof data !== 'object' || data === null || Array.isArray(data)) {
		return JSON.stringify(data, undefined, '\t');
	}
	const record = data as Record<string, unknown>;
	const items = record[memoKey];
	if (!Array.isArray(items)) {
		return JSON.stringify(data, undefined, '\t');
	}

	const parts: string[] = [];
	for (const [key, value] of Object.entries(record)) {
		let json: string | undefined;
		if (key === memoKey) {
			// `serializeElement` already indents to MEMOIZED_ELEMENT_DEPTH, so only
			// the element's own leading tabs are added here. `undefined` elements
			// render as `null`, matching JSON.stringify's array behaviour.
			const elements = items.map((item) => `\t\t${serializeElement(item) ?? 'null'}`);
			json = elements.length === 0 ? '[]' : `[\n${elements.join(',\n')}\n\t]`;
		} else {
			const plain = JSON.stringify(value, undefined, '\t');
			// A key whose value is not serializable (undefined, a function) is
			// omitted from the object entirely - same as JSON.stringify.
			if (plain === undefined) continue;
			json = indentJson(plain, 1);
		}
		parts.push(`\t${JSON.stringify(key)}: ${json}`);
	}

	return parts.length === 0 ? '{}' : `{\n${parts.join(',\n')}\n}`;
}

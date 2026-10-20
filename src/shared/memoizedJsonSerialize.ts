/**
 * Serialize a large `{ key: [...items] }` JSON document, re-serializing only
 * the items that changed since the last write.
 *
 * The store files this serves (`maestro-sessions.json`, the agent-runs ledger)
 * are multi-megabyte arrays rewritten in full on the Electron main thread, and
 * between two writes almost every element is unchanged. Each element's JSON is
 * memoized by OBJECT IDENTITY, so a writer that updates entries immutably (new
 * object for a changed entry, same object for an untouched one) pays only for
 * what changed.
 *
 * Contract for callers: an object, once serialized here, must never be mutated
 * in place. A mutated object keeps its stale memo. Replace it instead.
 *
 * Plain module, no Electron or Node imports, so the CLI bundle can use it too.
 */

/**
 * Memoized JSON for one array element, keyed by the element object itself.
 *
 * Keyed by reference rather than by id on purpose: an id-keyed cache would go
 * stale the moment an entry changed, and would need every mutator to
 * invalidate it. Reference identity gets that for free - a changed entry is a
 * different object, so it simply misses. A WeakMap also lets removed entries
 * fall out with no bookkeeping.
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

/** Render one array element at {@link MEMOIZED_ELEMENT_DEPTH}, with no memo. */
function renderElement(value: unknown): string {
	const json = JSON.stringify(value, undefined, '\t');
	// `undefined` and functions stringify to undefined; JSON.stringify renders
	// such array slots as `null`, so this does too.
	return json === undefined ? 'null' : indentJson(json, MEMOIZED_ELEMENT_DEPTH);
}

/**
 * Serialize one array element at {@link MEMOIZED_ELEMENT_DEPTH}, reusing the
 * memo when the object is unchanged.
 *
 * Returns the indented text, ready to concatenate - not the raw
 * `JSON.stringify` output.
 */
function serializeElement(value: unknown): string {
	// Only objects can be WeakMap keys. Primitives are cheap anyway.
	if (typeof value !== 'object' || value === null) return renderElement(value);
	const cached = serializedByValue.get(value);
	if (cached !== undefined) return cached;
	const text = renderElement(value);
	serializedByValue.set(value, text);
	return text;
}

/**
 * UTF-8 bytes of {@link serializeElement}'s text, memoized the same way.
 *
 * A separate memo from the string one on purpose: a caller that writes bytes
 * never needs the string again, and holding both would double what a
 * multi-megabyte store keeps resident.
 */
const encodedByValue = new WeakMap<object, Uint8Array>();

const utf8 = new TextEncoder();

function encodeElement(value: unknown): Uint8Array {
	if (typeof value !== 'object' || value === null) return utf8.encode(renderElement(value));
	const cached = encodedByValue.get(value);
	if (cached !== undefined) return cached;
	const bytes = utf8.encode(renderElement(value));
	encodedByValue.set(value, bytes);
	return bytes;
}

/**
 * Walk `data` in `JSON.stringify(data, undefined, '\t')` order, handing literal
 * text to `text` and each element of `memoKey`'s array to `element`. Returns
 * false, having emitted nothing, when the shape is not one this optimization
 * understands, so the caller can fall back to a plain stringify.
 */
function walkMemoizedArray(
	data: unknown,
	memoKey: string,
	text: (chunk: string) => void,
	element: (item: unknown) => void
): boolean {
	if (typeof data !== 'object' || data === null || Array.isArray(data)) return false;
	const record = data as Record<string, unknown>;
	const items = record[memoKey];
	if (!Array.isArray(items)) return false;

	let first = true;
	for (const [key, value] of Object.entries(record)) {
		let plain: string | undefined;
		if (key !== memoKey) {
			plain = JSON.stringify(value, undefined, '\t');
			// A key whose value is not serializable (undefined, a function) is
			// omitted from the object entirely - same as JSON.stringify.
			if (plain === undefined) continue;
		}
		text(`${first ? '{\n' : ',\n'}\t${JSON.stringify(key)}: `);
		first = false;
		if (plain !== undefined) {
			text(indentJson(plain, 1));
		} else if (items.length === 0) {
			text('[]');
		} else {
			// Elements are already indented to MEMOIZED_ELEMENT_DEPTH, so only their
			// own leading tabs are added here.
			text('[\n');
			items.forEach((item, index) => {
				text(index === 0 ? '\t\t' : ',\n\t\t');
				element(item);
			});
			text('\n\t]');
		}
	}
	text(first ? '{}' : '\n}');
	return true;
}

/**
 * Serialize `data` exactly as `JSON.stringify(data, undefined, '\t')` would
 * (which is also conf's on-disk format), but reusing memoized JSON for the
 * elements of `memoKey`'s array.
 *
 * Falls back to a plain stringify whenever the shape is not the one this
 * optimization understands, so a surprising document is never mis-serialized.
 */
export function serializeWithMemoizedArray(data: unknown, memoKey: string): string {
	const parts: string[] = [];
	const memoized = walkMemoizedArray(
		data,
		memoKey,
		(chunk) => parts.push(chunk),
		(item) => parts.push(serializeElement(item))
	);
	return memoized ? parts.join('') : JSON.stringify(data, undefined, '\t');
}

/**
 * The UTF-8 bytes of {@link serializeWithMemoizedArray}'s output, as chunks to
 * write in order, with each element's bytes memoized by identity.
 *
 * For a store file that is too big to rebuild per write. Producing the string
 * and handing it to `fs.writeFile` still costs two passes over the WHOLE
 * document on the calling thread - the join, then Node's synchronous UTF-8
 * encode before the async write starts - even when every element was a memo
 * hit. A field trace on a 72 MB `maestro-sessions.json` put those two at
 * ~500 ms of main-process CPU in 13 s. Chunks skip both: an unchanged element
 * is its cached bytes, and only changed elements and the small text between
 * them are encoded. Pass the array straight to `fsp.writeFile`.
 *
 * Concatenating the chunks gives exactly the bytes of the string version:
 * every boundary falls between JSON tokens, never inside a surrogate pair.
 */
export function encodeWithMemoizedArray(data: unknown, memoKey: string): Uint8Array[] {
	const chunks: Uint8Array[] = [];
	// Runs of literal text are merged into one chunk, so the chunk count tracks
	// the element count rather than every separator.
	let pending = '';
	const memoized = walkMemoizedArray(
		data,
		memoKey,
		(chunk) => {
			pending += chunk;
		},
		(item) => {
			chunks.push(utf8.encode(pending), encodeElement(item));
			pending = '';
		}
	);
	if (!memoized) return [utf8.encode(JSON.stringify(data, undefined, '\t'))];
	chunks.push(utf8.encode(pending));
	return chunks;
}

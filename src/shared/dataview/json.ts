/**
 * JSON text for Dataview values that went through upstream's `Transferable` codec (DV-5). `Transferable`
 * turns dates, durations, and links into plain tagged objects but keeps `Map` and `Set` as they are,
 * because upstream only ever sent them through structured clone (a web worker, IndexedDB). JSON drops both
 * to `{}`, so this pair tags them on the way out and rebuilds them on the way in.
 *
 * Use them as the `replacer` and `reviver` of `JSON.stringify` and `JSON.parse`. Values that hold no
 * `Map` or `Set` come out as ordinary JSON.
 */

/** The tag key, in the same spirit as upstream's `___transfer-type`. */
const JSON_TYPE_KEY = '___maestro-json';

type TaggedCollection =
	| { [JSON_TYPE_KEY]: 'map'; value: [unknown, unknown][] }
	| { [JSON_TYPE_KEY]: 'set'; value: unknown[] };

/** `JSON.stringify` replacer: a `Map` or `Set` becomes a tagged array of its entries. */
export function dataviewJsonReplacer(_key: string, value: unknown): unknown {
	if (value instanceof Map) return { [JSON_TYPE_KEY]: 'map', value: [...value.entries()] };
	if (value instanceof Set) return { [JSON_TYPE_KEY]: 'set', value: [...value] };
	return value;
}

/** `JSON.parse` reviver: rebuilds what {@link dataviewJsonReplacer} tagged. */
export function dataviewJsonReviver(_key: string, value: unknown): unknown {
	if (value === null || typeof value !== 'object' || !(JSON_TYPE_KEY in value)) return value;
	const tagged = value as TaggedCollection;
	if (!Array.isArray(tagged.value)) return value;
	if (tagged[JSON_TYPE_KEY] === 'map') return new Map(tagged.value);
	if (tagged[JSON_TYPE_KEY] === 'set') return new Set(tagged.value);
	return value;
}

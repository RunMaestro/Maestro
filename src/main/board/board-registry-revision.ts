import { isDeepStrictEqual } from 'node:util';
import { canonicalJson } from '../../shared/canonicalJson';

interface RegistryPart {
	/** Detached, validated JSON; never shares objects with a live store. */
	value: unknown;
	json: string;
}
interface RegistryField {
	array: boolean;
	parts: RegistryPart[];
}

/** Process-local revision of the complete, freshly read launch registry.
 *
 * Every observation compares every field/value again, including nested values
 * of objects mutated in place. Only serialization is reused: a detached JSON
 * snapshot must match the current value before its canonical bytes can be used.
 * Top-level arrays are split by index so an edit to one agent's transcript does
 * not re-encode every other agent. Array order and all unknown fields still count.
 *
 * This is not a store or authorization cache. Callers must read the live stores
 * on each claim/start fence, including inside the claim transaction. No persisted
 * fingerprint or RunSpec format changes; the result is the same revision sequence
 * as comparing canonicalJson(registry) after each successful observation.
 */
export class BoardRegistryRevision {
	private fields = new Map<string, RegistryField>();
	private revision = 0;

	observe(registry: Record<string, unknown>): number {
		const fields = new Map<string, RegistryField>();
		let changed = this.revision === 0;
		for (const key of Object.keys(registry)) {
			const value = registry[key];
			if (value === undefined) continue; // Same omission as canonicalJson.
			const array = Array.isArray(value);
			const values: unknown[] = array ? value : [value];
			const old = this.fields.get(key);
			const parts: RegistryPart[] = [];
			if (!old || old.array !== array || old.parts.length !== values.length) changed = true;
			for (let index = 0; index < values.length; index++) {
				const current = values[index];
				const previous = old?.parts[index];
				if (previous && isDeepStrictEqual(current, previous.value)) {
					parts.push(previous);
					continue;
				}
				// A nonmatching value must pass the existing strict canonicalizer.
				// Do not use JSON.stringify's lossy NaN/undefined/Date conversions.
				const json = canonicalJson(current);
				if (json !== previous?.json) changed = true;
				parts.push({ value: JSON.parse(json), json });
			}
			fields.set(key, { array, parts });
		}
		if (fields.size !== this.fields.size) changed = true;
		// Commit only after every value passed validation. An invalid observation
		// must neither advance the revision nor replace any part of its baseline.
		this.fields = fields;
		if (changed) this.revision++;
		return this.revision;
	}
}

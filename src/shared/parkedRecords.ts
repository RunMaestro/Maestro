/**
 * Parking a `key = value` entry: switched off, still editable, never read.
 *
 * The shape is two records rather than one record with an `enabled` flag, and
 * that is the whole point. Being present in the ACTIVE record is exactly the
 * same statement as being live, so every consumer - `resolveSshOptions`, the
 * four SSH spawn sites, `resolveAgentEnvironment` - keeps reading one record
 * and needs no filter. A single flag inside one record would put that filter in
 * every read site, and the first one that forgets it ships the `ProxyCommand`
 * the user thought they had switched off.
 *
 * The rule this module enforces so no caller has to: a key lives in exactly ONE
 * of the two records. A key in both is unreachable state - re-enabling the
 * parked copy after deleting the live one silently restores a value the user
 * cannot see - so the active record always wins.
 *
 * Import-free on purpose: the renderer's row editor, the main-process save
 * handler, and the CLI bundle all use it.
 */

/** One entry mid-edit, before it is sorted into a record. */
export interface ParkableEntry {
	key: string;
	value: string;
	/** `false` parks it: kept and editable, but out of the active record. */
	enabled: boolean;
}

/**
 * The two records. Either is `undefined` when empty, so a section the user
 * emptied stores no key at all rather than an empty object.
 */
export interface ParkedRecordPair {
	active?: Record<string, string>;
	parked?: Record<string, string>;
}

/** `undefined` for an empty record, so nothing empty reaches disk. */
function orUndefined(record: Record<string, string>): Record<string, string> | undefined {
	return Object.keys(record).length > 0 ? record : undefined;
}

/**
 * Sort a list of edited entries into the active and parked records.
 *
 * Blank keys are dropped (a half-typed row is not a value), and keys are
 * trimmed so ` ProxyJump` and `ProxyJump` cannot become two entries.
 */
export function splitParkedEntries(entries: ParkableEntry[]): ParkedRecordPair {
	const active: Record<string, string> = {};
	const parked: Record<string, string> = {};

	for (const entry of entries) {
		const key = entry.key.trim();
		if (!key) continue;
		if (entry.enabled) {
			active[key] = entry.value;
			// A row switched on wins the key outright: the same key cannot be
			// both live and parked, and the live value is the one on screen.
			delete parked[key];
		} else if (!(key in active)) {
			parked[key] = entry.value;
		}
	}

	return { active: orUndefined(active), parked: orUndefined(parked) };
}

/**
 * Move named keys between the two records - the CLI's spelling of the eye
 * button. Keys not present in either record are ignored rather than invented,
 * so disabling something already gone is a no-op instead of a resurrection.
 *
 * @param parked `true` switches the keys off, `false` switches them back on.
 */
export function setKeysParked(
	pair: ParkedRecordPair,
	keys: string[],
	parked: boolean
): ParkedRecordPair {
	const nextActive = { ...(pair.active ?? {}) };
	const nextParked = { ...(pair.parked ?? {}) };

	for (const rawKey of keys) {
		const key = rawKey.trim();
		if (!key) continue;
		const from = parked ? nextActive : nextParked;
		const to = parked ? nextParked : nextActive;
		if (!(key in from)) continue;
		to[key] = from[key];
		delete from[key];
	}

	return { active: orUndefined(nextActive), parked: orUndefined(nextParked) };
}

/**
 * Names of every key in the pair, active first, for a "what can I toggle?"
 * listing or an error that names the available keys.
 */
export function parkedPairKeys(pair: ParkedRecordPair): string[] {
	return [...Object.keys(pair.active ?? {}), ...Object.keys(pair.parked ?? {})];
}

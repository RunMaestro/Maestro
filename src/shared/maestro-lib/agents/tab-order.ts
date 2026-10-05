/**
 * `reconcileTabOrder`: the one rule for merging an agent's `unifiedTabOrder` when two sides write it (DM7).
 *
 * AI tab commands insert and remove AI refs, and the desktop inserts and removes file, terminal, and
 * browser refs and reorders the strip. The runtime owns the set of AI refs and the order of every ref
 * it holds; the renderer owns the non-AI refs. The authority's order wins, AI refs the authority lacks
 * are dropped, and each local non-AI ref the authority lacks goes after its local predecessor (or first,
 * when it had none that the result holds).
 *
 * The fold applier calls it with the stored order as the authority; the renderer's mirror calls it with
 * the event's order.
 *
 * Design: `Plans/maestro-tui-desktop-migration.md` section 2.3.
 */

import type { TabRefRecord } from '../store/records';

const refKey = (ref: TabRefRecord): string => `${ref.type}:${ref.id}`;

export function reconcileTabOrder(
	authority: readonly TabRefRecord[] | undefined,
	local: readonly TabRefRecord[] | undefined
): TabRefRecord[] {
	const base = authority ?? [];
	const mine = local ?? [];
	// The authority holds the AI refs it knows; with no authority at all the local order stands.
	if (authority === undefined) return [...mine];

	const result: TabRefRecord[] = [...base];
	const present = new Set(result.map(refKey));
	for (let index = 0; index < mine.length; index += 1) {
		const ref = mine[index];
		if (ref.type === 'ai' || present.has(refKey(ref))) continue;
		// After the nearest earlier local ref the result already holds, else at the front.
		let insertAt = 0;
		for (let back = index - 1; back >= 0; back -= 1) {
			const at = result.findIndex((entry) => refKey(entry) === refKey(mine[back]));
			if (at >= 0) {
				insertAt = at + 1;
				break;
			}
		}
		result.splice(insertAt, 0, ref);
		present.add(refKey(ref));
	}
	return result;
}

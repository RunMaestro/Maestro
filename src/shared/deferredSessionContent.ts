/** Content omitted from a browser bootstrap but still present in the main store. */
export interface DeferredSessionContent {
	tabIds: string[];
	commands?: true;
}

export const MAX_PERSISTED_SESSION_LOGS = 100;

/** Newest composer commands kept per agent (`Session.aiCommandHistory`). */
export const MAX_PERSISTED_AI_COMMAND_HISTORY = 50;

/** Keep stored entries while folding in work that arrived before a deferred read finished. */
export function mergeDeferredItems<T>(
	stored: T[] | undefined,
	incoming: T[] | undefined,
	keyOf: (item: T) => string | undefined,
	limit?: number
): T[] {
	const merged = [...(stored ?? [])];
	const positions = new Map<string, number>();
	merged.forEach((item, index) => {
		const key = keyOf(item);
		if (key) positions.set(key, index);
	});
	for (const item of incoming ?? []) {
		const key = keyOf(item);
		const position = key ? positions.get(key) : undefined;
		if (position !== undefined) {
			merged[position] = item;
		} else {
			if (key) positions.set(key, merged.length);
			merged.push(item);
		}
	}
	return limit === undefined ? merged : merged.slice(-limit);
}

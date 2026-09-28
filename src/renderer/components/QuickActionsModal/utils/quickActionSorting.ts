import {
	AGENT_BUCKET_ORDER,
	getAgentBucket,
	type QuickAction,
	type QuickActionMode,
} from '../types';

// Strip leading emojis (and the whitespace/zero-width joiners that follow them)
// so a name like "Atlas" with a leading emoji sorts under "A".
export function alphabetizeKey(label: string): string {
	const stripped = label.replace(
		/^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|[\u{FE00}-\u{FE0F}\u{200D}\s])+/u,
		''
	);
	return (stripped || label).toLocaleLowerCase();
}

export function filterAndSortQuickActions(
	actions: QuickAction[],
	search: string,
	mode: QuickActionMode
): QuickAction[] {
	const searchLower = search.toLowerCase();
	const showDebugCommands = searchLower.includes('debug');

	return actions
		.filter((a) => {
			const isDebugCommand = a.label.toLowerCase().startsWith('debug:');
			if (isDebugCommand && !showDebugCommands) {
				return false;
			}
			return a.label.toLowerCase().includes(searchLower);
		})
		.sort((a, b) => {
			const sameAgent =
				a.agentSortKey !== undefined &&
				b.agentSortKey !== undefined &&
				a.agentSortKey === b.agentSortKey;
			if (sameAgent && !!a.bookmarked !== !!b.bookmarked) {
				return a.bookmarked ? -1 : 1;
			}
			if (mode === 'agents') {
				const aBucket = AGENT_BUCKET_ORDER.indexOf(getAgentBucket(a));
				const bBucket = AGENT_BUCKET_ORDER.indexOf(getAgentBucket(b));
				if (aBucket !== bBucket) return aBucket - bBucket;
				return alphabetizeKey(a.label).localeCompare(alphabetizeKey(b.label));
			}
			return a.label.localeCompare(b.label);
		});
}

/**
 * Bucket headers only earn their pixels when the list actually spans more than
 * one bucket - a list of nothing but idle agents needs no "IDLE" label.
 */
export function shouldShowAgentBucketHeaders(
	actions: QuickAction[],
	mode: QuickActionMode
): boolean {
	if (mode !== 'agents') return false;
	const buckets = new Set(actions.map(getAgentBucket));
	return buckets.size > 1;
}

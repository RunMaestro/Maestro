import type { QuickAction, QuickActionMode } from '../types';

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
				const aRunning = a.isRunningAgent ? 1 : 0;
				const bRunning = b.isRunningAgent ? 1 : 0;
				if (aRunning !== bRunning) return bRunning - aRunning;
				return alphabetizeKey(a.label).localeCompare(alphabetizeKey(b.label));
			}
			return a.label.localeCompare(b.label);
		});
}

export function shouldShowAgentBucketHeaders(
	actions: QuickAction[],
	mode: QuickActionMode
): boolean {
	return (
		mode === 'agents' &&
		actions.some((a) => a.isRunningAgent === true) &&
		actions.some((a) => a.isRunningAgent === false)
	);
}

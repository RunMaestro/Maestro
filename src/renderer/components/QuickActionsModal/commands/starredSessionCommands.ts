import type { StarredItem } from '../../../hooks/session/useStarredItems';
import type { QuickAction } from '../types';

interface BuildStarredSessionCommandsArgs {
	/**
	 * The Left Bar's Starred Sessions list, read from `sidebarNavStore`. It is the
	 * same list Cmd+[ / Cmd+] cycles, already scoped to this window's agents and
	 * empty while the Starred Sessions section is hidden.
	 */
	starredItems: StarredItem[];
	/** Same activation as clicking the Left Bar row: focus an open tab, resume a closed one. */
	activateStarredItem: (item: StarredItem) => void | Promise<void>;
}

/**
 * One "Starred: <session> (<agent>)" entry per starred session. The agent name
 * rides in the label because the palette filters on the label alone, so typing
 * an agent's name finds its starred sessions too.
 */
export function buildStarredSessionCommands({
	starredItems,
	activateStarredItem,
}: BuildStarredSessionCommandsArgs): QuickAction[] {
	return starredItems.map((item) => ({
		id: `starred-${item.key}`,
		label: `Starred: ${item.displayName} (${item.agentName})`,
		subtext: item.kind === 'open' ? 'Open tab' : 'Closed session - resume',
		action: () => {
			void activateStarredItem(item);
		},
	}));
}

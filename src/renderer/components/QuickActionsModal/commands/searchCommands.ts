import type { RightPanelTab, Shortcut } from '../../../types';
import type { QuickAction } from '../types';

interface BuildSearchCommandsArgs {
	setQuickActionOpen: (open: boolean) => void;
	setLeftSidebarOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
	setRightPanelOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
	setActiveRightTab: (tab: RightPanelTab) => void;
	setActiveFocus: (focus: 'sidebar' | 'main' | 'right') => void;
	setSessionFilterOpen: (open: boolean) => void;
	setOutputSearchOpen: (open: boolean) => void;
	setFileTreeFilterOpen: (open: boolean) => void;
	setHistorySearchFilterOpen: (open: boolean) => void;
	/** Open cross-tab message search. Omitted when there are no AI tabs to search. */
	openCrossTabSearch?: () => void;
	searchAllTabsShortcut?: Shortcut;
}

export function buildSearchCommands({
	setQuickActionOpen,
	setLeftSidebarOpen,
	setRightPanelOpen,
	setActiveRightTab,
	setActiveFocus,
	setSessionFilterOpen,
	setOutputSearchOpen,
	setFileTreeFilterOpen,
	setHistorySearchFilterOpen,
	openCrossTabSearch,
	searchAllTabsShortcut,
}: BuildSearchCommandsArgs): QuickAction[] {
	return [
		{
			id: 'searchAgents',
			label: 'Search: Agents',
			subtext: 'Filter agents in the sidebar',
			action: () => {
				setQuickActionOpen(false);
				setLeftSidebarOpen(true);
				setActiveFocus('sidebar');
				setTimeout(() => setSessionFilterOpen(true), 50);
			},
		},
		{
			id: 'searchMessages',
			label: 'Search: Messages (This Tab)',
			subtext: 'Search messages in the current conversation',
			action: () => {
				setQuickActionOpen(false);
				setActiveFocus('main');
				setTimeout(() => setOutputSearchOpen(true), 50);
			},
		},
		...(openCrossTabSearch
			? [
					{
						id: 'searchAllTabs',
						label: 'Search: Messages (All Agent Tabs)',
						subtext: 'Search every open tab in this agent and jump to the hit',
						shortcut: searchAllTabsShortcut,
						action: () => {
							setQuickActionOpen(false);
							setActiveFocus('main');
							openCrossTabSearch();
						},
					} satisfies QuickAction,
				]
			: []),
		{
			id: 'searchFiles',
			label: 'Search: Files',
			subtext: 'Filter files in the file explorer',
			action: () => {
				setQuickActionOpen(false);
				setRightPanelOpen(true);
				setActiveRightTab('files');
				setActiveFocus('right');
				setTimeout(() => setFileTreeFilterOpen(true), 50);
			},
		},
		{
			id: 'searchHistory',
			label: 'Search: History',
			subtext: 'Search in the history panel',
			action: () => {
				setQuickActionOpen(false);
				setRightPanelOpen(true);
				setActiveRightTab('history');
				setActiveFocus('right');
				setTimeout(() => setHistorySearchFilterOpen(true), 50);
			},
		},
	];
}

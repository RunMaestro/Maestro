import type { QuickAction } from '../types';

interface BuildConcertoCommandsArgs {
	/** Concerto Encore Feature state - with it off, neither surface exists. */
	concertoEnabled: boolean;
	/** True while the Concerto stage window is up. */
	stageOpen: boolean;
	/** True while every cadenza card is stashed. */
	cadenzasHidden: boolean;
	toggleConcertoStage: () => void;
	toggleCadenzas: () => void;
	setQuickActionOpen: (open: boolean) => void;
	shortcuts: {
		toggleConcerto?: QuickAction['shortcut'];
		toggleCadenzas?: QuickAction['shortcut'];
	};
}

/**
 * Palette entries for the two Concerto surfaces.
 *
 * Both are toggles, and both are offered unconditionally while Concerto is on -
 * including when nothing is on stage. The palette is where a user goes to find a
 * surface they cannot see, so an entry that disappears exactly when they have
 * lost track of the window would be the wrong way round. Cadenzas get a hotkey
 * and a palette entry but no hamburger item on purpose: stashing floating cards
 * is an in-the-moment action, not a place you navigate to.
 */
export function buildConcertoCommands({
	concertoEnabled,
	stageOpen,
	cadenzasHidden,
	toggleConcertoStage,
	toggleCadenzas,
	setQuickActionOpen,
	shortcuts,
}: BuildConcertoCommandsArgs): QuickAction[] {
	if (!concertoEnabled) return [];

	return [
		{
			id: 'concerto-stage',
			label: stageOpen ? 'Hide Concerto Stage' : 'Show Concerto Stage',
			shortcut: shortcuts.toggleConcerto,
			subtext: stageOpen
				? 'Park the stage window - panels keep running'
				: 'Agent-composed interactive views, in one resizable window',
			action: () => {
				toggleConcertoStage();
				setQuickActionOpen(false);
			},
		},
		{
			id: 'concerto-cadenzas',
			label: cadenzasHidden ? 'Show All Cadenzas' : 'Hide All Cadenzas',
			shortcut: shortcuts.toggleCadenzas,
			subtext: cadenzasHidden
				? 'Bring back the stashed floating cards'
				: 'Stash every floating card without closing any of them',
			action: () => {
				toggleCadenzas();
				setQuickActionOpen(false);
			},
		},
	];
}

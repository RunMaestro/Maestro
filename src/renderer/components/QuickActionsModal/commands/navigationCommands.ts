import type { Session } from '../../../types';
import type { QuickAction } from '../types';
import { areUnreadFiltersActive, toggleAllUnreadFilters } from '../../../services/unreadFilters';
import { focusRegionDirection, focusRegionVertical } from '../../../services/regionFocus';
import { growFocusedRegion, shrinkFocusedRegion } from '../../../services/regionResize';
import { afterPaletteCloses } from '../utils/afterPaletteCloses';

interface BuildNavigationCommandsArgs {
	activeSession: Session | undefined;
	activeSessionId: string;
	setQuickActionOpen: (open: boolean) => void;
	setLeftSidebarOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
	setRightPanelOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
	addNewSession: () => void;
	deleteSession: (id: string) => void;
	openWizard?: () => void;
	getOpenInLabel: (platform: string) => string;
	platform: string;
	openPath?: (path: string) => void;
	// Shared with the Alt+Cmd+Down keyboard shortcut so both invocation paths
	// use the same sidebar-visible ordering and current-session clear semantics.
	onGoToNextUnread?: () => void;
	// Same callback the second press of Opt+Cmd+Up runs, so the palette entry
	// and the chord walk the same ordering.
	onGoToPreviousUnread?: () => void;
	// Shared with the Cmd+Shift+, / Cmd+Shift+. keyboard shortcuts so both paths
	// walk the same session/tab navigation history.
	onNavBack?: () => void;
	onNavForward?: () => void;
	/**
	 * uiStore's `toggleZenMode`, handed in as a thin arrow at the call site the
	 * same way `buildThroughputGaugeCommands` takes its store toggle. Keeps this
	 * builder a pure function of its arguments, so a test can pass a spy.
	 */
	toggleZenMode?: () => void;
	shortcuts: {
		newInstance?: QuickAction['shortcut'];
		openWizard?: QuickAction['shortcut'];
		toggleSidebar?: QuickAction['shortcut'];
		toggleRightPanel?: QuickAction['shortcut'];
		nextUnreadTab?: QuickAction['shortcut'];
		previousUnreadTab?: QuickAction['shortcut'];
		focusActiveTab?: QuickAction['shortcut'];
		toggleUnreadFilters?: QuickAction['shortcut'];
		killInstance?: QuickAction['shortcut'];
		navBack?: QuickAction['shortcut'];
		navForward?: QuickAction['shortcut'];
		focusRegionLeft?: QuickAction['shortcut'];
		focusRegionRight?: QuickAction['shortcut'];
		focusRegionUp?: QuickAction['shortcut'];
		focusRegionDown?: QuickAction['shortcut'];
		growRegion?: QuickAction['shortcut'];
		shrinkRegion?: QuickAction['shortcut'];
		toggleZenMode?: QuickAction['shortcut'];
	};
}

export function buildNavigationCommands({
	activeSession,
	activeSessionId,
	setQuickActionOpen,
	setLeftSidebarOpen,
	setRightPanelOpen,
	addNewSession,
	deleteSession,
	openWizard,
	getOpenInLabel,
	platform,
	openPath,
	onGoToNextUnread,
	onGoToPreviousUnread,
	onNavBack,
	onNavForward,
	toggleZenMode,
	shortcuts,
}: BuildNavigationCommandsArgs): QuickAction[] {
	const commands: QuickAction[] = [
		{
			id: 'new',
			label: 'Create New Agent',
			shortcut: shortcuts.newInstance,
			action: addNewSession,
		},
	];

	if (openWizard) {
		commands.push({
			id: 'wizard',
			label: 'New Agent Wizard',
			shortcut: shortcuts.openWizard,
			action: () => {
				openWizard();
				setQuickActionOpen(false);
			},
		});
	}

	commands.push(
		{
			id: 'toggleSidebar',
			label: 'Toggle Sidebar',
			shortcut: shortcuts.toggleSidebar,
			action: () => setLeftSidebarOpen((prev) => !prev),
		},
		{
			id: 'toggleRight',
			label: 'Toggle Right Panel',
			shortcut: shortcuts.toggleRightPanel,
			action: () => setRightPanelOpen((prev) => !prev),
		},
		{
			id: 'nextUnreadTab',
			label: 'Next Unread / Draft Tab',
			shortcut: shortcuts.nextUnreadTab,
			action: () => {
				// Delegate to the shared App.tsx callback so this matches the
				// Alt+Cmd+Down keyboard shortcut exactly (uses sortedSessions -
				// the sidebar's visible order - and the same clear semantics).
				onGoToNextUnread?.();
				setQuickActionOpen(false);
			},
		},
		{
			id: 'previousUnreadTab',
			label: 'Previous Unread / Draft Tab',
			// previousUnreadTab ships unbound, so name the chord that actually
			// reaches it today: Focus Active Tab pressed a second time.
			subtext: 'Walk backwards; also the second press of Focus Active Tab',
			shortcut: shortcuts.previousUnreadTab?.keys?.length
				? shortcuts.previousUnreadTab
				: shortcuts.focusActiveTab,
			action: () => {
				onGoToPreviousUnread?.();
				setQuickActionOpen(false);
			},
		},
		{
			// Zen mode sits beside the two toggles it composes. It hides BOTH bars
			// and puts them back exactly as they were, so the row reads as the
			// third rung of the same family rather than a separate feature.
			//
			// The label is fixed rather than state-named ("Zen Mode: Off", the shape
			// the unread filter row uses) because zen's entry flash tells the user to
			// "run Toggle Zen Mode again from Quick Actions". That sentence is the
			// only way back when no chord is bound, so this row has to still be
			// called Toggle Zen Mode while zen is ON, which is the one moment the
			// user will be searching for it.
			id: 'toggleZenMode',
			label: 'Toggle Zen Mode',
			subtext: 'Hide both side bars, or put them back as they were',
			shortcut: shortcuts.toggleZenMode,
			action: () => {
				setQuickActionOpen(false);
				// After the close: entering zen flashes the way out in the center of
				// the window, which the open palette would be sitting on top of.
				toggleZenMode?.();
			},
		},
		{
			// LEFT / RIGHT cross between regions and clamp at the ends; UP / DOWN
			// stay inside the focused region. `activeFocus` is what decides which
			// region that is, and opening the palette does not touch it, so these
			// act on wherever the user was before they hit Cmd+K.
			id: 'focusRegionLeft',
			label: 'Focus Region Left',
			subtext: 'Move focus one region left, stopping at the Left Bar',
			shortcut: shortcuts.focusRegionLeft,
			action: () => {
				setQuickActionOpen(false);
				afterPaletteCloses(() => focusRegionDirection('left'));
			},
		},
		{
			id: 'focusRegionRight',
			label: 'Focus Region Right',
			subtext: 'Move focus one region right, stopping at the Right Bar',
			shortcut: shortcuts.focusRegionRight,
			action: () => {
				setQuickActionOpen(false);
				afterPaletteCloses(() => focusRegionDirection('right'));
			},
		},
		{
			id: 'focusRegionUp',
			label: 'Focus Region Up',
			subtext: 'Up inside the focused region: the transcript, or one list row',
			shortcut: shortcuts.focusRegionUp,
			action: () => {
				setQuickActionOpen(false);
				afterPaletteCloses(() => focusRegionVertical('up'));
			},
		},
		{
			id: 'focusRegionDown',
			label: 'Focus Region Down',
			subtext: 'Down inside the focused region: the composer, or one list row',
			shortcut: shortcuts.focusRegionDown,
			action: () => {
				setQuickActionOpen(false);
				afterPaletteCloses(() => focusRegionVertical('down'));
			},
		},
		{
			// Grow and shrink need no deferral: they write a width through the
			// settings setters and never touch DOM focus, and the region they act on
			// comes from `activeFocus`, which the open palette leaves alone.
			id: 'growRegion',
			label: 'Grow Region',
			subtext: 'Widen the focused region by one step',
			shortcut: shortcuts.growRegion,
			action: () => {
				growFocusedRegion();
				setQuickActionOpen(false);
			},
		},
		{
			id: 'shrinkRegion',
			label: 'Shrink Region',
			subtext: 'Narrow the focused region by one step',
			shortcut: shortcuts.shrinkRegion,
			action: () => {
				shrinkFocusedRegion();
				setQuickActionOpen(false);
			},
		},
		{
			id: 'toggleUnreadFilters',
			// The label names the state this entry PUTS you in, not the state you
			// are in, so hitting it twice reads as a switch flipping back and
			// forth rather than a status line that argues with itself.
			label: areUnreadFiltersActive() ? 'Unread Only: Off' : 'Unread Only: On',
			subtext: 'Filter both the agent list and the tab bar to unread',
			shortcut: shortcuts.toggleUnreadFilters,
			action: () => {
				toggleAllUnreadFilters();
				setQuickActionOpen(false);
			},
		}
	);

	if (onNavBack) {
		commands.push({
			id: 'navBack',
			label: 'Navigate Back',
			shortcut: shortcuts.navBack,
			action: () => {
				onNavBack();
				setQuickActionOpen(false);
			},
		});
	}

	if (onNavForward) {
		commands.push({
			id: 'navForward',
			label: 'Navigate Forward',
			shortcut: shortcuts.navForward,
			action: () => {
				onNavForward();
				setQuickActionOpen(false);
			},
		});
	}

	if (activeSession && !activeSession.sshRemote) {
		commands.push({
			id: 'openWorkingDirectory',
			label: `${getOpenInLabel(platform)}: Working Directory`,
			subtext: activeSession.projectRoot,
			action: () => {
				openPath?.(activeSession.fullPath || activeSession.projectRoot);
				setQuickActionOpen(false);
			},
		});
	}

	if (activeSession) {
		commands.push({
			id: 'kill',
			label: `Remove Agent: ${activeSession.name}`,
			shortcut: shortcuts.killInstance,
			action: () => deleteSession(activeSessionId),
		});
	}

	return commands;
}

/**
 * The keyboard while the Main Window shows a Federation peer's mirrored agent.
 *
 * The mirror never replaces the local active agent: `activeSessionId` still names a LOCAL agent,
 * just hidden. So almost every shortcut the main handler knows (close tab, rename, star, git,
 * terminal, kill, model and effort, search, ...) would act on that hidden agent. This gate is an
 * ALLOWLIST, not a denylist: only shortcuts that never touch the active agent pass, so a shortcut
 * added later is off for a mirror until someone decides it is safe. A blocked chord is still
 * swallowed (`preventDefault`), so the browser default does not fire in its place either.
 *
 * Tab cycling is answered here, on the mirror's own tabs, instead of passing through. So are New
 * Tab and Toggle Tab Star (FED-SSH-06): they go to the host through the mirror service, the same
 * path as the controls beside the mirrored tab strip.
 */

import { FIXED_SHORTCUTS } from '../../constants/shortcuts';
import { usePeerMirrorStore } from '../../stores/peerMirrorStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { openMirrorTab, starMirrorTab } from '../../services/peerMirror';
import { resolveMirrorTabId } from '../../utils/peerMirrorView';

/**
 * Shortcuts that never read or write the active agent: they open a global surface, move between
 * agents (which leaves the mirror), or change a window-wide view preference.
 */
export const MIRROR_SAFE_SHORTCUT_IDS: readonly string[] = [
	'toggleSidebar',
	'cyclePrev',
	'cycleNext',
	'navBack',
	'navForward',
	'newInstance',
	'newGroupChat',
	'quickAction',
	'agentSwitcher',
	'help',
	'settings',
	'focusSidebar',
	'systemLogs',
	'processMonitor',
	'usageDashboard',
	'openSymphony',
	'directorNotes',
	'openCue',
	'computerHistory',
	'toggleConcerto',
	'toggleCadenzas',
	'toggleThroughputGauge',
	'filterUnreadAgents',
	'openWizard',
	'openMediaPlayer',
	'mediaPlayPause',
	'mediaNext',
	'mediaPrev',
	'openLeaderboard',
	'openNotificationCenter',
	'clearAllNotifications',
	'toggleInAppToasts',
	'openThemeSettings',
	'jumpToSession',
	'filterSessions',
	'fontSizeIncrease',
	'fontSizeDecrease',
	'fontSizeReset',
];

const TAB_CYCLE_IDS = ['prevTab', 'nextTab'] as const;

/** The matchers the main handler already holds (`useKeyboardShortcutHelpers`). */
export interface MirrorGateMatchers {
	isShortcut(e: KeyboardEvent, id: string): boolean;
	isTabShortcut(e: KeyboardEvent, id: string): boolean;
	/** A modal or overlay is open: the mirror's tabs are not what the keys are for. */
	hasOpenLayers?(): boolean;
}

/** `pass`: let the main handler run. `handled`/`blocked`: it must not see the event. */
export type MirrorKeyDecision = 'pass' | 'handled' | 'blocked';

/** Opt+Cmd+digit: jump to a local agent by its slot, which leaves the mirror. */
function isSessionJumpChord(e: KeyboardEvent): boolean {
	return e.altKey && (e.metaKey || e.ctrlKey) && /^Digit[0-9]$/.test(e.code || '');
}

/** Cmd+= / Cmd++ / Cmd+-: the window-wide font zoom, matched by key in the main handler. */
function isFontZoomChord(e: KeyboardEvent): boolean {
	return (e.metaKey || e.ctrlKey) && !e.altKey && ['+', '=', '-'].includes(e.key);
}

function matchesAnyBoundShortcut(e: KeyboardEvent, matchers: MirrorGateMatchers): boolean {
	const { shortcuts, tabShortcuts } = useSettingsStore.getState();
	for (const id of Object.keys(shortcuts)) if (matchers.isShortcut(e, id)) return true;
	for (const id of Object.keys(tabShortcuts)) if (matchers.isTabShortcut(e, id)) return true;
	for (const id of Object.keys(FIXED_SHORTCUTS)) if (matchers.isShortcut(e, id)) return true;
	return false;
}

/** Star or unstar the tab the mirrored agent shows, on its host. */
function toggleShownMirrorTabStar(peerId: string, agentId: string): void {
	const state = usePeerMirrorStore.getState();
	const agent = state.peers[peerId]?.agents.find((candidate) => candidate.id === agentId);
	if (!agent) return;
	const tabId = resolveMirrorTabId(agent, state.activeTabIds[peerId]?.[agentId]);
	const tab = agent.aiTabs?.find((candidate) => candidate.id === tabId);
	if (tab) void starMirrorTab(peerId, agentId, tab.id, !tab.starred);
}

/**
 * Decide what a keydown may do while a mirror is shown. Call only when one is
 * (`isMirrorShown()`); otherwise every key passes.
 */
export function gateKeyForMirror(
	e: KeyboardEvent,
	matchers: MirrorGateMatchers
): MirrorKeyDecision {
	if (!usePeerMirrorStore.getState().activeMirror) return 'pass';

	for (const id of TAB_CYCLE_IDS) {
		if (matchers.isTabShortcut(e, id)) {
			e.preventDefault();
			if (!matchers.hasOpenLayers?.()) {
				usePeerMirrorStore.getState().cycleMirrorTab(id === 'nextTab' ? 1 : -1);
			}
			return 'handled';
		}
	}

	const selection = usePeerMirrorStore.getState().activeMirror;
	if (selection && matchers.isTabShortcut(e, 'newTab')) {
		e.preventDefault();
		if (!matchers.hasOpenLayers?.()) void openMirrorTab(selection.peerId, selection.agentId);
		return 'handled';
	}
	if (selection && matchers.isShortcut(e, 'toggleTabStar')) {
		e.preventDefault();
		if (!matchers.hasOpenLayers?.()) toggleShownMirrorTabStar(selection.peerId, selection.agentId);
		return 'handled';
	}

	if (MIRROR_SAFE_SHORTCUT_IDS.some((id) => matchers.isShortcut(e, id))) return 'pass';
	if (isSessionJumpChord(e) || isFontZoomChord(e)) return 'pass';

	// A local shortcut: swallow it, so neither it nor a browser default runs. Anything else (plain
	// typing in the Left Bar filter, Cmd+C on a selection) is left to its target.
	if (matchesAnyBoundShortcut(e, matchers)) e.preventDefault();
	return 'blocked';
}

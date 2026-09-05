/**
 * unreadFilters - the two "show unread only" filters and the combined toggle.
 *
 * Maestro has two independent unread filters: one narrows the Left Bar to
 * agents with unread activity, the other narrows the tab bar to unread/draft
 * tabs. They are separate because each is useful alone, but sweeping a busy
 * fleet means turning both on, and doing that by hand is two chords in two
 * places.
 *
 * Everything reads the stores at call time rather than a render snapshot: the
 * palette, the keyboard shortcut, and the tab bar button all fire this from
 * different render trees, and a stale snapshot is the one way they could
 * disagree about which direction the toggle goes.
 */

import { selectActiveSession, useSessionStore } from '../stores/sessionStore';
import { useUIStore } from '../stores/uiStore';
import { aiTabFocusFields } from '../utils/tabHelpers';

/**
 * Toggle the tab-level unread filter, remembering the tab the user was on so
 * turning the filter back off returns them to it.
 */
export function toggleTabUnreadFilter(): void {
	const session = selectActiveSession(useSessionStore.getState());
	const { showUnreadOnly } = useUIStore.getState();

	if (!showUnreadOnly) {
		// Entering filter mode: save current active tab (only if in AI mode -
		// if the user is on a terminal/file tab we shouldn't force an AI restore on exit)
		const wasAiMode =
			session?.inputMode === 'ai' && !session?.activeTerminalTabId && !session?.activeFileTabId;
		useUIStore.getState().setPreFilterActiveTabId(wasAiMode ? session?.activeTabId || null : null);
	} else {
		// Exiting filter mode: restore previous active AI tab if one was saved and still exists
		const preFilterActiveTabId = useUIStore.getState().preFilterActiveTabId;
		if (preFilterActiveTabId && session) {
			const tabStillExists = session.aiTabs.some((t) => t.id === preFilterActiveTabId);
			if (tabStillExists) {
				useSessionStore.getState().setSessions((prev) =>
					prev.map((s) => {
						if (s.id !== session.id) return s;
						return { ...s, ...aiTabFocusFields(preFilterActiveTabId) };
					})
				);
			}
		}
		useUIStore.getState().setPreFilterActiveTabId(null);
	}
	useUIStore.getState().setShowUnreadOnly(!showUnreadOnly);
}

/**
 * Whether the combined filter counts as on.
 *
 * Both have to be on. Treating "either one" as on would strand the user: with
 * only the agent filter active the combined toggle would switch both OFF,
 * which is the opposite of what a half-filtered view asks for.
 */
export function areUnreadFiltersActive(): boolean {
	const { showUnreadOnly, showUnreadAgentsOnly } = useUIStore.getState();
	return showUnreadOnly && showUnreadAgentsOnly;
}

/**
 * Drive both unread filters to the same state in one action. Off unless both
 * are already on, so a half-filtered view completes rather than clears.
 */
export function toggleAllUnreadFilters(): void {
	const next = !areUnreadFiltersActive();
	const { showUnreadOnly, showUnreadAgentsOnly, setShowUnreadAgentsOnly } = useUIStore.getState();

	if (showUnreadAgentsOnly !== next) setShowUnreadAgentsOnly(next);
	// Routed through the toggle rather than setShowUnreadOnly so the tab filter
	// keeps its pre-filter tab save/restore.
	if (showUnreadOnly !== next) toggleTabUnreadFilter();
}

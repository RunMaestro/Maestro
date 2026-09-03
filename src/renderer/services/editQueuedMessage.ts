/**
 * editQueuedMessage - the single "edit the newest queued message" flow.
 *
 * Two surfaces offer it (the Cmd+Shift+E shortcut and the command palette's
 * "Edit Last Queued Message" entry) and both route here, so they cannot drift
 * on which item they pick, which tab they land on, or what they say when there
 * is nothing to edit.
 *
 * Everything is read from the stores at call time rather than from a render
 * snapshot: the pencil on a queued row reads live props, so a stale snapshot is
 * the one way this can disagree with the queue the user is looking at and claim
 * nothing is queued while a card sits on screen.
 */

import { selectActiveSession, updateSessionWith, useSessionStore } from '../stores/sessionStore';
import { useUIStore } from '../stores/uiStore';
import { notifyCenterFlash } from '../stores/centerFlashStore';
import { aiTabFocusFields, setActiveTab } from '../utils/tabHelpers';

/**
 * Open the edit modal on the newest queued message, reporting why not when
 * there is nothing to open it on. Returns true when a modal was opened, which
 * is what the keyboard path uses to decide whether the shortcut counts as used.
 */
export function requestEditLastQueuedMessage(): boolean {
	const session = selectActiveSession(useSessionStore.getState()) ?? undefined;
	const queue = session?.executionQueue ?? [];
	// Commands are the only thing skipped - they carry no editable prompt
	// text. Nothing else is filtered OUT: the queue the user sees is not
	// filtered by tab membership, so a filter here could only reject an
	// item Maestro is actively displaying.
	const editable = queue.filter((item) => item.type !== 'command');
	// An item whose tab is gone has no transcript to open the modal in, so
	// prefer items we can actually show. This RANKS rather than filters:
	// falling back to the full list keeps a missing tab from turning into
	// "nothing is queued".
	const renderable = editable.filter((item) =>
		session?.aiTabs?.some((tab) => tab.id === item.tabId)
	);
	const pool = renderable.length > 0 ? renderable : editable;
	// Prefer the tab on screen, else this agent's newest queued message on
	// any tab - the queue is agent-level and the status bar already
	// advertises it across tabs ("1 item queued - <tab name> - Click to view").
	const target =
		[...pool].reverse().find((item) => item.tabId === session?.activeTabId) ??
		pool[pool.length - 1];

	if (!session) {
		notifyCenterFlash({ message: 'No agent selected', color: 'yellow' });
		return false;
	}
	if (!target) {
		// Say WHICH empty this is. "No queued message" on a screen showing a
		// queued message is the least useful thing this can report.
		notifyCenterFlash({
			message: queue.length > 0 ? 'Only commands are queued' : 'Nothing queued to edit',
			color: 'yellow',
		});
		return false;
	}

	// The modal renders inside its OWN tab's transcript, so land there
	// first - whether the message belongs to another AI tab, or a
	// file/terminal/browser view is currently covering this one.
	// setActiveTab returns the session unchanged when we are already in
	// the right place, which is the check for whether to write at all;
	// the patch itself is applied against fresh state so this cannot
	// clobber a concurrent update with the snapshot read above.
	const switched = setActiveTab(session, target.tabId);
	if (switched && switched.session !== session) {
		updateSessionWith(session.id, (s) => ({ ...s, ...aiTabFocusFields(target.tabId) }));
	}
	useUIStore.getState().setEditingQueuedItemId(target.id);
	return true;
}

/**
 * tabWindowNavigation - the one redirect for navigation that names a popped-out
 * tab (Tab Windows, D4).
 *
 * A popped tab is not drawn in its owner window, so a toast click, a starred
 * row, `jumpToAgent` with a tab, or `focus-agent --tab` that names it must not
 * write the owner's active pointers (the owner would only re-pick away from it,
 * see `usePoppedOutTabGuard`). It shows the tab in its tab window instead.
 *
 * Every such call site calls {@link focusTabWindowIfPoppedOut} first and stops
 * when it answers true.
 */

import type { Session } from '../types';
import type { SingleTabRef } from '../../shared/unifiedTabRef';
import { isTabPoppedOut } from '../stores/tabWindowStore';
import { logger } from '../utils/logger';
import { captureException } from '../utils/sentry';

/**
 * When `ref` is popped out of `agentId`'s owner window, ask main to show it in
 * its tab window and raise that window, and return true. Return false (and do
 * nothing) when there is no ref, the tab is not popped out, or the build has
 * no tab windows (web-desktop, TW-13); the caller then navigates as usual.
 *
 * Answers synchronously from the renderer store, so the caller can skip its
 * own focus write in the same tick. A refusal from main is logged, not shown:
 * the store said the tab was popped, so main lagging one broadcast is the only
 * way to get here, and the next `tab-window-changed` corrects the store.
 */
export function focusTabWindowIfPoppedOut(
	agentId: string,
	ref: SingleTabRef | null | undefined
): boolean {
	if (!ref || !isTabPoppedOut(agentId, ref)) return false;
	const api = window.maestro?.tabWindows;
	if (!api) return false;
	api
		.focus(agentId, ref)
		.then((result) => {
			if (!result.focused) {
				logger.warn(`[TabWindows] Could not focus the tab window: ${result.error}`, undefined, {
					agentId,
					ref,
				});
			}
		})
		.catch((error: unknown) => {
			logger.error('[TabWindows] Could not focus the tab window', undefined, error);
			captureException(error instanceof Error ? error : new Error(String(error)), {
				extra: { operation: 'tabWindows.focus', agentId, tabType: ref.type },
			});
		});
	return true;
}

type SessionTabArrays = Pick<
	Session,
	'aiTabs' | 'filePreviewTabs' | 'terminalTabs' | 'browserTabs'
>;

/** Whether the agent still holds the tab `ref` names, in the array of its kind. */
export function sessionHasTab(session: SessionTabArrays, ref: SingleTabRef): boolean {
	const tabs: ReadonlyArray<{ id: string }> | undefined =
		ref.type === 'ai'
			? session.aiTabs
			: ref.type === 'file'
				? session.filePreviewTabs
				: ref.type === 'terminal'
					? session.terminalTabs
					: session.browserTabs;
	return tabs?.some((t) => t.id === ref.id) ?? false;
}

const SINGLE_TAB_TYPES: ReadonlyArray<SingleTabRef['type']> = ['ai', 'file', 'terminal', 'browser'];

/**
 * The ref of the tab with id `tabId` in any of the agent's four tab arrays, or
 * null. For callers that receive a bare tab id with no type (`focus-agent
 * --tab <id>`).
 */
export function findSessionTabRef(session: SessionTabArrays, tabId: string): SingleTabRef | null {
	for (const type of SINGLE_TAB_TYPES) {
		const ref: SingleTabRef = { type, id: tabId };
		if (sessionHasTab(session, ref)) return ref;
	}
	return null;
}

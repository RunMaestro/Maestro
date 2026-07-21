import { useMemo } from 'react';
import { useStoreWithEqualityFn } from 'zustand/traditional';
import type { Session } from '../../../types';
import { selectActiveSession, useSessionStore } from '../../../stores/sessionStore';
import { activeSessionChromeEquality } from '../../../stores/sessionEquality';
import { buildUnifiedTabs, getActiveTab } from '../../../utils/tabHelpers';
import type { TabDerivedState } from './types';

const EMPTY_TAB_DERIVED_STATE: TabDerivedState = {
	activeTab: undefined,
	unifiedTabs: [],
	activeFileTab: null,
	activeBrowserTab: null,
	isResumingSession: false,
	fileTabBackHistory: [],
	fileTabForwardHistory: [],
	fileTabCanGoBack: false,
	fileTabCanGoForward: false,
	activeFileTabNavIndex: -1,
};

/**
 * Pure derivation of tab-strip / file-nav paint state from a Session.
 * Leaves that already subscribe to the active session (e.g. MainPanel) should
 * call this instead of mounting another store subscription.
 */
export function getTabDerivedState(activeSession: Session | null | undefined): TabDerivedState {
	if (!activeSession) return EMPTY_TAB_DERIVED_STATE;

	const activeFileTab =
		activeSession.activeFileTabId != null
			? (activeSession.filePreviewTabs.find((tab) => tab.id === activeSession.activeFileTabId) ??
				null)
			: null;

	const activeFileTabHistory = activeFileTab?.navigationHistory ?? [];
	const activeFileTabNavIndex =
		activeFileTab?.navigationIndex ??
		(activeFileTabHistory.length > 0 ? activeFileTabHistory.length - 1 : -1);

	const activeTab = getActiveTab(activeSession);
	const activeBrowserTab =
		activeSession.activeBrowserTabId != null
			? (activeSession.browserTabs?.find((tab) => tab.id === activeSession.activeBrowserTabId) ??
				null)
			: null;

	return {
		activeTab,
		unifiedTabs: buildUnifiedTabs(activeSession),
		activeFileTab,
		activeBrowserTab,
		isResumingSession: !!activeTab?.agentSessionId,
		fileTabBackHistory: activeFileTabHistory.slice(0, activeFileTabNavIndex),
		fileTabForwardHistory: activeFileTabHistory.slice(activeFileTabNavIndex + 1),
		fileTabCanGoBack: activeFileTabNavIndex > 0,
		fileTabCanGoForward: activeFileTabNavIndex < activeFileTabHistory.length - 1,
		activeFileTabNavIndex,
	};
}

/**
 * Store-subscribed variant for hosts that do not already hold the active session.
 * Uses chrome equality so log/token flushes do not wake the host.
 *
 * Prefer {@link getTabDerivedState} inside MainPanel (already full-session subscribed).
 * Do not mount this from MaestroConsoleInner / App - that reintroduces the chrome wake.
 */
export function useTabDerivedState(): TabDerivedState {
	const activeSession = useStoreWithEqualityFn(
		useSessionStore,
		selectActiveSession,
		activeSessionChromeEquality
	);

	return useMemo(() => getTabDerivedState(activeSession), [activeSession]);
}

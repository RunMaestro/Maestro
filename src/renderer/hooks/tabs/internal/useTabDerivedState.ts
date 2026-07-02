import { useMemo } from 'react';
import { selectActiveSession, useSessionStore } from '../../../stores/sessionStore';
import type { BrowserTab, FilePreviewTab, UnifiedTab } from '../../../types';
import { buildUnifiedTabs, getActiveTab } from '../../../utils/tabHelpers';
import type { TabDerivedState } from './types';

export function useTabDerivedState(): TabDerivedState {
	const activeSession = useSessionStore(selectActiveSession);

	const activeFileTabHistory = useMemo(() => {
		if (!activeSession?.activeFileTabId) return [];
		const tab = activeSession.filePreviewTabs.find((t) => t.id === activeSession.activeFileTabId);
		return tab?.navigationHistory ?? [];
	}, [activeSession?.activeFileTabId, activeSession?.filePreviewTabs]);

	const activeFileTabNavIndex = useMemo(() => {
		if (!activeSession?.activeFileTabId) return -1;
		const tab = activeSession.filePreviewTabs.find((t) => t.id === activeSession.activeFileTabId);
		return tab?.navigationIndex ?? (tab?.navigationHistory?.length ?? 0) - 1;
	}, [activeSession?.activeFileTabId, activeSession?.filePreviewTabs]);

	const fileTabBackHistory = useMemo(
		() => activeFileTabHistory.slice(0, activeFileTabNavIndex),
		[activeFileTabHistory, activeFileTabNavIndex]
	);
	const fileTabForwardHistory = useMemo(
		() => activeFileTabHistory.slice(activeFileTabNavIndex + 1),
		[activeFileTabHistory, activeFileTabNavIndex]
	);

	const activeTab = useMemo(
		() => (activeSession ? getActiveTab(activeSession) : undefined),
		[activeSession?.aiTabs, activeSession?.activeTabId]
	);

	const unifiedTabs = useMemo((): UnifiedTab[] => {
		if (!activeSession) return [];
		return buildUnifiedTabs(activeSession);
	}, [
		activeSession?.aiTabs,
		activeSession?.filePreviewTabs,
		activeSession?.terminalTabs,
		activeSession?.browserTabs,
		activeSession?.unifiedTabOrder,
		// tabGroups gates which tabs are hidden (tiled members fold into the group chip),
		// so a group create/dissolve must recompute the strip.
		activeSession?.tabGroups,
	]);

	const activeFileTab = useMemo((): FilePreviewTab | null => {
		if (!activeSession?.activeFileTabId) return null;
		return (
			activeSession.filePreviewTabs.find((tab) => tab.id === activeSession.activeFileTabId) ?? null
		);
	}, [activeSession?.activeFileTabId, activeSession?.filePreviewTabs]);

	const activeBrowserTab = useMemo((): BrowserTab | null => {
		if (!activeSession?.activeBrowserTabId) return null;
		return (
			activeSession.browserTabs?.find((tab) => tab.id === activeSession.activeBrowserTabId) ?? null
		);
	}, [activeSession?.activeBrowserTabId, activeSession?.browserTabs]);

	return {
		activeTab,
		unifiedTabs,
		activeFileTab,
		activeBrowserTab,
		isResumingSession: !!activeTab?.agentSessionId,
		fileTabBackHistory,
		fileTabForwardHistory,
		fileTabCanGoBack: activeFileTabNavIndex > 0,
		fileTabCanGoForward: activeFileTabNavIndex < activeFileTabHistory.length - 1,
		activeFileTabNavIndex,
	};
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { InlineWizardState, PreviousUIState, SetInlineWizardTabState } from './types';
import { initialInlineWizardState } from './state';
import type { InlineWizardConversationSession } from '../../../services/inlineWizardConversation';

export function useInlineWizardTabState() {
	// Per-tab wizard states - Map from tabId to wizard state.
	const [tabStates, setTabStates] = useState<Map<string, InlineWizardState>>(new Map());

	// Track the "current" tab for backward compatibility with existing return values.
	const [currentTabId, setCurrentTabId] = useState<string | null>(null);

	const state = currentTabId
		? (tabStates.get(currentTabId) ?? initialInlineWizardState)
		: initialInlineWizardState;

	const tabStatesRef = useRef<Map<string, InlineWizardState>>(tabStates);
	useEffect(() => {
		tabStatesRef.current = tabStates;
	}, [tabStates]);

	const previousUIStateRefsMap = useRef<Map<string, PreviousUIState | null>>(new Map());
	const conversationSessionsMap = useRef<Map<string, InlineWizardConversationSession>>(new Map());

	const setTabState: SetInlineWizardTabState = useCallback((tabId, updater) => {
		setTabStates((prevMap) => {
			const newMap = new Map(prevMap);
			const prevState = newMap.get(tabId) ?? initialInlineWizardState;
			newMap.set(tabId, updater(prevState));
			return newMap;
		});
	}, []);

	const getStateForTab = useCallback(
		(tabId: string): InlineWizardState | undefined => {
			return tabStates.get(tabId);
		},
		[tabStates]
	);

	const isWizardActiveForTab = useCallback(
		(tabId: string): boolean => {
			const tabState = tabStates.get(tabId);
			return tabState?.isActive ?? false;
		},
		[tabStates]
	);

	const getEffectiveTabId = useCallback(() => {
		const tabId = currentTabId || 'default';
		if (tabId !== currentTabId) {
			setCurrentTabId(tabId);
		}
		return tabId;
	}, [currentTabId]);

	const wizardActiveSessions = useMemo(() => {
		const map = new Map<string, { isGeneratingDocs: boolean }>();
		for (const tabState of tabStates.values()) {
			if (!tabState.isActive || !tabState.sessionId) continue;
			const existing = map.get(tabState.sessionId);
			map.set(tabState.sessionId, {
				isGeneratingDocs: (existing?.isGeneratingDocs ?? false) || tabState.isGeneratingDocs,
			});
		}
		return map;
	}, [tabStates]);

	return {
		tabStates,
		setTabStates,
		currentTabId,
		setCurrentTabId,
		state,
		tabStatesRef,
		previousUIStateRefsMap,
		conversationSessionsMap,
		setTabState,
		getStateForTab,
		isWizardActiveForTab,
		getEffectiveTabId,
		wizardActiveSessions,
	};
}

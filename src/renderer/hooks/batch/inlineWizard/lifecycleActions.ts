import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import {
	endInlineWizardConversation,
	type InlineWizardConversationSession,
} from '../../../services/inlineWizardConversation';
import { logger } from '../../../utils/logger';
import { captureException } from '../../../utils/sentry';
import type { InlineWizardState, PreviousUIState } from './types';

interface UseInlineWizardLifecycleActionsParams {
	currentTabId: string | null;
	setTabStates: Dispatch<SetStateAction<Map<string, InlineWizardState>>>;
	previousUIStateRefsMap: MutableRefObject<Map<string, PreviousUIState | null>>;
	conversationSessionsMap: MutableRefObject<Map<string, InlineWizardConversationSession>>;
}

export function useInlineWizardLifecycleActions({
	currentTabId,
	setTabStates,
	previousUIStateRefsMap,
	conversationSessionsMap,
}: UseInlineWizardLifecycleActionsParams) {
	const endWizard = useCallback(
		async (explicitTabId?: string): Promise<PreviousUIState | null> => {
			// Prefer an explicit tab id from the caller because currentTabId tracks the last-touched wizard.
			const tabId = explicitTabId || currentTabId || 'default';

			const previousState = previousUIStateRefsMap.current.get(tabId) || null;
			previousUIStateRefsMap.current.delete(tabId);

			// Drop wizard state synchronously before awaiting process cleanup.
			setTabStates((prevMap) => {
				if (!prevMap.has(tabId)) return prevMap;
				const newMap = new Map(prevMap);
				newMap.delete(tabId);
				return newMap;
			});

			const session = conversationSessionsMap.current.get(tabId);
			if (session) {
				try {
					await endInlineWizardConversation(session);
					logger.info(`Wizard conversation ended`, '[InlineWizard]', {
						tabId,
						sessionId: session.sessionId,
					});
				} catch (error) {
					logger.warn('[useInlineWizard] Failed to end conversation session:', undefined, error);
					captureException(error, {
						extra: {
							context: 'inlineWizard.endWizard.cleanup',
							tabId,
							sessionId: session.sessionId,
						},
					});
				}
				conversationSessionsMap.current.delete(tabId);
			}

			return previousState;
		},
		[currentTabId, conversationSessionsMap, previousUIStateRefsMap, setTabStates]
	);

	const reset = useCallback(() => {
		const tabId = currentTabId || 'default';

		const session = conversationSessionsMap.current.get(tabId);
		if (session) {
			endInlineWizardConversation(session).catch((error) => {
				logger.warn('[useInlineWizard] Failed to reset conversation session:', undefined, error);
				captureException(error, {
					extra: {
						context: 'inlineWizard.reset.cleanup',
						tabId,
						sessionId: session.sessionId,
					},
				});
			});
			conversationSessionsMap.current.delete(tabId);
		}

		previousUIStateRefsMap.current.delete(tabId);

		setTabStates((prevMap) => {
			const newMap = new Map(prevMap);
			newMap.delete(tabId);
			return newMap;
		});
	}, [conversationSessionsMap, currentTabId, previousUIStateRefsMap, setTabStates]);

	return {
		endWizard,
		reset,
	};
}

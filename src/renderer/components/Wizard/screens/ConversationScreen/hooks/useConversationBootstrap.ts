import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { WizardMessage } from '../../../WizardContext';
import { conversationManager } from '../../../services/conversationManager';
import { logger } from '../../../../../utils/logger';
import { captureException } from '../../../../../utils/sentry';
import { fetchExistingDocsForWizard } from '../utils/existingDocs';
import type { WizardConversationState } from '../types';

export function useConversationBootstrap({
	state,
	conversationStarted,
	setConversationStarted,
	setShowInitialQuestion,
	initialQuestionAddedRef,
	setConversationError,
}: {
	state: WizardConversationState;
	conversationStarted: boolean;
	setConversationStarted: Dispatch<SetStateAction<boolean>>;
	setShowInitialQuestion: Dispatch<SetStateAction<boolean>>;
	initialQuestionAddedRef: MutableRefObject<boolean>;
	setConversationError: (error: string | null) => void;
}): void {
	useEffect(() => {
		let mounted = true;

		async function initConversation() {
			if (!state.selectedAgent || !state.directoryPath) {
				return;
			}

			try {
				const existingDocs = await fetchExistingDocsForWizard(
					state.directoryPath,
					state.existingDocsChoice
				);

				await conversationManager.startConversation({
					agentType: state.selectedAgent,
					directoryPath: state.directoryPath,
					projectName: state.agentName || 'My Project',
					existingDocs: existingDocs.length > 0 ? existingDocs : undefined,
					sshRemoteConfig: state.sessionSshRemoteConfig,
					customPath: state.customPath,
					customArgs: state.customArgs,
					customEnvVars: state.customEnvVars,
					agentConfigValues: state.agentConfigValues,
				});

				if (mounted) {
					setConversationStarted(true);
				}
			} catch (error) {
				logger.error('Failed to initialize conversation:', undefined, error);
				captureException(error, {
					level: 'error',
					tags: { area: 'conversation_bootstrap' },
					extra: {
						mounted,
						selectedAgent: state.selectedAgent,
						directoryPath: state.directoryPath,
						agentName: state.agentName,
						existingDocsChoice: state.existingDocsChoice,
						conversationHistoryLength: state.conversationHistory.length,
						hasSshRemoteConfig: !!state.sessionSshRemoteConfig,
						sshRemoteId: state.sessionSshRemoteConfig?.remoteId ?? null,
					},
				});
				if (mounted) {
					setConversationError('Failed to initialize conversation. Please try again.');
				}
			}
		}

		if (!conversationStarted && state.conversationHistory.length === 0) {
			initConversation();
		} else {
			setConversationStarted(true);
			if (state.conversationHistory.length > 0) {
				setShowInitialQuestion(false);
				initialQuestionAddedRef.current = true;
			}
		}

		return () => {
			mounted = false;
		};
	}, [
		state.selectedAgent,
		state.directoryPath,
		state.agentName,
		state.conversationHistory.length,
		state.existingDocsChoice,
		state.sessionSshRemoteConfig,
		state.customPath,
		state.customArgs,
		state.customEnvVars,
		state.agentConfigValues,
		conversationStarted,
		setConversationStarted,
		setShowInitialQuestion,
		setConversationError,
		initialQuestionAddedRef,
	]);

	useEffect(() => {
		return () => {
			conversationManager.endConversation();
		};
	}, []);
}

export type ConversationBootstrapState = WizardConversationState & {
	conversationHistory: WizardMessage[];
};

/**
 * useInlineWizard.ts
 *
 * Public composer for inline wizard state within an agent tab.
 * Internals live in ./inlineWizard so state storage, lifecycle, conversation,
 * simple setters, and document generation stay independently testable.
 */

import { READY_CONFIDENCE_THRESHOLD } from '../../services/inlineWizardConversation';
import { useInlineWizardConversationActions } from './inlineWizard/conversationActions';
import { useInlineWizardGenerationActions } from './inlineWizard/generationActions';
import { useInlineWizardLifecycleActions } from './inlineWizard/lifecycleActions';
import { useInlineWizardSimpleActions } from './inlineWizard/simpleActions';
import { useInlineWizardTabState } from './inlineWizard/useInlineWizardTabState';
import type { UseInlineWizardReturn } from './inlineWizard/types';

export type {
	GenerationProgress,
	InlineGeneratedDocument,
	InlineWizardMessage,
	InlineWizardMode,
	InlineWizardSessionOverrides,
	InlineWizardSshRemoteConfig,
	InlineWizardState,
	PreviousUIState,
	UseInlineWizardReturn,
} from './inlineWizard/types';

export function useInlineWizard(): UseInlineWizardReturn {
	const {
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
	} = useInlineWizardTabState();

	const {
		setConfidence,
		setGoal,
		setGeneratingDocs,
		setGeneratedDocuments,
		setExistingDocuments,
		setError,
		clearError,
	} = useInlineWizardSimpleActions({
		getEffectiveTabId,
		setTabState,
	});

	const { endWizard, reset } = useInlineWizardLifecycleActions({
		currentTabId,
		setTabStates,
		previousUIStateRefsMap,
		conversationSessionsMap,
	});

	const {
		startWizard,
		sendMessage,
		addAssistantMessage,
		setMode,
		retryLastMessage,
		clearConversation,
	} = useInlineWizardConversationActions({
		currentTabId,
		setCurrentTabId,
		tabStatesRef,
		previousUIStateRefsMap,
		conversationSessionsMap,
		setTabState,
		getEffectiveTabId,
	});

	const { generateDocuments } = useInlineWizardGenerationActions({
		currentTabId,
		setCurrentTabId,
		tabStatesRef,
		setTabState,
	});

	const readyToGenerate = state.ready && state.confidence >= READY_CONFIDENCE_THRESHOLD;

	return {
		isWizardActive: state.isActive,
		isInitializing: state.isInitializing,
		isWaiting: state.isWaiting,
		wizardMode: state.mode,
		wizardGoal: state.goal,
		confidence: state.confidence,
		ready: state.ready,
		readyToGenerate,
		conversationHistory: state.conversationHistory,
		isGeneratingDocs: state.isGeneratingDocs,
		generatedDocuments: state.generatedDocuments,
		existingDocuments: state.existingDocuments,
		error: state.error,
		streamingContent: state.streamingContent,
		generationProgress: state.generationProgress,
		wizardTabId: state.tabId,
		agentSessionId: state.agentSessionId,
		state,
		getStateForTab,
		isWizardActiveForTab,
		wizardActiveSessions,
		startWizard,
		endWizard,
		sendMessage,
		selectWizardTab: setCurrentTabId,
		setConfidence,
		setMode,
		setGoal,
		setGeneratingDocs,
		setGeneratedDocuments,
		setExistingDocuments,
		setError,
		clearError,
		retryLastMessage,
		addAssistantMessage,
		clearConversation,
		reset,
		generateDocuments,
	};
}

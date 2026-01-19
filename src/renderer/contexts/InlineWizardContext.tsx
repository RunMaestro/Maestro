/**
 * InlineWizardContext - Context provider for inline wizard state management
 *
 * This context wraps the useInlineWizard hook to provide cross-component access
 * to inline wizard state. The inline wizard is triggered by the `/wizard` slash
 * command and allows users to create or iterate on Auto Run documents within
 * their existing session context.
 *
 * Unlike the full-screen onboarding wizard (MaestroWizard.tsx), this wizard
 * runs inline within the existing AI conversation interface.
 *
 * States managed:
 * - isActive: Whether the wizard is currently active
 * - mode: Current wizard mode ('new' | 'iterate' | 'ask' | null)
 * - goal: Goal for iterate mode (what the user wants to add/change)
 * - confidence: Confidence level from agent responses (0-100)
 * - isGeneratingDocs: Whether documents are being generated
 * - generatedDocuments: Generated documents (if any)
 * - previousUIState: Previous UI state to restore when wizard ends
 *
 * Usage:
 * 1. Wrap App with InlineWizardProvider
 * 2. Access wizard state via useInlineWizardContext() hook
 */

import React, { createContext, useContext, useMemo, ReactNode } from 'react';
import {
	useInlineWizard,
	type UseInlineWizardReturn,
	type InlineWizardState,
	type InlineWizardMode,
	type InlineWizardMessage,
	type InlineGeneratedDocument,
	type PreviousUIState,
} from '../hooks/useInlineWizard';

/**
 * Context value type - exposes the full useInlineWizard return value
 */
export type InlineWizardContextValue = UseInlineWizardReturn;

// Create context with null as default (will throw if used outside provider)
const InlineWizardContext = createContext<InlineWizardContextValue | null>(null);

interface InlineWizardProviderProps {
	children: ReactNode;
}

/**
 * InlineWizardProvider - Provides centralized inline wizard state management
 *
 * This provider wraps the useInlineWizard hook to make wizard state available
 * throughout the component tree without prop drilling.
 *
 * The provider should be added near the root of the app, alongside other
 * context providers like SessionProvider, AutoRunProvider, etc.
 *
 * Usage:
 * ```tsx
 * <SessionProvider>
 *   <AutoRunProvider>
 *     <GroupChatProvider>
 *       <InlineWizardProvider>
 *         <InputProvider>
 *           <MaestroConsoleInner />
 *         </InputProvider>
 *       </InlineWizardProvider>
 *     </GroupChatProvider>
 *   </AutoRunProvider>
 * </SessionProvider>
 * ```
 */
export function InlineWizardProvider({ children }: InlineWizardProviderProps) {
	// Use the inline wizard hook
	const wizardState = useInlineWizard();

	// Memoize the context value to prevent unnecessary re-renders
	// The useInlineWizard hook already memoizes its return value,
	// but we wrap it here for safety
	const value = useMemo<InlineWizardContextValue>(
		() => wizardState,
		[
			// Dependencies from the wizard state
			wizardState.isWizardActive,
			wizardState.isInitializing,
			wizardState.isWaiting,
			wizardState.wizardMode,
			wizardState.wizardGoal,
			wizardState.confidence,
			wizardState.ready,
			wizardState.readyToGenerate,
			wizardState.conversationHistory,
			wizardState.isGeneratingDocs,
			wizardState.generatedDocuments,
			wizardState.existingDocuments,
			wizardState.error,
			wizardState.state,
			// Actions (stable references from useCallback)
			wizardState.startWizard,
			wizardState.endWizard,
			wizardState.sendMessage,
			wizardState.setConfidence,
			wizardState.setMode,
			wizardState.setGoal,
			wizardState.setGeneratingDocs,
			wizardState.setGeneratedDocuments,
			wizardState.setExistingDocuments,
			wizardState.setError,
			wizardState.clearError,
			wizardState.retryLastMessage,
			wizardState.addAssistantMessage,
			wizardState.clearConversation,
			wizardState.reset,
			wizardState.generateDocuments,
			wizardState.streamingContent,
			wizardState.generationProgress,
			wizardState.wizardTabId,
		]
	);

	return <InlineWizardContext.Provider value={value}>{children}</InlineWizardContext.Provider>;
}

/**
 * useInlineWizardContext - Hook to access inline wizard state management
 *
 * Must be used within an InlineWizardProvider. Throws an error if used outside.
 *
 * @returns InlineWizardContextValue - All inline wizard states and actions
 *
 * @example
 * // Access wizard state
 * const { isWizardActive, wizardMode, confidence } = useInlineWizardContext();
 *
 * @example
 * // Start the wizard
 * const { startWizard } = useInlineWizardContext();
 * startWizard('add authentication to my app', {
 *   readOnlyMode: true,
 *   saveToHistory: false,
 *   showThinking: false
 * });
 *
 * @example
 * // End wizard and restore UI state
 * const { endWizard } = useInlineWizardContext();
 * const previousState = endWizard();
 * if (previousState) {
 *   setReadOnlyMode(previousState.readOnlyMode);
 *   setSaveToHistory(previousState.saveToHistory);
 * }
 *
 * @example
 * // Check if wizard should intercept input
 * const { isWizardActive, sendMessage } = useInlineWizardContext();
 * if (isWizardActive) {
 *   sendMessage(userInput);
 * }
 */
export function useInlineWizardContext(): InlineWizardContextValue {
	const context = useContext(InlineWizardContext);

	if (!context) {
		throw new Error('useInlineWizardContext must be used within an InlineWizardProvider');
	}

	return context;
}

// Re-export types for convenience
export type {
	InlineWizardState,
	InlineWizardMode,
	InlineWizardMessage,
	InlineGeneratedDocument,
	PreviousUIState,
};

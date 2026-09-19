import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { Theme, ToolType } from '../../../../types';
import type { WizardMessage, WizardState } from '../../WizardContext';
import type { WizardError } from '../../services/wizardErrorDetection';

export interface ConversationScreenProps {
	theme: Theme;
	/** Whether to show AI thinking content instead of filler phrases */
	showThinking: boolean;
	/** Callback to toggle thinking display, controlled by parent for global shortcut */
	setShowThinking: Dispatch<SetStateAction<boolean>>;
}

export interface ToolExecutionEvent {
	toolName: string;
	state?: unknown;
	timestamp: number;
}

export interface ConversationRenderState {
	messages: WizardMessage[];
	confidenceLevel: number;
	isReadyToProceed: boolean;
	isConversationLoading: boolean;
	conversationError: string | null;
	selectedAgent: ToolType | null;
	agentName: string;
}

export interface ConversationRefs {
	inputRef: MutableRefObject<HTMLTextAreaElement | null>;
	isSendingRef: MutableRefObject<boolean>;
	initialQuestionAddedRef: MutableRefObject<boolean>;
	autoContinueTriggeredRef: MutableRefObject<boolean>;
	showThinkingRef: MutableRefObject<boolean>;
}

export interface SendStateSetters {
	setInputValue: Dispatch<SetStateAction<string>>;
	setShowInitialQuestion: Dispatch<SetStateAction<boolean>>;
	setStreamingText: Dispatch<SetStateAction<string>>;
	setFillerPhrase: Dispatch<SetStateAction<string>>;
	setDetectedError: Dispatch<SetStateAction<WizardError | null>>;
	setThinkingContent: Dispatch<SetStateAction<string>>;
	setToolExecutions: Dispatch<SetStateAction<ToolExecutionEvent[]>>;
	setErrorRetryCount: Dispatch<SetStateAction<number>>;
}

export type WizardConversationState = Pick<
	WizardState,
	| 'selectedAgent'
	| 'directoryPath'
	| 'agentName'
	| 'conversationHistory'
	| 'isConversationLoading'
	| 'existingDocsChoice'
	| 'sessionSshRemoteConfig'
	| 'customPath'
	| 'customArgs'
	| 'customEnvVars'
	| 'agentConfigValues'
>;

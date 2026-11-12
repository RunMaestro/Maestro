import { generateId } from '../../../utils/ids';
import type { InlineWizardState } from './types';

/**
 * Generate a unique message ID.
 */
export function generateMessageId(): string {
	return `iwm-${generateId()}`;
}

/**
 * Initial wizard state.
 */
export const initialInlineWizardState: InlineWizardState = {
	isActive: false,
	isInitializing: false,
	isWaiting: false,
	mode: null,
	goal: null,
	confidence: 0,
	ready: false,
	extractedProjectName: null,
	conversationHistory: [],
	isGeneratingDocs: false,
	generatedDocuments: [],
	existingDocuments: [],
	previousUIState: null,
	error: null,
	lastUserMessageContent: null,
	projectPath: null,
	agentType: null,
	sessionName: null,
	tabId: null,
	sessionId: null,
	streamingContent: '',
	generationProgress: null,
	currentDocumentIndex: 0,
	agentSessionId: null,
	subfolderName: null,
	subfolderPath: null,
	autoRunFolderPath: null,
};

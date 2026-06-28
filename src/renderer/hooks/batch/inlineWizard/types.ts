import type { ExistingDocument } from '../../../utils/existingDocsDetector';
import type { ToolType, ThinkingMode } from '../../../types';
import type { ConversationCallbacks } from '../../../services/inlineWizardConversation';
import type { DocumentGenerationCallbacks } from '../../../services/inlineWizardDocumentGeneration';

/**
 * Wizard mode determines whether the user wants to create new documents
 * or iterate on existing ones.
 */
export type InlineWizardMode = 'new' | 'iterate' | 'ask' | null;

/**
 * Message in the wizard conversation.
 * Simplified version of WizardMessage from onboarding wizard.
 */
export interface InlineWizardMessage {
	id: string;
	role: 'user' | 'assistant' | 'system';
	content: string;
	timestamp: number;
	/** Parsed confidence from assistant responses */
	confidence?: number;
	/** Parsed ready flag from assistant responses */
	ready?: boolean;
	/** Base64-encoded image data URLs attached to this message */
	images?: string[];
}

/**
 * UI state to restore when wizard ends.
 * These settings are temporarily overridden during wizard mode.
 */
export interface PreviousUIState {
	readOnlyMode: boolean;
	saveToHistory: boolean;
	showThinking: ThinkingMode;
}

/**
 * Generated document from the wizard.
 */
export interface InlineGeneratedDocument {
	filename: string;
	content: string;
	taskCount: number;
	/** Absolute path after saving */
	savedPath?: string;
}

/**
 * Progress tracking for document generation.
 * Used to display "Generating Phase 1 of 3..." during generation.
 */
export interface GenerationProgress {
	/** Current document being generated (1-indexed for display) */
	current: number;
	/** Total number of documents to generate */
	total: number;
}

export interface InlineWizardSshRemoteConfig {
	enabled: boolean;
	remoteId: string | null;
	workingDirOverride?: string;
}

export interface InlineWizardSessionOverrides {
	customPath?: string;
	customArgs?: string;
	customEnvVars?: Record<string, string>;
	customModel?: string;
}

/**
 * State shape for the inline wizard.
 */
export interface InlineWizardState {
	/** Whether wizard is currently active */
	isActive: boolean;
	/** Whether wizard is initializing (checking for existing docs, parsing intent) */
	isInitializing: boolean;
	/** Whether waiting for AI response */
	isWaiting: boolean;
	/** Current wizard mode */
	mode: InlineWizardMode;
	/** Goal for iterate mode (what the user wants to add/change) */
	goal: string | null;
	/** Confidence level from agent responses (0-100) */
	confidence: number;
	/** Whether the AI is ready to proceed with document generation */
	ready: boolean;
	/**
	 * Short human-readable name for the playbook, extracted from the wizard
	 * conversation (e.g. "HTML Chat Interface"). Updated as the AI refines its
	 * understanding. Used to name the playbook subfolder; falls back to
	 * sessionName when absent so we never block generation on a missing field.
	 */
	extractedProjectName: string | null;
	/** Conversation history for this wizard session */
	conversationHistory: InlineWizardMessage[];
	/** Whether documents are being generated */
	isGeneratingDocs: boolean;
	/** Wall-clock timestamp (ms) when document generation started; persisted so elapsed time survives tab switches */
	docGenerationStartedAt?: number;
	/** Generated documents (if any) */
	generatedDocuments: InlineGeneratedDocument[];
	/** Existing Auto Run documents loaded for iterate mode context */
	existingDocuments: ExistingDocument[];
	/** Previous UI state to restore when wizard ends */
	previousUIState: PreviousUIState | null;
	/** Error message if something goes wrong */
	error: string | null;
	/** Last user message content (for retry functionality) */
	lastUserMessageContent: string | null;
	/** Project path used for document detection */
	projectPath: string | null;
	/** Agent type for the session */
	agentType: ToolType | null;
	/** Session name/project name */
	sessionName: string | null;
	/** Tab ID the wizard was started on (for per-tab isolation) */
	tabId: string | null;
	/** Session ID for playbook creation */
	sessionId: string | null;
	/** Streaming content being generated (accumulates as AI outputs) */
	streamingContent: string;
	/** Progress tracking for document generation */
	generationProgress: GenerationProgress | null;
	/** Currently selected document index (for DocumentGenerationView) */
	currentDocumentIndex: number;
	/** The Claude agent session ID (from session_id in output) - used to switch tab after wizard completes */
	agentSessionId: string | null;
	/** Subfolder name where documents were saved (e.g., "Maestro-Marketing") - used for tab naming after wizard completes */
	subfolderName: string | null;
	/** Full path to the subfolder where documents are saved (e.g., "/path/Auto Run Docs/Maestro-Marketing") */
	subfolderPath: string | null;
	/** User-configured Auto Run folder path (overrides default projectPath/Auto Run Docs) */
	autoRunFolderPath: string | null;
	/** SSH remote configuration (for remote execution) */
	sessionSshRemoteConfig?: InlineWizardSshRemoteConfig;
	/** Custom path to agent binary */
	sessionCustomPath?: string;
	/** Custom CLI arguments */
	sessionCustomArgs?: string;
	/** Custom environment variables */
	sessionCustomEnvVars?: Record<string, string>;
	/** Custom model ID */
	sessionCustomModel?: string;
	/** Conductor profile (user's About Me from settings) */
	conductorProfile?: string;
	/** History file path for task recall (fetched once during startWizard) */
	historyFilePath?: string;
}

export type SetInlineWizardTabState = (
	tabId: string,
	updater: (prev: InlineWizardState) => InlineWizardState
) => void;

/**
 * Return type for useInlineWizard hook.
 */
export interface UseInlineWizardReturn {
	/** Whether the wizard is currently active (for the current active tab) */
	isWizardActive: boolean;
	/** Whether the wizard is initializing (checking for existing docs, parsing intent) */
	isInitializing: boolean;
	/** Whether waiting for AI response */
	isWaiting: boolean;
	/** Current wizard mode */
	wizardMode: InlineWizardMode;
	/** Goal for iterate mode */
	wizardGoal: string | null;
	/** Current confidence level (0-100) */
	confidence: number;
	/** Whether the AI is ready to proceed with document generation */
	ready: boolean;
	/** Whether the wizard is ready to generate documents (ready=true && confidence >= threshold) */
	readyToGenerate: boolean;
	/** Conversation history */
	conversationHistory: InlineWizardMessage[];
	/** Whether documents are being generated */
	isGeneratingDocs: boolean;
	/** Generated documents */
	generatedDocuments: InlineGeneratedDocument[];
	/** Existing documents loaded for iterate mode */
	existingDocuments: ExistingDocument[];
	/** Error message if any */
	error: string | null;
	/** Streaming content being generated (accumulates as AI outputs) */
	streamingContent: string;
	/** Progress tracking for document generation (e.g., "Phase 1 of 3") */
	generationProgress: GenerationProgress | null;
	/** Tab ID the wizard was started on (for per-tab isolation) */
	wizardTabId: string | null;
	/** The Claude agent session ID (from session_id in output) - used to switch tab after wizard completes */
	agentSessionId: string | null;
	/** Full wizard state (for the current active tab) */
	state: InlineWizardState;
	/** Get wizard state for a specific tab (returns undefined if no wizard on that tab) */
	getStateForTab: (tabId: string) => InlineWizardState | undefined;
	/** Check if a specific tab has an active wizard */
	isWizardActiveForTab: (tabId: string) => boolean;
	/**
	 * Map of session IDs (Session.id, not provider session) that have at least one
	 * tab with the inline wizard active. Value carries an `isGeneratingDocs` flag
	 * that's true when any such tab is in the Auto Run doc generation phase, so
	 * the Left Bar indicator can pulse during generation.
	 */
	wizardActiveSessions: Map<string, { isGeneratingDocs: boolean }>;
	/**
	 * Start the wizard with intent parsing flow.
	 */
	startWizard: (
		naturalLanguageInput?: string,
		currentUIState?: PreviousUIState,
		projectPath?: string,
		agentType?: ToolType,
		sessionName?: string,
		tabId?: string,
		sessionId?: string,
		autoRunFolderPath?: string,
		sessionSshRemoteConfig?: InlineWizardSshRemoteConfig,
		conductorProfile?: string,
		sessionOverrides?: InlineWizardSessionOverrides
	) => Promise<void>;
	/**
	 * End the wizard and restore previous UI state.
	 */
	endWizard: (explicitTabId?: string) => Promise<PreviousUIState | null>;
	/**
	 * Send a message to the wizard conversation.
	 */
	sendMessage: (
		content: string,
		images?: string[],
		callbacks?: ConversationCallbacks,
		explicitTabId?: string
	) => Promise<void>;
	/**
	 * Mark the given tab as the "current" wizard.
	 */
	selectWizardTab: (tabId: string) => void;
	/**
	 * Set the confidence level.
	 */
	setConfidence: (value: number) => void;
	/** Set the wizard mode */
	setMode: (mode: InlineWizardMode) => void;
	/** Set the goal for iterate mode */
	setGoal: (goal: string | null) => void;
	/** Set whether documents are being generated */
	setGeneratingDocs: (generating: boolean) => void;
	/** Set generated documents */
	setGeneratedDocuments: (docs: InlineGeneratedDocument[]) => void;
	/** Set existing documents (for iterate mode context) */
	setExistingDocuments: (docs: ExistingDocument[]) => void;
	/** Set error message */
	setError: (error: string | null) => void;
	/** Clear the current error */
	clearError: () => void;
	/**
	 * Retry sending the last user message that failed.
	 */
	retryLastMessage: (callbacks?: ConversationCallbacks) => Promise<void>;
	/** Add an assistant response to the conversation */
	addAssistantMessage: (content: string, confidence?: number, ready?: boolean) => void;
	/** Clear conversation history */
	clearConversation: () => void;
	/** Reset the wizard to initial state */
	reset: () => void;
	/**
	 * Generate Auto Run documents based on the conversation.
	 */
	generateDocuments: (callbacks?: DocumentGenerationCallbacks, tabId?: string) => Promise<void>;
}

import type { ReactNode } from 'react';
import type { ToolType, AgentConfig } from '../../../types';

export type WizardStep =
	'agent-selection' | 'directory-selection' | 'conversation' | 'preparing-plan' | 'phase-review';

export type WizardAutoRunMode = 'none' | 'first' | 'all';

export interface WizardSessionSshRemoteConfig {
	enabled: boolean;
	remoteId: string | null;
	workingDirOverride?: string;
}

export interface WizardMessage {
	id: string;
	role: 'user' | 'assistant' | 'system';
	content: string;
	timestamp: number;
	confidence?: number;
	ready?: boolean;
}

export interface GeneratedDocument {
	filename: string;
	content: string;
	taskCount: number;
	savedPath?: string;
}

export interface WizardState {
	currentStep: WizardStep;
	isOpen: boolean;
	selectedAgent: ToolType | null;
	availableAgents: AgentConfig[];
	agentName: string;
	customPath?: string;
	customArgs?: string;
	customEnvVars?: Record<string, string>;
	// Claude token-source choice (claude-code only). Mirrors the per-session
	// fields so the wizard-created session inherits the user's API/TUI/Dynamic
	// pick. Undefined means "never chosen" - the per-agent default applies.
	enableMaestroP?: boolean;
	maestroPMode?: 'interactive' | 'dynamic';
	maestroPPath?: string;
	sessionSshRemoteConfig?: WizardSessionSshRemoteConfig;
	directoryPath: string;
	isGitRepo: boolean;
	detectedAgentPath: string | null;
	directoryError: string | null;
	hasExistingAutoRunDocs: boolean;
	existingDocsCount: number;
	existingDocsChoice: 'continue' | 'fresh' | null;
	conversationHistory: WizardMessage[];
	confidenceLevel: number;
	isReadyToProceed: boolean;
	isConversationLoading: boolean;
	conversationError: string | null;
	generatedDocuments: GeneratedDocument[];
	currentDocumentIndex: number;
	isGeneratingDocuments: boolean;
	generationError: string | null;
	editedPhase1Content: string | null;
	autoRunMode: WizardAutoRunMode;
	wantsTour: boolean;
	isComplete: boolean;
	createdSessionId: string | null;
}

export type WizardAction =
	| { type: 'OPEN_WIZARD' }
	| { type: 'CLOSE_WIZARD' }
	| { type: 'RESET_WIZARD' }
	| { type: 'SET_STEP'; step: WizardStep }
	| { type: 'NEXT_STEP' }
	| { type: 'PREVIOUS_STEP' }
	| { type: 'SET_SELECTED_AGENT'; agent: ToolType | null }
	| { type: 'SET_AVAILABLE_AGENTS'; agents: AgentConfig[] }
	| { type: 'SET_AGENT_NAME'; name: string }
	| { type: 'SET_CUSTOM_PATH'; path: string | undefined }
	| { type: 'SET_CUSTOM_ARGS'; args: string | undefined }
	| { type: 'SET_CUSTOM_ENV_VARS'; envVars: Record<string, string> | undefined }
	| { type: 'SET_ENABLE_MAESTRO_P'; value: boolean | undefined }
	| { type: 'SET_MAESTRO_P_MODE'; mode: 'interactive' | 'dynamic' }
	| { type: 'SET_MAESTRO_P_PATH'; path: string | undefined }
	| {
			type: 'SET_SESSION_SSH_REMOTE_CONFIG';
			config: WizardSessionSshRemoteConfig | undefined;
	  }
	| { type: 'SET_DIRECTORY_PATH'; path: string }
	| { type: 'SET_IS_GIT_REPO'; isGitRepo: boolean }
	| { type: 'SET_DETECTED_AGENT_PATH'; path: string | null }
	| { type: 'SET_DIRECTORY_ERROR'; error: string | null }
	| { type: 'SET_HAS_EXISTING_AUTORUN_DOCS'; hasExisting: boolean; count: number }
	| { type: 'SET_EXISTING_DOCS_CHOICE'; choice: 'continue' | 'fresh' | null }
	| { type: 'ADD_MESSAGE'; message: WizardMessage }
	| { type: 'SET_CONVERSATION_HISTORY'; history: WizardMessage[] }
	| { type: 'SET_CONFIDENCE_LEVEL'; level: number }
	| { type: 'SET_IS_READY_TO_PROCEED'; ready: boolean }
	| { type: 'SET_CONVERSATION_LOADING'; loading: boolean }
	| { type: 'SET_CONVERSATION_ERROR'; error: string | null }
	| { type: 'SET_GENERATED_DOCUMENTS'; documents: GeneratedDocument[] }
	| { type: 'SET_CURRENT_DOCUMENT_INDEX'; index: number }
	| { type: 'SET_GENERATING_DOCUMENTS'; generating: boolean }
	| { type: 'SET_GENERATION_ERROR'; error: string | null }
	| { type: 'SET_EDITED_PHASE1_CONTENT'; content: string | null }
	| { type: 'SET_AUTO_RUN_MODE'; mode: WizardAutoRunMode }
	| { type: 'SET_WANTS_TOUR'; wantsTour: boolean }
	| { type: 'SET_COMPLETE'; sessionId: string | null }
	| { type: 'RESTORE_STATE'; state: Partial<WizardState> };

export interface SerializableWizardState {
	currentStep: WizardStep;
	selectedAgent: ToolType | null;
	agentName: string;
	directoryPath: string;
	isGitRepo: boolean;
	conversationHistory: WizardMessage[];
	confidenceLevel: number;
	isReadyToProceed: boolean;
	generatedDocuments: GeneratedDocument[];
	editedPhase1Content: string | null;
	autoRunMode: WizardAutoRunMode;
	wantsTour: boolean;
	sessionSshRemoteConfig?: WizardSessionSshRemoteConfig;
}

export interface WizardContextAPI {
	state: WizardState;
	openWizard: () => void;
	closeWizard: () => void;
	resetWizard: () => void;
	goToStep: (step: WizardStep) => void;
	nextStep: () => void;
	previousStep: () => void;
	canProceedToNext: () => boolean;
	getCurrentStepNumber: () => number;
	setSelectedAgent: (agent: ToolType | null) => void;
	setAvailableAgents: (agents: AgentConfig[]) => void;
	setAgentName: (name: string) => void;
	setCustomPath: (path: string | undefined) => void;
	setCustomArgs: (args: string | undefined) => void;
	setCustomEnvVars: (envVars: Record<string, string> | undefined) => void;
	setEnableMaestroP: (value: boolean | undefined) => void;
	setMaestroPMode: (mode: 'interactive' | 'dynamic') => void;
	setMaestroPPath: (path: string | undefined) => void;
	setSessionSshRemoteConfig: (config: WizardSessionSshRemoteConfig | undefined) => void;
	setDirectoryPath: (path: string) => void;
	setIsGitRepo: (isGitRepo: boolean) => void;
	setDetectedAgentPath: (path: string | null) => void;
	setDirectoryError: (error: string | null) => void;
	setHasExistingAutoRunDocs: (hasExisting: boolean, count: number) => void;
	setExistingDocsChoice: (choice: 'continue' | 'fresh' | null) => void;
	addMessage: (message: Omit<WizardMessage, 'id' | 'timestamp'>) => void;
	setConversationHistory: (history: WizardMessage[]) => void;
	setConfidenceLevel: (level: number) => void;
	setIsReadyToProceed: (ready: boolean) => void;
	setConversationLoading: (loading: boolean) => void;
	setConversationError: (error: string | null) => void;
	setGeneratedDocuments: (documents: GeneratedDocument[]) => void;
	setCurrentDocumentIndex: (index: number) => void;
	setGeneratingDocuments: (generating: boolean) => void;
	setGenerationError: (error: string | null) => void;
	setEditedPhase1Content: (content: string | null) => void;
	getPhase1Content: () => string;
	setAutoRunMode: (mode: WizardAutoRunMode) => void;
	setWantsTour: (wantsTour: boolean) => void;
	completeWizard: (sessionId: string | null) => Promise<void>;
	saveStateForResume: () => Promise<void>;
	restoreState: (state: Partial<WizardState>) => void;
	getSerializableState: () => SerializableWizardState;
	hasResumeState: () => Promise<boolean>;
	loadResumeState: () => Promise<SerializableWizardState | null>;
	clearResumeState: () => Promise<void>;
}

export interface WizardProviderProps {
	children: ReactNode;
}

/**
 * WizardContext.tsx
 *
 * State management for the onboarding wizard multi-screen flow.
 * Manages wizard progression, agent selection, directory configuration,
 * conversation history, and document generation state.
 */

import {
	createContext,
	useContext,
	useCallback,
	useReducer,
	useEffect,
	useRef,
	useMemo,
	ReactNode,
} from 'react';
import type { ToolType, AgentConfig } from '../../types';

/**
 * Wizard steps in order of progression
 */
export type WizardStep =
	| 'agent-selection'
	| 'directory-selection'
	| 'conversation'
	| 'preparing-plan'
	| 'phase-review';

/**
 * Total number of steps in the wizard
 */
export const WIZARD_TOTAL_STEPS = 5;

/**
 * Map step names to their numeric index (1-based for display)
 */
export const STEP_INDEX: Record<WizardStep, number> = {
	'agent-selection': 1,
	'directory-selection': 2,
	conversation: 3,
	'preparing-plan': 4,
	'phase-review': 5,
};

/**
 * Map numeric index to step name
 */
export const INDEX_TO_STEP: Record<number, WizardStep> = {
	1: 'agent-selection',
	2: 'directory-selection',
	3: 'conversation',
	4: 'preparing-plan',
	5: 'phase-review',
};

/**
 * Conversation message in the wizard conversation flow
 */
export interface WizardMessage {
	id: string;
	role: 'user' | 'assistant' | 'system';
	content: string;
	timestamp: number;
	/** Parsed confidence from assistant responses */
	confidence?: number;
	/** Parsed ready flag from assistant responses */
	ready?: boolean;
}

/**
 * Generated document from the phase generation step
 */
export interface GeneratedDocument {
	filename: string;
	content: string;
	taskCount: number;
	/** Absolute path after saving */
	savedPath?: string;
}

/**
 * Complete wizard state
 */
export interface WizardState {
	/** Current step in the wizard flow */
	currentStep: WizardStep;

	/** Whether the wizard is open/visible */
	isOpen: boolean;

	// Agent Selection (Step 1)
	/** Selected agent type */
	selectedAgent: ToolType | null;
	/** Available agents from detection */
	availableAgents: AgentConfig[];
	/** User-provided project name */
	agentName: string;
	/** Per-agent custom path */
	customPath?: string;
	/** Per-agent custom CLI arguments */
	customArgs?: string;
	/** Per-agent custom environment variables */
	customEnvVars?: Record<string, string>;
	/** Per-session SSH remote configuration (stored per-session, not per-agent) */
	sessionSshRemoteConfig?: {
		enabled: boolean;
		remoteId: string | null;
		workingDirOverride?: string;
	};

	// Directory Selection (Step 2)
	/** Selected directory path */
	directoryPath: string;
	/** Whether the selected path is a git repo */
	isGitRepo: boolean;
	/** Auto-detected agent path (if any) */
	detectedAgentPath: string | null;
	/** Directory selection error (if any) */
	directoryError: string | null;
	/** Whether an Auto Run Docs folder exists in the selected directory */
	hasExistingAutoRunDocs: boolean;
	/** Number of documents in existing Auto Run Docs folder */
	existingDocsCount: number;
	/** User's choice for existing docs: 'continue' to read them, 'fresh' to delete them */
	existingDocsChoice: 'continue' | 'fresh' | null;

	// Conversation (Step 3)
	/** Conversation history with the agent */
	conversationHistory: WizardMessage[];
	/** Current confidence level (0-100) from agent responses */
	confidenceLevel: number;
	/** Whether agent has indicated ready=true and confidence > 80 */
	isReadyToProceed: boolean;
	/** Whether conversation is in progress (agent is thinking) */
	isConversationLoading: boolean;
	/** Error message if conversation fails */
	conversationError: string | null;

	// Phase Review (Step 4)
	/** Generated Auto Run documents */
	generatedDocuments: GeneratedDocument[];
	/** Index of the currently displayed document (Phase 1 = 0) */
	currentDocumentIndex: number;
	/** Whether documents are being generated */
	isGeneratingDocuments: boolean;
	/** Error message if generation fails */
	generationError: string | null;
	/** User's edited content for Phase 1 (if modified) */
	editedPhase1Content: string | null;

	// Tour Preference
	/** Whether user wants the walkthrough tour after setup */
	wantsTour: boolean;

	// Wizard completion state
	/** Whether wizard completed successfully */
	isComplete: boolean;
	/** Session ID created by the wizard (if any) */
	createdSessionId: string | null;
}

/**
 * Initial/default wizard state
 */
const initialState: WizardState = {
	currentStep: 'agent-selection',
	isOpen: false,

	// Agent Selection
	selectedAgent: null,
	availableAgents: [],
	agentName: '',
	customPath: undefined,
	customArgs: undefined,
	customEnvVars: undefined,
	sessionSshRemoteConfig: undefined,

	// Directory Selection
	directoryPath: '',
	isGitRepo: false,
	detectedAgentPath: null,
	directoryError: null,
	hasExistingAutoRunDocs: false,
	existingDocsCount: 0,
	existingDocsChoice: null,

	// Conversation
	conversationHistory: [],
	confidenceLevel: 0,
	isReadyToProceed: false,
	isConversationLoading: false,
	conversationError: null,

	// Phase Review
	generatedDocuments: [],
	currentDocumentIndex: 0,
	isGeneratingDocuments: false,
	generationError: null,
	editedPhase1Content: null,

	// Tour
	wantsTour: true, // Default to wanting the tour

	// Completion
	isComplete: false,
	createdSessionId: null,
};

/**
 * Action types for the wizard reducer
 */
type WizardAction =
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
	| {
			type: 'SET_SESSION_SSH_REMOTE_CONFIG';
			config:
				| { enabled: boolean; remoteId: string | null; workingDirOverride?: string }
				| undefined;
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
	| { type: 'SET_WANTS_TOUR'; wantsTour: boolean }
	| { type: 'SET_COMPLETE'; sessionId: string | null }
	| { type: 'RESTORE_STATE'; state: Partial<WizardState> };

/**
 * Get the next step in the wizard flow
 */
function getNextStep(current: WizardStep): WizardStep | null {
	const currentIndex = STEP_INDEX[current];
	const nextIndex = currentIndex + 1;
	return nextIndex <= WIZARD_TOTAL_STEPS ? INDEX_TO_STEP[nextIndex] : null;
}

/**
 * Get the previous step in the wizard flow
 */
function getPreviousStep(current: WizardStep): WizardStep | null {
	const currentIndex = STEP_INDEX[current];
	const prevIndex = currentIndex - 1;
	return prevIndex >= 1 ? INDEX_TO_STEP[prevIndex] : null;
}

/**
 * Wizard state reducer
 */
function wizardReducer(state: WizardState, action: WizardAction): WizardState {
	switch (action.type) {
		case 'OPEN_WIZARD':
			return { ...state, isOpen: true };

		case 'CLOSE_WIZARD':
			return { ...state, isOpen: false };

		case 'RESET_WIZARD':
			return { ...initialState };

		case 'SET_STEP':
			return { ...state, currentStep: action.step };

		case 'NEXT_STEP': {
			const nextStep = getNextStep(state.currentStep);
			return nextStep ? { ...state, currentStep: nextStep } : state;
		}

		case 'PREVIOUS_STEP': {
			const prevStep = getPreviousStep(state.currentStep);
			return prevStep ? { ...state, currentStep: prevStep } : state;
		}

		case 'SET_SELECTED_AGENT':
			return { ...state, selectedAgent: action.agent };

		case 'SET_AVAILABLE_AGENTS':
			return { ...state, availableAgents: action.agents };

		case 'SET_AGENT_NAME':
			return { ...state, agentName: action.name };

		case 'SET_CUSTOM_PATH':
			return { ...state, customPath: action.path };

		case 'SET_CUSTOM_ARGS':
			return { ...state, customArgs: action.args };

		case 'SET_CUSTOM_ENV_VARS':
			return { ...state, customEnvVars: action.envVars };

		case 'SET_SESSION_SSH_REMOTE_CONFIG':
			return { ...state, sessionSshRemoteConfig: action.config };

		case 'SET_DIRECTORY_PATH':
			return { ...state, directoryPath: action.path, directoryError: null };

		case 'SET_IS_GIT_REPO':
			return { ...state, isGitRepo: action.isGitRepo };

		case 'SET_DETECTED_AGENT_PATH':
			return { ...state, detectedAgentPath: action.path };

		case 'SET_DIRECTORY_ERROR':
			return { ...state, directoryError: action.error };

		case 'SET_HAS_EXISTING_AUTORUN_DOCS':
			return {
				...state,
				hasExistingAutoRunDocs: action.hasExisting,
				existingDocsCount: action.count,
			};

		case 'SET_EXISTING_DOCS_CHOICE':
			return { ...state, existingDocsChoice: action.choice };

		case 'ADD_MESSAGE':
			return {
				...state,
				conversationHistory: [...state.conversationHistory, action.message],
			};

		case 'SET_CONVERSATION_HISTORY':
			return { ...state, conversationHistory: action.history };

		case 'SET_CONFIDENCE_LEVEL':
			return { ...state, confidenceLevel: action.level };

		case 'SET_IS_READY_TO_PROCEED':
			return { ...state, isReadyToProceed: action.ready };

		case 'SET_CONVERSATION_LOADING':
			return { ...state, isConversationLoading: action.loading };

		case 'SET_CONVERSATION_ERROR':
			return { ...state, conversationError: action.error };

		case 'SET_GENERATED_DOCUMENTS':
			return { ...state, generatedDocuments: action.documents };

		case 'SET_CURRENT_DOCUMENT_INDEX':
			return { ...state, currentDocumentIndex: action.index };

		case 'SET_GENERATING_DOCUMENTS':
			return { ...state, isGeneratingDocuments: action.generating };

		case 'SET_GENERATION_ERROR':
			return { ...state, generationError: action.error };

		case 'SET_EDITED_PHASE1_CONTENT':
			return { ...state, editedPhase1Content: action.content };

		case 'SET_WANTS_TOUR':
			return { ...state, wantsTour: action.wantsTour };

		case 'SET_COMPLETE':
			return {
				...state,
				isComplete: true,
				createdSessionId: action.sessionId,
				isOpen: false,
			};

		case 'RESTORE_STATE':
			return { ...state, ...action.state };

		default:
			return state;
	}
}

/**
 * Serializable wizard state for persistence
 */
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
	wantsTour: boolean;
}

/**
 * Wizard context API type
 */
export interface WizardContextAPI {
	/** Current wizard state */
	state: WizardState;

	// Wizard lifecycle
	/** Open the wizard */
	openWizard: () => void;
	/** Close the wizard (can be reopened) */
	closeWizard: () => void;
	/** Reset wizard to initial state */
	resetWizard: () => void;

	// Navigation
	/** Go to a specific step */
	goToStep: (step: WizardStep) => void;
	/** Go to the next step */
	nextStep: () => void;
	/** Go to the previous step */
	previousStep: () => void;
	/** Check if can go to next step (validation) */
	canProceedToNext: () => boolean;
	/** Get current step number (1-based) */
	getCurrentStepNumber: () => number;

	// Agent Selection
	/** Set the selected agent type */
	setSelectedAgent: (agent: ToolType | null) => void;
	/** Set available agents from detection */
	setAvailableAgents: (agents: AgentConfig[]) => void;
	/** Set the project/agent name */
	setAgentName: (name: string) => void;
	/** Set custom path for the agent */
	setCustomPath: (path: string | undefined) => void;
	/** Set custom CLI arguments for the agent */
	setCustomArgs: (args: string | undefined) => void;
	/** Set custom environment variables for the agent */
	setCustomEnvVars: (envVars: Record<string, string> | undefined) => void;
	/** Set per-session SSH remote configuration */
	setSessionSshRemoteConfig: (
		config: { enabled: boolean; remoteId: string | null; workingDirOverride?: string } | undefined
	) => void;

	// Directory Selection
	/** Set the directory path */
	setDirectoryPath: (path: string) => void;
	/** Set whether the path is a git repo */
	setIsGitRepo: (isGitRepo: boolean) => void;
	/** Set the auto-detected agent path */
	setDetectedAgentPath: (path: string | null) => void;
	/** Set directory validation error */
	setDirectoryError: (error: string | null) => void;
	/** Set whether existing Auto Run Docs folder was found */
	setHasExistingAutoRunDocs: (hasExisting: boolean, count: number) => void;
	/** Set user's choice for existing docs */
	setExistingDocsChoice: (choice: 'continue' | 'fresh' | null) => void;

	// Conversation
	/** Add a message to conversation history */
	addMessage: (message: Omit<WizardMessage, 'id' | 'timestamp'>) => void;
	/** Set the entire conversation history (for restore) */
	setConversationHistory: (history: WizardMessage[]) => void;
	/** Set the confidence level from agent response */
	setConfidenceLevel: (level: number) => void;
	/** Set whether ready to proceed (confidence > 80 and ready=true) */
	setIsReadyToProceed: (ready: boolean) => void;
	/** Set conversation loading state */
	setConversationLoading: (loading: boolean) => void;
	/** Set conversation error */
	setConversationError: (error: string | null) => void;

	// Phase Review
	/** Set generated documents */
	setGeneratedDocuments: (documents: GeneratedDocument[]) => void;
	/** Set current document index for viewing */
	setCurrentDocumentIndex: (index: number) => void;
	/** Set document generation loading state */
	setGeneratingDocuments: (generating: boolean) => void;
	/** Set generation error */
	setGenerationError: (error: string | null) => void;
	/** Set user's edited Phase 1 content */
	setEditedPhase1Content: (content: string | null) => void;
	/** Get current Phase 1 content (edited or original) */
	getPhase1Content: () => string;

	// Tour
	/** Set whether user wants the tour */
	setWantsTour: (wantsTour: boolean) => void;

	// Completion
	/** Mark wizard as complete with optional session ID */
	completeWizard: (sessionId: string | null) => void;

	// State persistence (for resume functionality)
	/** Save current state for later resume */
	saveStateForResume: () => void;
	/** Restore state from saved data */
	restoreState: (state: Partial<WizardState>) => void;
	/** Get serializable state for persistence */
	getSerializableState: () => SerializableWizardState;
	/** Check if there's saved resume state (async) */
	hasResumeState: () => Promise<boolean>;
	/** Load saved resume state (async, returns null if none) */
	loadResumeState: () => Promise<SerializableWizardState | null>;
	/** Clear saved resume state */
	clearResumeState: () => void;
}

// Create the context
const WizardContext = createContext<WizardContextAPI | null>(null);

/**
 * WizardProvider props
 */
interface WizardProviderProps {
	children: ReactNode;
}

/**
 * Generate a unique message ID
 */
function generateMessageId(): string {
	return `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * WizardProvider - Provides wizard state management to the component tree
 */
export function WizardProvider({ children }: WizardProviderProps) {
	const [state, dispatch] = useReducer(wizardReducer, initialState);

	// Wizard lifecycle
	const openWizard = useCallback(() => {
		// If previous wizard was completed, reset state for fresh start
		// This prevents showing stale state when running wizard multiple times in same session
		if (state.isComplete) {
			dispatch({ type: 'RESET_WIZARD' });
		}
		dispatch({ type: 'OPEN_WIZARD' });
	}, [state.isComplete]);

	const closeWizard = useCallback(() => {
		dispatch({ type: 'CLOSE_WIZARD' });
	}, []);

	const resetWizard = useCallback(() => {
		dispatch({ type: 'RESET_WIZARD' });
	}, []);

	// Navigation
	const goToStep = useCallback((step: WizardStep) => {
		dispatch({ type: 'SET_STEP', step });
	}, []);

	const nextStep = useCallback(() => {
		dispatch({ type: 'NEXT_STEP' });
	}, []);

	const previousStep = useCallback(() => {
		dispatch({ type: 'PREVIOUS_STEP' });
	}, []);

	const canProceedToNext = useCallback((): boolean => {
		switch (state.currentStep) {
			case 'agent-selection':
				// Must have selected an agent and provided a name
				return state.selectedAgent !== null && state.agentName.trim() !== '';

			case 'directory-selection':
				// Must have a valid directory path
				return state.directoryPath.trim() !== '' && state.directoryError === null;

			case 'conversation':
				// Must have confidence > 80 and ready=true from agent
				return state.isReadyToProceed;

			case 'phase-review':
				// Must have at least one generated document
				return state.generatedDocuments.length > 0;

			default:
				return false;
		}
	}, [
		state.currentStep,
		state.selectedAgent,
		state.agentName,
		state.directoryPath,
		state.directoryError,
		state.isReadyToProceed,
		state.generatedDocuments.length,
	]);

	const getCurrentStepNumber = useCallback((): number => {
		return STEP_INDEX[state.currentStep];
	}, [state.currentStep]);

	// Agent Selection
	const setSelectedAgent = useCallback((agent: ToolType | null) => {
		dispatch({ type: 'SET_SELECTED_AGENT', agent });
	}, []);

	const setAvailableAgents = useCallback((agents: AgentConfig[]) => {
		dispatch({ type: 'SET_AVAILABLE_AGENTS', agents });
	}, []);

	const setAgentName = useCallback((name: string) => {
		dispatch({ type: 'SET_AGENT_NAME', name });
	}, []);

	const setCustomPath = useCallback((path: string | undefined) => {
		dispatch({ type: 'SET_CUSTOM_PATH', path });
	}, []);

	const setCustomArgs = useCallback((args: string | undefined) => {
		dispatch({ type: 'SET_CUSTOM_ARGS', args });
	}, []);

	const setCustomEnvVars = useCallback((envVars: Record<string, string> | undefined) => {
		dispatch({ type: 'SET_CUSTOM_ENV_VARS', envVars });
	}, []);

	const setSessionSshRemoteConfig = useCallback(
		(
			config: { enabled: boolean; remoteId: string | null; workingDirOverride?: string } | undefined
		) => {
			dispatch({ type: 'SET_SESSION_SSH_REMOTE_CONFIG', config });
		},
		[]
	);

	// Directory Selection
	const setDirectoryPath = useCallback((path: string) => {
		dispatch({ type: 'SET_DIRECTORY_PATH', path });
	}, []);

	const setIsGitRepo = useCallback((isGitRepo: boolean) => {
		dispatch({ type: 'SET_IS_GIT_REPO', isGitRepo });
	}, []);

	const setDetectedAgentPath = useCallback((path: string | null) => {
		dispatch({ type: 'SET_DETECTED_AGENT_PATH', path });
	}, []);

	const setDirectoryError = useCallback((error: string | null) => {
		dispatch({ type: 'SET_DIRECTORY_ERROR', error });
	}, []);

	const setHasExistingAutoRunDocs = useCallback((hasExisting: boolean, count: number) => {
		dispatch({ type: 'SET_HAS_EXISTING_AUTORUN_DOCS', hasExisting, count });
	}, []);

	const setExistingDocsChoice = useCallback((choice: 'continue' | 'fresh' | null) => {
		dispatch({ type: 'SET_EXISTING_DOCS_CHOICE', choice });
	}, []);

	// Conversation
	const addMessage = useCallback((message: Omit<WizardMessage, 'id' | 'timestamp'>) => {
		const fullMessage: WizardMessage = {
			...message,
			id: generateMessageId(),
			timestamp: Date.now(),
		};
		dispatch({ type: 'ADD_MESSAGE', message: fullMessage });
	}, []);

	const setConversationHistory = useCallback((history: WizardMessage[]) => {
		dispatch({ type: 'SET_CONVERSATION_HISTORY', history });
	}, []);

	const setConfidenceLevel = useCallback((level: number) => {
		dispatch({ type: 'SET_CONFIDENCE_LEVEL', level });
	}, []);

	const setIsReadyToProceed = useCallback((ready: boolean) => {
		dispatch({ type: 'SET_IS_READY_TO_PROCEED', ready });
	}, []);

	const setConversationLoading = useCallback((loading: boolean) => {
		dispatch({ type: 'SET_CONVERSATION_LOADING', loading });
	}, []);

	const setConversationError = useCallback((error: string | null) => {
		dispatch({ type: 'SET_CONVERSATION_ERROR', error });
	}, []);

	// Phase Review
	const setGeneratedDocuments = useCallback((documents: GeneratedDocument[]) => {
		dispatch({ type: 'SET_GENERATED_DOCUMENTS', documents });
	}, []);

	const setCurrentDocumentIndex = useCallback((index: number) => {
		dispatch({ type: 'SET_CURRENT_DOCUMENT_INDEX', index });
	}, []);

	const setGeneratingDocuments = useCallback((generating: boolean) => {
		dispatch({ type: 'SET_GENERATING_DOCUMENTS', generating });
	}, []);

	const setGenerationError = useCallback((error: string | null) => {
		dispatch({ type: 'SET_GENERATION_ERROR', error });
	}, []);

	const setEditedPhase1Content = useCallback((content: string | null) => {
		dispatch({ type: 'SET_EDITED_PHASE1_CONTENT', content });
	}, []);

	const getPhase1Content = useCallback((): string => {
		// Return edited content if available, otherwise original Phase 1 content
		if (state.editedPhase1Content !== null) {
			return state.editedPhase1Content;
		}
		const phase1Doc = state.generatedDocuments[0];
		return phase1Doc?.content || '';
	}, [state.editedPhase1Content, state.generatedDocuments]);

	// Tour
	const setWantsTour = useCallback((wantsTour: boolean) => {
		dispatch({ type: 'SET_WANTS_TOUR', wantsTour });
	}, []);

	// Completion
	const completeWizard = useCallback((sessionId: string | null) => {
		// Clear saved resume state since wizard completed successfully
		window.maestro.settings.set('wizardResumeState', null);
		dispatch({ type: 'SET_COMPLETE', sessionId });
	}, []);

	// State persistence
	const getSerializableState = useCallback((): SerializableWizardState => {
		return {
			currentStep: state.currentStep,
			selectedAgent: state.selectedAgent,
			agentName: state.agentName,
			directoryPath: state.directoryPath,
			isGitRepo: state.isGitRepo,
			conversationHistory: state.conversationHistory,
			confidenceLevel: state.confidenceLevel,
			isReadyToProceed: state.isReadyToProceed,
			generatedDocuments: state.generatedDocuments,
			editedPhase1Content: state.editedPhase1Content,
			wantsTour: state.wantsTour,
		};
	}, [
		state.currentStep,
		state.selectedAgent,
		state.agentName,
		state.directoryPath,
		state.isGitRepo,
		state.conversationHistory,
		state.confidenceLevel,
		state.isReadyToProceed,
		state.generatedDocuments,
		state.editedPhase1Content,
		state.wantsTour,
	]);

	const saveStateForResume = useCallback(() => {
		const serializableState = getSerializableState();
		// Save to settings (async, fire-and-forget)
		window.maestro.settings.set('wizardResumeState', serializableState);
	}, [getSerializableState]);

	const restoreState = useCallback((savedState: Partial<WizardState>) => {
		dispatch({ type: 'RESTORE_STATE', state: savedState });
	}, []);

	const hasResumeState = useCallback(async (): Promise<boolean> => {
		try {
			const saved = await window.maestro.settings.get('wizardResumeState');
			// Check if saved state exists and wizard is not complete
			return saved !== undefined && saved !== null && typeof saved === 'object';
		} catch {
			return false;
		}
	}, []);

	const loadResumeState = useCallback(async (): Promise<SerializableWizardState | null> => {
		try {
			const saved = await window.maestro.settings.get('wizardResumeState');
			if (saved && typeof saved === 'object') {
				// Validate that required fields exist
				const state = saved as SerializableWizardState;
				if (state.currentStep && state.currentStep !== 'agent-selection') {
					// Only return state if past the first step
					return state;
				}
			}
			return null;
		} catch {
			return null;
		}
	}, []);

	const clearResumeState = useCallback(() => {
		window.maestro.settings.set('wizardResumeState', null);
	}, []);

	// Store full state in a ref so we can access current values without triggering effect re-runs
	const stateRef = useRef(state);
	stateRef.current = state;

	// Auto-save state when step changes (only for steps past the first)
	// PERF: Only depends on state.currentStep to avoid running on every state change
	useEffect(() => {
		// Save state when advancing past the first step
		// This ensures user progress is preserved for resume
		if (STEP_INDEX[state.currentStep] > 1) {
			// Access current state via ref to get latest values
			const currentState = stateRef.current;
			const serializableState: SerializableWizardState = {
				currentStep: currentState.currentStep,
				selectedAgent: currentState.selectedAgent,
				agentName: currentState.agentName,
				directoryPath: currentState.directoryPath,
				isGitRepo: currentState.isGitRepo,
				conversationHistory: currentState.conversationHistory,
				confidenceLevel: currentState.confidenceLevel,
				isReadyToProceed: currentState.isReadyToProceed,
				generatedDocuments: currentState.generatedDocuments,
				editedPhase1Content: currentState.editedPhase1Content,
				wantsTour: currentState.wantsTour,
			};
			window.maestro.settings.set('wizardResumeState', serializableState);
		}
	}, [state.currentStep]);

	// Build the context value - memoized to prevent unnecessary re-renders
	const contextValue: WizardContextAPI = useMemo(
		() => ({
			state,

			// Lifecycle
			openWizard,
			closeWizard,
			resetWizard,

			// Navigation
			goToStep,
			nextStep,
			previousStep,
			canProceedToNext,
			getCurrentStepNumber,

			// Agent Selection
			setSelectedAgent,
			setAvailableAgents,
			setAgentName,
			setCustomPath,
			setCustomArgs,
			setCustomEnvVars,
			setSessionSshRemoteConfig,

			// Directory Selection
			setDirectoryPath,
			setIsGitRepo,
			setDetectedAgentPath,
			setDirectoryError,
			setHasExistingAutoRunDocs,
			setExistingDocsChoice,

			// Conversation
			addMessage,
			setConversationHistory,
			setConfidenceLevel,
			setIsReadyToProceed,
			setConversationLoading,
			setConversationError,

			// Phase Review
			setGeneratedDocuments,
			setCurrentDocumentIndex,
			setGeneratingDocuments,
			setGenerationError,
			setEditedPhase1Content,
			getPhase1Content,

			// Tour
			setWantsTour,

			// Completion
			completeWizard,

			// State persistence
			saveStateForResume,
			restoreState,
			getSerializableState,
			hasResumeState,
			loadResumeState,
			clearResumeState,
		}),
		[
			state,
			openWizard,
			closeWizard,
			resetWizard,
			goToStep,
			nextStep,
			previousStep,
			canProceedToNext,
			getCurrentStepNumber,
			setSelectedAgent,
			setAvailableAgents,
			setAgentName,
			setCustomPath,
			setCustomArgs,
			setCustomEnvVars,
			setSessionSshRemoteConfig,
			setDirectoryPath,
			setIsGitRepo,
			setDetectedAgentPath,
			setDirectoryError,
			setHasExistingAutoRunDocs,
			setExistingDocsChoice,
			addMessage,
			setConversationHistory,
			setConfidenceLevel,
			setIsReadyToProceed,
			setConversationLoading,
			setConversationError,
			setGeneratedDocuments,
			setCurrentDocumentIndex,
			setGeneratingDocuments,
			setGenerationError,
			setEditedPhase1Content,
			getPhase1Content,
			setWantsTour,
			completeWizard,
			saveStateForResume,
			restoreState,
			getSerializableState,
			hasResumeState,
			loadResumeState,
			clearResumeState,
		]
	);

	return <WizardContext.Provider value={contextValue}>{children}</WizardContext.Provider>;
}

/**
 * useWizard - Hook to access the wizard context API
 *
 * Must be used within a WizardProvider. Throws an error if used outside.
 *
 * @returns WizardContextAPI - Methods and state for managing the wizard
 *
 * @example
 * const { state, nextStep, setSelectedAgent } = useWizard();
 *
 * // Check current step
 * if (state.currentStep === 'agent-selection') {
 *   setSelectedAgent('claude-code');
 * }
 *
 * // Navigate to next step
 * if (canProceedToNext()) {
 *   nextStep();
 * }
 */
export function useWizard(): WizardContextAPI {
	const context = useContext(WizardContext);

	if (!context) {
		throw new Error('useWizard must be used within a WizardProvider');
	}

	return context;
}

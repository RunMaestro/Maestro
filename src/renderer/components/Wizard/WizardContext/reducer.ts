import type { WizardAction, WizardState } from './types';
import { getNextStep, getPreviousStep } from './navigation';

export const initialState: WizardState = {
	currentStep: 'agent-selection',
	isOpen: false,
	selectedAgent: null,
	availableAgents: [],
	agentName: '',
	customPath: undefined,
	customArgs: undefined,
	customEnvVars: undefined,
	enableMaestroP: undefined,
	maestroPMode: undefined,
	maestroPPath: undefined,
	sessionSshRemoteConfig: undefined,
	directoryPath: '',
	additionalDirectories: [],
	isGitRepo: false,
	detectedAgentPath: null,
	directoryError: null,
	hasExistingAutoRunDocs: false,
	existingDocsCount: 0,
	existingDocsChoice: null,
	conversationHistory: [],
	confidenceLevel: 0,
	isReadyToProceed: false,
	isConversationLoading: false,
	conversationError: null,
	generatedDocuments: [],
	currentDocumentIndex: 0,
	isGeneratingDocuments: false,
	generationError: null,
	editedPhase1Content: null,
	autoRunMode: 'all',
	wantsTour: true,
	isComplete: false,
	createdSessionId: null,
};

export function wizardReducer(state: WizardState, action: WizardAction): WizardState {
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
		case 'SET_ENABLE_MAESTRO_P':
			return { ...state, enableMaestroP: action.value };
		case 'SET_MAESTRO_P_MODE':
			return { ...state, maestroPMode: action.mode };
		case 'SET_MAESTRO_P_PATH':
			return { ...state, maestroPPath: action.path };
		case 'SET_SESSION_SSH_REMOTE_CONFIG':
			return { ...state, sessionSshRemoteConfig: action.config };
		case 'SET_DIRECTORY_PATH':
			return { ...state, directoryPath: action.path, directoryError: null };
		case 'SET_ADDITIONAL_DIRECTORIES':
			return { ...state, additionalDirectories: action.directories };
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
		case 'SET_AUTO_RUN_MODE':
			return { ...state, autoRunMode: action.mode };
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

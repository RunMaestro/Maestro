import {
	createContext,
	useContext,
	useCallback,
	useReducer,
	useEffect,
	useRef,
	useMemo,
} from 'react';
import type { AdditionalDirectory, ToolType, AgentConfig } from '../../types';
import { captureException } from '../../utils/sentry';
import { STEP_INDEX, INDEX_TO_STEP, WIZARD_TOTAL_STEPS } from './WizardContext/constants';
import { generateMessageId } from './WizardContext/messageIds';
import {
	buildSerializableWizardState,
	hasSavedResumeState,
	isResumeStateLoadable,
} from './WizardContext/persistence';
import { initialState, wizardReducer } from './WizardContext/reducer';
import type {
	GeneratedDocument,
	SerializableWizardState,
	WizardAutoRunMode,
	WizardContextAPI,
	WizardMessage,
	WizardProviderProps,
	WizardSessionSshRemoteConfig,
	WizardState,
	WizardStep,
} from './WizardContext/types';

export { WIZARD_TOTAL_STEPS, STEP_INDEX, INDEX_TO_STEP };
export type {
	GeneratedDocument,
	SerializableWizardState,
	WizardAutoRunMode,
	WizardContextAPI,
	WizardMessage,
	WizardSessionSshRemoteConfig,
	WizardState,
	WizardStep,
};

const WizardContext = createContext<WizardContextAPI | null>(null);

async function setWizardResumeStateAsync(
	value: SerializableWizardState | null,
	functionName: string
): Promise<void> {
	try {
		await window.maestro.settings.set('wizardResumeState', value);
	} catch (error) {
		captureException(error, {
			extra: {
				source: 'WizardContext',
				function: functionName,
				functionName,
				setting: 'wizardResumeState',
			},
		});
		throw error;
	}
}

export function WizardProvider({ children }: WizardProviderProps) {
	const [state, dispatch] = useReducer(wizardReducer, initialState);

	const openWizard = useCallback(() => {
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
				return state.selectedAgent !== null && state.agentName.trim() !== '';
			case 'directory-selection':
				return state.directoryPath.trim() !== '' && state.directoryError === null;
			case 'conversation':
				return state.isReadyToProceed;
			case 'phase-review':
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

	const setEnableMaestroP = useCallback((value: boolean | undefined) => {
		dispatch({ type: 'SET_ENABLE_MAESTRO_P', value });
	}, []);

	const setMaestroPMode = useCallback((mode: 'interactive' | 'dynamic') => {
		dispatch({ type: 'SET_MAESTRO_P_MODE', mode });
	}, []);

	const setMaestroPPath = useCallback((path: string | undefined) => {
		dispatch({ type: 'SET_MAESTRO_P_PATH', path });
	}, []);

	const setSessionSshRemoteConfig = useCallback(
		(config: WizardSessionSshRemoteConfig | undefined) => {
			dispatch({ type: 'SET_SESSION_SSH_REMOTE_CONFIG', config });
		},
		[]
	);

	const setDirectoryPath = useCallback((path: string) => {
		dispatch({ type: 'SET_DIRECTORY_PATH', path });
	}, []);

	const setAdditionalDirectories = useCallback((directories: AdditionalDirectory[]) => {
		dispatch({ type: 'SET_ADDITIONAL_DIRECTORIES', directories });
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
		if (state.editedPhase1Content !== null) {
			return state.editedPhase1Content;
		}
		const phase1Doc = state.generatedDocuments[0];
		return phase1Doc?.content || '';
	}, [state.editedPhase1Content, state.generatedDocuments]);

	const setAutoRunMode = useCallback((mode: WizardAutoRunMode) => {
		dispatch({ type: 'SET_AUTO_RUN_MODE', mode });
	}, []);

	const setWantsTour = useCallback((wantsTour: boolean) => {
		dispatch({ type: 'SET_WANTS_TOUR', wantsTour });
	}, []);

	const completeWizard = useCallback(async (sessionId: string | null) => {
		await setWizardResumeStateAsync(null, 'completeWizard');
		dispatch({ type: 'SET_COMPLETE', sessionId });
	}, []);

	const getSerializableState = useCallback((): SerializableWizardState => {
		return buildSerializableWizardState(state);
	}, [state]);

	const saveStateForResume = useCallback(async () => {
		await setWizardResumeStateAsync(getSerializableState(), 'saveStateForResume');
	}, [getSerializableState]);

	const restoreState = useCallback((savedState: Partial<WizardState>) => {
		dispatch({ type: 'RESTORE_STATE', state: savedState });
	}, []);

	const hasResumeState = useCallback(async (): Promise<boolean> => {
		try {
			const saved = await window.maestro.settings.get('wizardResumeState');
			return hasSavedResumeState(saved) && isResumeStateLoadable(saved);
		} catch (error) {
			captureException(error, {
				extra: {
					context: 'wizardResumeState read',
					functionName: 'hasResumeState',
				},
			});
			throw error;
		}
	}, []);

	const loadResumeState = useCallback(async (): Promise<SerializableWizardState | null> => {
		try {
			const saved = await window.maestro.settings.get('wizardResumeState');
			return isResumeStateLoadable(saved) ? saved : null;
		} catch (error) {
			captureException(error, {
				extra: {
					context: 'wizardResumeState read',
					functionName: 'loadResumeState',
				},
			});
			throw error;
		}
	}, []);

	const clearResumeState = useCallback(async () => {
		await setWizardResumeStateAsync(null, 'clearResumeState');
	}, []);

	const stateRef = useRef(state);
	stateRef.current = state;

	useEffect(() => {
		if (STEP_INDEX[state.currentStep] > 1) {
			void setWizardResumeStateAsync(
				buildSerializableWizardState(stateRef.current),
				'autoSaveResumeState'
			);
		}
	}, [state.currentStep]);

	const contextValue: WizardContextAPI = useMemo(
		() => ({
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
			setEnableMaestroP,
			setMaestroPMode,
			setMaestroPPath,
			setSessionSshRemoteConfig,
			setDirectoryPath,
			setAdditionalDirectories,
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
			setAutoRunMode,
			setWantsTour,
			completeWizard,
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
			setEnableMaestroP,
			setMaestroPMode,
			setMaestroPPath,
			setSessionSshRemoteConfig,
			setDirectoryPath,
			setAdditionalDirectories,
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
			setAutoRunMode,
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

export function useWizard(): WizardContextAPI {
	const context = useContext(WizardContext);

	if (!context) {
		throw new Error('useWizard must be used within a WizardProvider');
	}

	return context;
}

import { STEP_INDEX } from './constants';
import type { SerializableWizardState, WizardState } from './types';

const CANONICAL_WIZARD_STEPS = Object.keys(STEP_INDEX);

export function buildSerializableWizardState(state: WizardState): SerializableWizardState {
	return {
		currentStep: state.currentStep,
		selectedAgent: state.selectedAgent,
		agentName: state.agentName,
		directoryPath: state.directoryPath,
		additionalDirectories: state.additionalDirectories,
		isGitRepo: state.isGitRepo,
		conversationHistory: state.conversationHistory,
		confidenceLevel: state.confidenceLevel,
		isReadyToProceed: state.isReadyToProceed,
		generatedDocuments: state.generatedDocuments,
		editedPhase1Content: state.editedPhase1Content,
		autoRunMode: state.autoRunMode,
		wantsTour: state.wantsTour,
		sessionSshRemoteConfig: state.sessionSshRemoteConfig,
	};
}

export function isResumeStateLoadable(saved: unknown): saved is SerializableWizardState {
	if (!saved || typeof saved !== 'object') return false;
	const state = saved as Partial<SerializableWizardState>;
	if (typeof state.currentStep !== 'string') return false;
	return (
		CANONICAL_WIZARD_STEPS.includes(state.currentStep) && state.currentStep !== 'agent-selection'
	);
}

export function hasSavedResumeState(saved: unknown): boolean {
	return saved !== undefined && saved !== null && typeof saved === 'object';
}

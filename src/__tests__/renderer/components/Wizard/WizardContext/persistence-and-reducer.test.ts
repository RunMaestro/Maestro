import { describe as __maestroMicrobenchDescribe } from 'vitest';
import { describe } from 'vitest';
import { expect } from 'vitest';
import { it } from 'vitest';
import { buildSerializableWizardState } from '../../../../../renderer/components/Wizard/WizardContext/persistence';
import { hasSavedResumeState } from '../../../../../renderer/components/Wizard/WizardContext/persistence';
import { isResumeStateLoadable } from '../../../../../renderer/components/Wizard/WizardContext/persistence';
import { initialState } from '../../../../../renderer/components/Wizard/WizardContext/reducer';
import { INDEX_TO_STEP } from '../../../../../renderer/components/Wizard/WizardContext';
import { STEP_INDEX } from '../../../../../renderer/components/Wizard/WizardContext';
import { wizardReducer } from '../../../../../renderer/components/Wizard/WizardContext/reducer';
import { getNextStep } from '../../../../../renderer/components/Wizard/WizardContext/navigation';
import { getPreviousStep } from '../../../../../renderer/components/Wizard/WizardContext/navigation';
__maestroMicrobenchDescribe('persistence', () => {
	describe('WizardContext persistence helpers', () => {
		it('serializes resumable wizard state with SSH remote config', () => {
			const serializable = buildSerializableWizardState({
				...initialState,
				currentStep: 'directory-selection',
				selectedAgent: 'claude-code',
				agentName: 'Remote Project',
				directoryPath: '/srv/project',
				isGitRepo: true,
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: 'remote-1',
					workingDirOverride: '/srv',
				},
			});

			expect(serializable).toEqual(
				expect.objectContaining({
					currentStep: 'directory-selection',
					selectedAgent: 'claude-code',
					agentName: 'Remote Project',
					directoryPath: '/srv/project',
					isGitRepo: true,
					sessionSshRemoteConfig: {
						enabled: true,
						remoteId: 'remote-1',
						workingDirOverride: '/srv',
					},
				})
			);
			expect(serializable).not.toHaveProperty('isOpen');
			expect(serializable).not.toHaveProperty('isGeneratingDocuments');
		});

		it('accepts saved object state but only loads states past the first step', () => {
			expect(hasSavedResumeState({ currentStep: 'agent-selection' })).toBe(true);
			expect(hasSavedResumeState(null)).toBe(false);
			expect(hasSavedResumeState(undefined)).toBe(false);
			expect(hasSavedResumeState('nope')).toBe(false);

			expect(isResumeStateLoadable({ currentStep: 'conversation' })).toBe(true);
			expect(isResumeStateLoadable({ currentStep: 'agent-selection' })).toBe(false);
			expect(isResumeStateLoadable({ currentStep: 'unknown-step' })).toBe(false);
			expect(isResumeStateLoadable({ currentStep: 3 })).toBe(false);
			expect(isResumeStateLoadable({})).toBe(false);
		});
	});
});
__maestroMicrobenchDescribe('reducer', () => {
	describe('WizardContext reducer internals', () => {
		it('moves through wizard steps using the canonical step maps', () => {
			expect(getNextStep('agent-selection')).toBe('directory-selection');
			expect(getNextStep('phase-review')).toBeNull();
			expect(getPreviousStep('phase-review')).toBe('preparing-plan');
			expect(getPreviousStep('agent-selection')).toBeNull();

			for (const [step, index] of Object.entries(STEP_INDEX)) {
				expect(INDEX_TO_STEP[index]).toBe(step);
			}
		});

		it('resets, restores, and preserves SSH remote config through actions', () => {
			const withRemote = wizardReducer(initialState, {
				type: 'SET_SESSION_SSH_REMOTE_CONFIG',
				config: { enabled: true, remoteId: 'remote-1' },
			});

			expect(withRemote.sessionSshRemoteConfig).toEqual({ enabled: true, remoteId: 'remote-1' });

			const restored = wizardReducer(withRemote, {
				type: 'RESTORE_STATE',
				state: {
					currentStep: 'conversation',
					agentName: 'Restored',
				},
			});

			expect(restored.currentStep).toBe('conversation');
			expect(restored.agentName).toBe('Restored');
			expect(restored.sessionSshRemoteConfig).toEqual({ enabled: true, remoteId: 'remote-1' });

			expect(wizardReducer(restored, { type: 'RESET_WIZARD' })).toEqual(initialState);
		});
	});
});

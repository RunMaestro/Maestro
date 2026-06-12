import { describe, expect, it } from 'vitest';
import {
	buildSerializableWizardState,
	hasSavedResumeState,
	isResumeStateLoadable,
} from '../../../../../renderer/components/Wizard/WizardContext/persistence';
import { initialState } from '../../../../../renderer/components/Wizard/WizardContext/reducer';

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

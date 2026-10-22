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

	it('serializes the three peer sources so a resumed wizard keeps them', () => {
		const peerAgents = [
			{ sessionId: 'agent-a', read: true, write: false, description: 'Docs' },
			// Neither square lit: an exclusion, and it must survive the round trip.
			{ sessionId: 'agent-b', read: false, write: false },
		];

		const serializable = buildSerializableWizardState({
			...initialState,
			currentStep: 'conversation',
			peerAgents,
			groupPeerAccess: { read: true, write: false },
			worktreePeerAccess: { read: true, write: true },
		});

		expect(serializable.peerAgents).toEqual(peerAgents);
		expect(serializable.groupPeerAccess).toEqual({ read: true, write: false });
		expect(serializable.worktreePeerAccess).toEqual({ read: true, write: true });
		// What the settings store keeps is JSON: a grant that is off stays absent.
		const saved = JSON.parse(JSON.stringify(buildSerializableWizardState(initialState)));
		expect(saved.peerAgents).toEqual([]);
		expect(saved).not.toHaveProperty('groupPeerAccess');
		expect(saved).not.toHaveProperty('worktreePeerAccess');
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

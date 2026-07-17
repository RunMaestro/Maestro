import { describe, expect, it } from 'vitest';
import { INDEX_TO_STEP, STEP_INDEX } from '../../../../../renderer/components/Wizard/WizardContext';
import {
	initialState,
	wizardReducer,
} from '../../../../../renderer/components/Wizard/WizardContext/reducer';
import {
	getNextStep,
	getPreviousStep,
} from '../../../../../renderer/components/Wizard/WizardContext/navigation';

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

	it('clears provider-specific overrides when selecting a different agent', () => {
		const cursorState = {
			...initialState,
			selectedAgent: 'cursor-cli' as const,
			customPath: '/cursor/agent',
			customArgs: '--cursor-only',
			customEnvVars: { CURSOR_API_KEY: 'key' },
			agentConfigValues: { model: 'cursor-model', contextWindow: 200000 },
		};

		const switched = wizardReducer(cursorState, {
			type: 'SET_SELECTED_AGENT',
			agent: 'claude-code',
		});

		expect(switched.selectedAgent).toBe('claude-code');
		expect(switched.customPath).toBeUndefined();
		expect(switched.customArgs).toBeUndefined();
		expect(switched.customEnvVars).toBeUndefined();
		expect(switched.agentConfigValues).toBeUndefined();
	});
});

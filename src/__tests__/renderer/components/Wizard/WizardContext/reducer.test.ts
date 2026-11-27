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

	it('starts with no peer grants', () => {
		expect(initialState.peerAgents).toEqual([]);
		expect(initialState.groupPeerAccess).toBeUndefined();
		expect(initialState.worktreePeerAccess).toBeUndefined();
	});

	it('sets each of the three peer sources and leaves the other two alone', () => {
		const peers = [{ sessionId: 'agent-a', read: true, write: false, description: 'Docs' }];

		const withRows = wizardReducer(initialState, { type: 'SET_PEER_AGENTS', peers });
		expect(withRows.peerAgents).toBe(peers);
		expect(withRows.groupPeerAccess).toBeUndefined();
		expect(withRows.worktreePeerAccess).toBeUndefined();

		const withGroup = wizardReducer(withRows, {
			type: 'SET_GROUP_PEER_ACCESS',
			access: { read: true, write: true },
		});
		const withBoth = wizardReducer(withGroup, {
			type: 'SET_WORKTREE_PEER_ACCESS',
			access: { read: true, write: false },
		});
		expect(withBoth.peerAgents).toBe(peers);
		expect(withBoth.groupPeerAccess).toEqual({ read: true, write: true });
		expect(withBoth.worktreePeerAccess).toEqual({ read: true, write: false });
	});

	it('switches a grant off by storing it as absent', () => {
		const on = wizardReducer(initialState, {
			type: 'SET_GROUP_PEER_ACCESS',
			access: { read: true, write: false },
		});
		const off = wizardReducer(on, { type: 'SET_GROUP_PEER_ACCESS', access: undefined });

		expect(off.groupPeerAccess).toBeUndefined();
	});

	it('clears the peer grants on reset', () => {
		const dirty = wizardReducer(
			wizardReducer(initialState, {
				type: 'SET_PEER_AGENTS',
				peers: [{ sessionId: 'agent-a', read: true, write: true }],
			}),
			{ type: 'SET_WORKTREE_PEER_ACCESS', access: { read: true, write: false } }
		);

		expect(wizardReducer(dirty, { type: 'RESET_WIZARD' })).toEqual(initialState);
	});
});

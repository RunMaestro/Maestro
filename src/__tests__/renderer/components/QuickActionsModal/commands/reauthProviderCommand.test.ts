/**
 * Tests for the Command K entry that signs the current agent's provider in
 * again, before anything has failed.
 *
 * The value of the command is that it lands on the SAME dialog the expired
 * credentials prompt uses, so these check the wiring rather than the login: the
 * outage the modal reads, the provider it is keyed to, and the agents that have
 * no login at all and must not be offered one.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { buildSessionManagementCommands } from '../../../../../renderer/components/QuickActionsModal/commands/sessionCommands';
import { useAuthOutageStore } from '../../../../../renderer/stores/authOutageStore';
import { useModalStore } from '../../../../../renderer/stores/modalStore';
import { useSessionStore } from '../../../../../renderer/stores/sessionStore';
import { createMockSession } from '../../../../helpers/mockSession';
import type { QuickAction } from '../../../../../renderer/components/QuickActionsModal/types';
import type { Session } from '../../../../../renderer/types';

const setQuickActionOpen = vi.fn();

function build(activeSession: Session | undefined): QuickAction[] {
	return buildSessionManagementCommands({
		activeSession,
		activeSessionId: activeSession?.id ?? '',
		sessions: activeSession ? [activeSession] : [],
		setSessions: vi.fn(),
		setQuickActionOpen,
		setRenameInstanceModalOpen: vi.fn(),
		setRenameInstanceValue: vi.fn(),
		deleteSession: vi.fn(),
		openClearBookmarksConfirm: vi.fn(),
	});
}

function find(commands: QuickAction[]): QuickAction | undefined {
	return commands.find((c) => c.id === 'reauthenticateProvider');
}

beforeEach(() => {
	vi.clearAllMocks();
	useAuthOutageStore.setState({ outages: {} });
	useModalStore.getState().closeModal('reauth');
	useSessionStore.setState({ sessions: [] } as never);
});

describe('Re-authenticate Provider command', () => {
	it('names the provider rather than the agent, because the login is shared', () => {
		const session = createMockSession({ id: 's1', name: 'Atlas', toolType: 'codex' });

		expect(find(build(session))?.label).toBe('Re-authenticate Provider: Codex');
	});

	// The Terminal agent is a plain shell: there is no login flow to run, and
	// offering one would open a dialog that can only sit there.
	it('is hidden for an agent with no login flow', () => {
		const terminal = createMockSession({ id: 's1', name: 'Shell', toolType: 'terminal' });

		expect(find(build(terminal))).toBeUndefined();
	});

	it('is hidden when there is no active agent', () => {
		expect(find(build(undefined))).toBeUndefined();
	});

	// The dialog is keyed to the provider, so it can only open once the outage
	// record exists for that key.
	it('opens the re-authentication dialog on the agent provider', async () => {
		const session = createMockSession({ id: 's1', name: 'Atlas', toolType: 'claude-code' });
		useSessionStore.setState({ sessions: [session] } as never);

		await find(build(session))!.action();

		expect(useModalStore.getState().getData('reauth')).toEqual({ providerKey: 'claude-code' });
		const outage = useAuthOutageStore.getState().outages['claude-code'];
		// Marked as the user's own login so the dialog does not claim the agent is
		// stopped, and carrying no lost turn to replay.
		expect(outage.initiatedBy).toBe('user');
		expect(outage.blocked).toEqual([{ sessionId: 's1', tabIds: [] }]);
		expect(setQuickActionOpen).toHaveBeenCalledWith(false);
	});

	// A remote agent authenticates on the remote host, so it must not be keyed to
	// (or resolved by) the local credential store.
	it('keys an SSH agent to its remote credential store', async () => {
		const session = createMockSession({
			id: 's1',
			name: 'Remote',
			toolType: 'claude-code',
			sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
		});
		useSessionStore.setState({ sessions: [session] } as never);

		await find(build(session))!.action();

		const providerKey = useModalStore.getState().getData('reauth')?.providerKey;
		expect(providerKey).not.toBe('claude-code');
		expect(useAuthOutageStore.getState().outages[providerKey!].sshRemoteId).toBe('remote-1');
	});
});

import React from 'react';
import { render as rtlRender, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
	SshUnreachableModal,
	agentsOnRemote,
} from '../../../renderer/components/SshUnreachableModal';
import { useSshOutageStore } from '../../../renderer/stores/sshOutageStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import { AGENT_MODES, createMockSession, createModeSession } from '../../helpers/mockSession';
import { mockTheme } from '../../helpers/mockTheme';
import type { Session } from '../../../renderer/types';

const render = (ui: React.ReactElement) => rtlRender(<LayerStackProvider>{ui}</LayerStackProvider>);

const MESSAGE = 'Unable to connect to "pedtome" over SSH. tailcat Ping: context deadline exceeded';

function onRemote(id: string, name: string, remoteId: string): Session {
	return createMockSession({
		id,
		name,
		sessionSshRemoteConfig: { enabled: true, remoteId },
	} as Partial<Session>);
}

/** Put the user on an agent: one on `remoteId`, or a local one when undefined. */
function lookAt(remoteId?: string) {
	const active = remoteId
		? onRemote('active', 'Active', remoteId)
		: createMockSession({ id: 'active', name: 'Local' });
	useSessionStore.setState({ sessions: [active], activeSessionId: 'active' } as any);
}

/** Record an outage and put the user on an agent of that remote, so it shows. */
function openOutage(remoteId = 'remote-1', remoteName = 'pedtome') {
	lookAt(remoteId);
	recordOutage(remoteId, remoteName);
}

/** Record an outage only, as background work on another agent would. */
function recordOutage(remoteId = 'remote-1', remoteName = 'pedtome') {
	useSshOutageStore.getState().applyReachability({
		remoteId,
		remoteName,
		reachable: false,
		message: MESSAGE,
		since: Date.now() - 60_000,
	});
}

let checkReachability: ReturnType<typeof vi.fn>;

beforeEach(() => {
	useSshOutageStore.setState({ outages: {} });
	lookAt(undefined);
	checkReachability = vi.fn();
	(window as any).maestro = {
		...((window as any).maestro || {}),
		sshRemote: { checkReachability },
	};
});

describe('agentsOnRemote', () => {
	it('matches agents configured on the remote, and only those', () => {
		const sessions = [
			onRemote('a', 'Tome: Substrate', 'remote-1'),
			onRemote('b', 'Tome: Kensho', 'remote-1'),
			onRemote('c', 'Elsewhere', 'remote-2'),
			createMockSession({ id: 'd', name: 'Local' }),
			createMockSession({
				id: 'e',
				name: 'Disabled',
				sessionSshRemoteConfig: { enabled: false, remoteId: 'remote-1' },
			} as Partial<Session>),
		];
		expect(agentsOnRemote(sessions, 'remote-1').map((s) => s.id)).toEqual(['a', 'b']);
	});
});

describe('SshUnreachableModal', () => {
	it('renders nothing while no remote is down', () => {
		render(<SshUnreachableModal theme={mockTheme} sessions={[]} />);
		expect(screen.queryByTestId('ssh-unreachable-modal')).toBeNull();
	});

	it('names the remote, shows why, and lists the agents that cannot work', () => {
		openOutage();
		render(
			<SshUnreachableModal
				theme={mockTheme}
				sessions={[
					onRemote('a', 'Tome: Substrate', 'remote-1'),
					onRemote('b', 'Tome: Kensho', 'remote-1'),
				]}
			/>
		);

		expect(screen.getByText('Can\'t reach "pedtome" over SSH')).toBeTruthy();
		expect(screen.getByText(MESSAGE)).toBeTruthy();
		expect(screen.getByText('Tome: Substrate, Tome: Kensho')).toBeTruthy();
	});

	it('Dismiss hides it for this outage without forgetting the outage', () => {
		openOutage();
		render(<SshUnreachableModal theme={mockTheme} sessions={[]} />);

		fireEvent.click(screen.getByText('Dismiss'));

		expect(screen.queryByTestId('ssh-unreachable-modal')).toBeNull();
		expect(useSshOutageStore.getState().outages['remote-1']?.dismissed).toBe(true);
	});

	it('Check Now probes the remote and says so when it is still down', async () => {
		openOutage();
		checkReachability.mockResolvedValue({ success: true, reachable: false });
		render(<SshUnreachableModal theme={mockTheme} sessions={[]} />);

		fireEvent.click(screen.getByTestId('ssh-unreachable-check-now'));

		await waitFor(() => expect(screen.getByText('Still unreachable.')).toBeTruthy());
		expect(checkReachability).toHaveBeenCalledWith('remote-1');
	});

	it('closes when the recovery push arrives', () => {
		openOutage();
		const { rerender } = render(<SshUnreachableModal theme={mockTheme} sessions={[]} />);
		expect(screen.getByTestId('ssh-unreachable-modal')).toBeTruthy();

		useSshOutageStore.getState().applyReachability({
			remoteId: 'remote-1',
			remoteName: 'pedtome',
			reachable: true,
			since: Date.now(),
		});
		rerender(
			<LayerStackProvider>
				<SshUnreachableModal theme={mockTheme} sessions={[]} />
			</LayerStackProvider>
		);

		expect(screen.queryByTestId('ssh-unreachable-modal')).toBeNull();
	});

	describe('only when it matters', () => {
		it('stays hidden while the user works on an agent of another remote or a local one', () => {
			lookAt(undefined);
			recordOutage('remote-1');
			render(<SshUnreachableModal theme={mockTheme} sessions={[]} />);
			expect(screen.queryByTestId('ssh-unreachable-modal')).toBeNull();

			lookAt('remote-2');
			expect(screen.queryByTestId('ssh-unreachable-modal')).toBeNull();
			expect(useSshOutageStore.getState().outages['remote-1'].surfaced).toBe(false);
		});

		it('appears when the user goes to an agent on the down remote, and marks it surfaced', async () => {
			recordOutage('remote-1');
			render(<SshUnreachableModal theme={mockTheme} sessions={[]} />);
			expect(screen.queryByTestId('ssh-unreachable-modal')).toBeNull();

			lookAt('remote-1');

			await waitFor(() => expect(screen.getByTestId('ssh-unreachable-modal')).toBeTruthy());
			expect(useSshOutageStore.getState().outages['remote-1'].surfaced).toBe(true);
		});

		it('appears wherever the user is when a live turn surfaced it', async () => {
			lookAt('remote-2');
			recordOutage('remote-1');
			useSshOutageStore.getState().surface('remote-1');
			render(<SshUnreachableModal theme={mockTheme} sessions={[]} />);
			expect(screen.getByTestId('ssh-unreachable-modal')).toBeTruthy();
		});
	});

	describe('mode parity', () => {
		/** The dialog's markup with the user on `active`, for an outage on the mode helper's remote. */
		function dialogFor(active: Session, sessions: Session[], surfaced = false): string | null {
			useSshOutageStore.setState({ outages: {} });
			useSessionStore.setState({ sessions: [active], activeSessionId: active.id } as any);
			recordOutage('r1');
			if (surfaced) useSshOutageStore.getState().surface('r1');
			const { unmount } = render(<SshUnreachableModal theme={mockTheme} sessions={sessions} />);
			const html = screen.queryByTestId('ssh-unreachable-modal')?.outerHTML ?? null;
			unmount();
			return html;
		}

		const agents = () =>
			AGENT_MODES.map((mode) => createModeSession(mode, { id: mode, name: `Agent ${mode}` }));

		it('an SSH and a hosted agent on the down remote open the same dialog and both surface it', () => {
			const ssh = dialogFor(createModeSession('ssh', { id: 'active' }), agents());
			expect(ssh).not.toBeNull();
			expect(useSshOutageStore.getState().outages['r1'].surfaced).toBe(true);

			const hosted = dialogFor(createModeSession('hosted', { id: 'active' }), agents());
			expect(useSshOutageStore.getState().outages['r1'].surfaced).toBe(true);
			expect(hosted).toBe(ssh);
		});

		it('lists an SSH and a hosted agent of the remote alike, and a local agent never', () => {
			expect(agentsOnRemote(agents(), 'r1').map((s) => s.id)).toEqual(['ssh', 'hosted']);
		});

		it('a surfaced outage draws the same dialog whichever mode the user is looking at', () => {
			const html = AGENT_MODES.map((mode) =>
				dialogFor(createModeSession(mode, { id: 'active' }), agents(), true)
			);
			expect(html[0]).not.toBeNull();
			expect(html[1]).toBe(html[0]);
			expect(html[2]).toBe(html[0]);
		});
	});
});

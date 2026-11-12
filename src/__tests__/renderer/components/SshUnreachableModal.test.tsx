import React from 'react';
import { render as rtlRender, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
	SshUnreachableModal,
	agentsOnRemote,
} from '../../../renderer/components/SshUnreachableModal';
import { useSshOutageStore } from '../../../renderer/stores/sshOutageStore';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import { createMockSession } from '../../helpers/mockSession';
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

function openOutage(remoteId = 'remote-1', remoteName = 'pedtome') {
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
});

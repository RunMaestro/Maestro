/**
 * The Left Bar row's SSH chip reads the SSH outage store passively: a down remote turns it red
 * and struck through, and nothing else. It must never surface the outage dialog.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionFederationBadge } from '../../../../renderer/components/SessionList/SessionFederationBadge';
import { useSshOutageStore } from '../../../../renderer/stores/sshOutageStore';
import { mockTheme } from '../../../helpers/mockTheme';

const session = {
	id: 'agent-1',
	liftedTo: undefined,
	sshRemoteId: undefined,
	sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1', workingDirOverride: undefined },
};

const downEvent = {
	remoteId: 'remote-1',
	remoteName: 'build-box',
	reachable: false,
	message: 'Connection timed out.',
	since: Date.now() - 60_000,
};

afterEach(() => {
	useSshOutageStore.setState({ outages: {} });
});

describe('SessionFederationBadge', () => {
	it('shows the amber, unstruck chip while the remote is reachable', () => {
		render(<SessionFederationBadge theme={mockTheme} session={session} />);
		const badge = screen.getByTestId('federation-badge-ssh');
		expect(badge).toHaveStyle({ color: mockTheme.colors.warning });
		expect(badge.style.textDecoration).toBe('');
	});

	it('turns red and struck through when its remote is down, without surfacing the dialog', () => {
		useSshOutageStore.getState().applyReachability(downEvent);
		render(<SessionFederationBadge theme={mockTheme} session={session} />);

		const badge = screen.getByTestId('federation-badge-ssh');
		expect(badge).toHaveTextContent('SSH');
		expect(badge).toHaveStyle({ color: mockTheme.colors.error });
		expect(badge.style.textDecoration).toBe('line-through');

		fireEvent.mouseEnter(badge.parentElement as HTMLElement);
		expect(screen.getByTestId('federation-badge-unreachable')).toHaveTextContent(
			/^Can't reach "build-box" over SSH since .+\. Connection timed out\.$/
		);

		const outage = useSshOutageStore.getState().outages['remote-1'];
		expect(outage.surfaced).toBe(false);
		expect(outage.dismissed).toBe(false);
	});

	it('ignores an outage on a different remote', () => {
		useSshOutageStore.getState().applyReachability({ ...downEvent, remoteId: 'remote-2' });
		render(<SessionFederationBadge theme={mockTheme} session={session} />);
		expect(screen.getByTestId('federation-badge-ssh')).toHaveStyle({
			color: mockTheme.colors.warning,
		});
	});

	it('goes back to amber when the remote recovers', () => {
		useSshOutageStore.getState().applyReachability(downEvent);
		render(<SessionFederationBadge theme={mockTheme} session={session} />);
		expect(screen.getByTestId('federation-badge-ssh').style.textDecoration).toBe('line-through');

		act(() => {
			useSshOutageStore
				.getState()
				.applyReachability({ ...downEvent, reachable: true, since: Date.now() });
		});
		const badge = screen.getByTestId('federation-badge-ssh');
		expect(badge).toHaveStyle({ color: mockTheme.colors.warning });
		expect(badge.style.textDecoration).toBe('');
	});
});

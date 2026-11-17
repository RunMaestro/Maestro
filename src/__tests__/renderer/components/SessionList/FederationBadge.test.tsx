/**
 * The Left Bar's Federation badge: `SSH` or `Federated`, and a hover card that explains the
 * difference and names the next step for an SSH agent.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
	FederationBadge,
	federationBadgeCopy,
	hostedConnectionTone,
} from '../../../../renderer/components/SessionList/FederationBadge';
import { mockTheme } from '../../../helpers/mockTheme';

describe('federationBadgeCopy', () => {
	it('explains a hosted agent: leads with the benefit, then who owns it', () => {
		const copy = federationBadgeCopy({ kind: 'hosted', peerName: 'build' });
		expect(copy.label).toBe('Hosted');
		expect(copy.title).toBe('Hosted on build');
		expect(copy.lines[0]).toBe('Keeps running while this machine sleeps or is off.');
		expect(copy.lines[1]).toMatch(/Maestro host on build owns this agent/);
		// Connected: no status line.
		expect(
			federationBadgeCopy({ kind: 'hosted', peerName: 'build', connection: 'connected' }).lines
		).toHaveLength(2);
	});

	it("says when a hosted agent's host is out of reach, and why", () => {
		const down = federationBadgeCopy({
			kind: 'hosted',
			peerName: 'build',
			connection: 'lost',
			error: 'ssh timed out',
		});
		expect(down.lines.slice(2)).toEqual([
			'Not connected to build. Showing the last known state. Right-click > Reconnect.',
			'ssh timed out',
		]);
		const pending = federationBadgeCopy({
			kind: 'hosted',
			peerName: 'build',
			connection: 'reconnecting',
		});
		expect(pending.lines.at(-1)).toBe('Connecting to build.');
	});

	it('explains an SSH agent and names the next step', () => {
		const base = { kind: 'ssh' as const, remoteName: 'build' };
		const install = federationBadgeCopy({ ...base, hostReady: false, canFederate: true });
		expect(install.label).toBe('SSH');
		expect(install.title).toBe('SSH agent on build');
		expect(install.lines[0]).toMatch(/^Stops when this machine sleeps/);
		expect(install.lines.at(-1)).toMatch(/Move to Host: Maestro sets up a host/);

		const ready = federationBadgeCopy({ ...base, hostReady: true, canFederate: true });
		expect(ready.lines.at(-1)).toMatch(/Move to Host/);

		const off = federationBadgeCopy({ ...base, hostReady: false, canFederate: false });
		expect(off.lines.at(-1)).toMatch(/does not reach this remote right now/);
	});
});

describe('hostedConnectionTone', () => {
	it('reads connected as live, (re)connecting or unknown as pending, anything else as down', () => {
		expect(hostedConnectionTone('connected')).toBe('live');
		expect(hostedConnectionTone('reconnecting')).toBe('pending');
		expect(hostedConnectionTone('connecting')).toBe('pending');
		expect(hostedConnectionTone(undefined)).toBe('pending');
		expect(hostedConnectionTone('lost')).toBe('down');
		expect(hostedConnectionTone('host-down')).toBe('down');
	});
});

describe('FederationBadge', () => {
	it('shows the label and the explanation on hover', () => {
		render(
			<FederationBadge
				theme={mockTheme}
				mode={{ kind: 'ssh', remoteName: 'build', hostReady: false, canFederate: true }}
			/>
		);
		const badge = screen.getByTestId('federation-badge-ssh');
		expect(badge).toHaveTextContent('SSH');
		fireEvent.mouseEnter(badge.parentElement as HTMLElement);
		expect(screen.getByTestId('federation-badge-card')).toHaveTextContent('SSH agent on build');
	});

	it('turns red with the reason and the fix when automatic Federation is blocked', () => {
		render(
			<FederationBadge
				theme={mockTheme}
				mode={{
					kind: 'ssh',
					remoteName: 'build',
					hostReady: true,
					canFederate: true,
					auto: {
						state: 'blocked',
						reason: 'Claude Code is not available.',
						fix: 'Install Claude Code.',
					},
				}}
			/>
		);
		const badge = screen.getByTestId('federation-badge-ssh');
		fireEvent.mouseEnter(badge.parentElement as HTMLElement);
		expect(screen.getByTestId('federation-badge-card')).toHaveTextContent(
			'Claude Code is not available.'
		);
		expect(screen.getByTestId('federation-badge-fix')).toHaveTextContent(
			'To fix: Install Claude Code.'
		);
	});

	it('says an agent moves on its own while automatic Federation waits on it', () => {
		const copy = federationBadgeCopy({
			kind: 'ssh',
			hostReady: true,
			canFederate: true,
			auto: { state: 'waiting', reason: 'A turn is running.' },
		});
		expect(copy.lines.at(-1)).toBe(
			"Maestro moves it onto the remote's host automatically. A turn is running."
		);
		expect(copy.blocked).toBeUndefined();
	});
});

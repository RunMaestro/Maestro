/**
 * The Left Bar's Federation badge: `SSH` or `Federated`, and a hover card that explains the
 * difference and names the next step for an SSH agent.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
	FederationBadge,
	federationBadgeCopy,
} from '../../../../renderer/components/SessionList/FederationBadge';
import { mockTheme } from '../../../helpers/mockTheme';

describe('federationBadgeCopy', () => {
	it('explains a federated agent: owned by the host, keeps working with this machine off', () => {
		const copy = federationBadgeCopy({ kind: 'federated', peerName: 'build' });
		expect(copy.label).toBe('Federated');
		expect(copy.title).toBe('Federated agent on build');
		expect(copy.lines.join(' ')).toMatch(/keeps going while this machine sleeps/);
	});

	it('explains an SSH agent and names the next step', () => {
		const base = { kind: 'ssh' as const, remoteName: 'build' };
		const install = federationBadgeCopy({ ...base, hostReady: false, canFederate: true });
		expect(install.label).toBe('SSH');
		expect(install.title).toBe('SSH agent on build');
		expect(install.lines[0]).toMatch(/stops when this machine sleeps/);
		expect(install.lines.at(-1)).toMatch(/Make Federated/);

		const ready = federationBadgeCopy({ ...base, hostReady: true, canFederate: true });
		expect(ready.lines.at(-1)).toMatch(/Move to Host/);

		const off = federationBadgeCopy({ ...base, hostReady: false, canFederate: false });
		expect(off.lines.at(-1)).toMatch(/does not reach this remote right now/);
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
});

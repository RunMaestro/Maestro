/**
 * Tests for SshRemediationNotice.
 *
 * The point of the panel is that a user who cannot read a PowerShell parser
 * dump still learns three things: which shell answered, why that blocks remote
 * execution, and the command that fixes it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SshRemediationNotice } from '../../../../renderer/components/Settings/SshRemediationNotice';
import { nonPosixRemoteShellRemediation } from '../../../../shared/sshRemoteShell';
import { mockTheme } from '../../../helpers/mockTheme';

const openUrl = vi.fn();
vi.mock('../../../../renderer/utils/openUrl', () => ({
	openUrl: (url: string, options?: { ctrlKey?: boolean }) => openUrl(url, options),
}));

describe('SshRemediationNotice', () => {
	beforeEach(() => {
		openUrl.mockClear();
	});

	it('names the shell, explains the block, and shows the fix command', () => {
		const remediation = nonPosixRemoteShellRemediation('powershell', 'PEDSIM');
		render(<SshRemediationNotice remediation={remediation} theme={mockTheme} />);

		expect(screen.getByText(remediation.title)).toBeInTheDocument();
		expect(screen.getByText(/PEDSIM/)).toBeInTheDocument();
		expect(screen.getByText(remediation.command!)).toBeInTheDocument();
		expect(screen.getByText(remediation.commandLabel!)).toBeInTheDocument();
		expect(screen.getByTitle('Copy fix command')).toBeInTheDocument();
	});

	it('opens the docs page rather than navigating the app', () => {
		const remediation = nonPosixRemoteShellRemediation('cmd');
		render(<SshRemediationNotice remediation={remediation} theme={mockTheme} />);

		fireEvent.click(screen.getByText('Setting up a Windows remote host'));

		expect(openUrl).toHaveBeenCalledWith(remediation.docsUrl, { ctrlKey: false });
	});

	it('renders without a command or docs link', () => {
		render(
			<SshRemediationNotice
				remediation={{
					code: 'non-posix-remote-shell',
					title: 'Something went wrong',
					detail: 'A cause with no one-line fix.',
				}}
				theme={mockTheme}
			/>
		);

		expect(screen.getByText('A cause with no one-line fix.')).toBeInTheDocument();
		expect(screen.queryByTitle('Copy fix command')).not.toBeInTheDocument();
		expect(screen.queryByText('Setting up a Windows remote host')).not.toBeInTheDocument();
	});
});

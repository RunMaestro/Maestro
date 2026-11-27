/**
 * @fileoverview Tests for SshTab, the panel around SshRemoteSelector.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SshTab } from '../../../../renderer/components/AgentSettings/SshTab';
import { createMockTheme } from '../../../helpers/mockTheme';

describe('SshTab', () => {
	it('is the ssh tabpanel and renders the full-size remote selector', () => {
		render(
			<SshTab
				theme={createMockTheme()}
				idPrefix="new-agent"
				sshRemotes={[]}
				onSshRemoteConfigChange={vi.fn()}
			/>
		);

		expect(screen.getByRole('tabpanel')).toHaveAttribute('id', 'new-agent-tabpanel-ssh');
		expect(screen.getByText('SSH Remote Execution')).toBeInTheDocument();
		// The full-size selector, not the compact one nested config panels use.
		expect(
			screen.getByText('Execute this agent on a remote host via SSH instead of locally.')
		).toBeInTheDocument();
	});
});

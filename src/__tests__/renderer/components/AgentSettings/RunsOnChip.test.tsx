/**
 * @fileoverview Tests for RunsOnChip, the "Runs on" title-bar chip of the
 * agent and group settings modals.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { RunsOnChip } from '../../../../renderer/components/AgentSettings/RunsOnChip';
import { createMockTheme } from '../../../helpers/mockTheme';

describe('RunsOnChip', () => {
	it('says the agent runs locally when no SSH remote is set', () => {
		render(<RunsOnChip theme={createMockTheme()} idPrefix="edit-agent" />);
		expect(within(screen.getByTestId('edit-agent-runs-on')).getByText('Local')).toBeInTheDocument();
	});

	it('names the SSH remote the agent runs on', () => {
		render(
			<RunsOnChip theme={createMockTheme()} idPrefix="edit-agent" sshRemoteHost="build-box" />
		);
		const chip = screen.getByTestId('edit-agent-runs-on');
		expect(within(chip).getByText('build-box')).toBeInTheDocument();
		expect(within(chip).queryByText('Local')).not.toBeInTheDocument();
	});
});

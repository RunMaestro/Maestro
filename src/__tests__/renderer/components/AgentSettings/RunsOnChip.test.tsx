/**
 * @fileoverview Tests for RunsOnChip, the "Runs on" title-bar chip of the
 * agent and group settings modals.
 */

import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
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

describe('RunsOnChip as a choice (New Agent)', () => {
	const remotes = [
		{ id: 'r1', name: 'build-box' },
		{ id: 'r2', name: 'gpu', rightContent: <span>2 to add</span> },
	];

	it('offers Local and every remote, and reports the pick', () => {
		const onChange = vi.fn();
		render(
			<RunsOnChip
				theme={createMockTheme()}
				idPrefix="new-agent"
				choice={{ remotes, value: null, onChange }}
			/>
		);
		const trigger = screen.getByRole('button', { name: 'Runs on' });
		expect(trigger).toHaveTextContent('Local');
		fireEvent.click(trigger);
		expect(screen.getByText('2 to add')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('option', { name: /gpu/ }));
		expect(onChange).toHaveBeenCalledWith('r2');
	});

	it('reports local as null', () => {
		const onChange = vi.fn();
		render(
			<RunsOnChip
				theme={createMockTheme()}
				idPrefix="new-agent"
				choice={{ remotes, value: 'r1', onChange }}
			/>
		);
		const trigger = screen.getByRole('button', { name: 'Runs on' });
		expect(trigger).toHaveTextContent('build-box');
		fireEvent.click(trigger);
		fireEvent.click(screen.getByRole('option', { name: 'Local' }));
		expect(onChange).toHaveBeenCalledWith(null);
	});

	it('stays a label when there are no remotes to choose', () => {
		render(
			<RunsOnChip
				theme={createMockTheme()}
				idPrefix="new-agent"
				choice={{ remotes: [], value: null, onChange: vi.fn() }}
			/>
		);
		expect(screen.queryByRole('button', { name: 'Runs on' })).not.toBeInTheDocument();
		expect(within(screen.getByTestId('new-agent-runs-on')).getByText('Local')).toBeInTheDocument();
	});
});

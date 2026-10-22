/**
 * @fileoverview Tests for GeneralTab, the agent settings panel for name,
 * group, working directory, additional directories and the two messages.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import {
	GeneralTab,
	type GeneralTabProps,
} from '../../../../renderer/components/AgentSettings/GeneralTab';
import { createMockTheme } from '../../../helpers/mockTheme';

function createProps(overrides: Partial<GeneralTabProps> = {}): GeneralTabProps {
	return {
		theme: createMockTheme(),
		idPrefix: 'edit-agent',
		name: 'Builder',
		onNameChange: vi.fn(),
		nameInputId: 'edit-agent-name-input',
		workingDirectory: <div data-testid="working-dir-slot" />,
		additionalDirectories: { directories: [], onChange: vi.fn() },
		newSessionMessage: 'first',
		onNewSessionMessageChange: vi.fn(),
		nudgeMessage: 'always',
		onNudgeMessageChange: vi.fn(),
		...overrides,
	};
}

describe('GeneralTab', () => {
	it('is the general tabpanel, labelled by its tab', () => {
		render(<GeneralTab {...createProps()} />);
		const panel = screen.getByRole('tabpanel');
		expect(panel).toHaveAttribute('id', 'edit-agent-tabpanel-general');
		expect(panel).toHaveAttribute('aria-labelledby', 'edit-agent-tab-general');
	});

	it('edits the name and shows its error', () => {
		const onNameChange = vi.fn();
		render(<GeneralTab {...createProps({ onNameChange, nameError: 'Name is taken' })} />);

		fireEvent.change(screen.getByDisplayValue('Builder'), { target: { value: 'Planner' } });
		expect(onNameChange).toHaveBeenCalledWith('Planner');
		expect(screen.getByText('Name is taken')).toBeInTheDocument();
	});

	it('renders the group, working directory and remote path slots', () => {
		render(
			<GeneralTab
				{...createProps({
					groupPicker: <div data-testid="group-slot" />,
					remotePathStatus: <div data-testid="remote-path-slot" />,
					extra: <div data-testid="extra-slot" />,
				})}
			/>
		);
		expect(screen.getByTestId('group-slot')).toBeInTheDocument();
		expect(screen.getByTestId('working-dir-slot')).toBeInTheDocument();
		expect(screen.getByTestId('remote-path-slot')).toBeInTheDocument();
		expect(screen.getByTestId('extra-slot')).toBeInTheDocument();
	});

	it('renders the additional directories and both messages', () => {
		const onNewSessionMessageChange = vi.fn();
		const onNudgeMessageChange = vi.fn();
		render(<GeneralTab {...createProps({ onNewSessionMessageChange, onNudgeMessageChange })} />);

		expect(screen.getByText('Add Directory')).toBeInTheDocument();
		expect(screen.getByText('New Session Message')).toBeInTheDocument();
		expect(screen.getByText('Nudge Message')).toBeInTheDocument();

		fireEvent.change(screen.getByDisplayValue('first'), { target: { value: 'hello' } });
		expect(onNewSessionMessageChange).toHaveBeenCalledWith('hello');
		fireEvent.change(screen.getByDisplayValue('always'), { target: { value: 'be brief' } });
		expect(onNudgeMessageChange).toHaveBeenCalledWith('be brief');
	});

	it('says the agent runs locally when no SSH remote is set', () => {
		render(<GeneralTab {...createProps()} />);
		expect(within(screen.getByTestId('edit-agent-runs-on')).getByText('Local')).toBeInTheDocument();
	});

	it('names the SSH remote the agent runs on', () => {
		render(<GeneralTab {...createProps({ sshRemoteHost: 'build-box' })} />);
		const chip = screen.getByTestId('edit-agent-runs-on');
		expect(within(chip).getByText('build-box')).toBeInTheDocument();
		expect(within(chip).queryByText('Local')).not.toBeInTheDocument();
	});

	it('draws no name field for a form that names no agent', () => {
		const {
			name: _name,
			onNameChange: _onNameChange,
			nameInputId: _nameInputId,
			...unnamed
		} = createProps();
		render(<GeneralTab {...unnamed} lead={<div data-testid="lead-slot" />} />);

		expect(screen.queryByText('Agent Name')).not.toBeInTheDocument();
		expect(screen.queryByDisplayValue('Builder')).not.toBeInTheDocument();
		// The rest of the tab is still there, with the lead slot where the name was.
		expect(screen.getByTestId('edit-agent-runs-on').nextElementSibling).toBe(
			screen.getByTestId('lead-slot')
		);
		expect(screen.getByTestId('working-dir-slot')).toBeInTheDocument();
		expect(screen.getByText('Nudge Message')).toBeInTheDocument();
	});
});

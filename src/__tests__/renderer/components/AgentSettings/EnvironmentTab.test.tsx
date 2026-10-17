/**
 * @fileoverview Tests for EnvironmentTab: the intro copy, the provider hint,
 * and the env var section with its built-in list.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
	EnvironmentTab,
	type EnvironmentTabProps,
} from '../../../../renderer/components/AgentSettings/EnvironmentTab';
import { createMockTheme } from '../../../helpers/mockTheme';

function createProps(overrides: Partial<EnvironmentTabProps> = {}): EnvironmentTabProps {
	return {
		theme: createMockTheme(),
		idPrefix: 'edit-agent',
		toolType: 'claude-code',
		customEnvVars: { API_HOST: 'localhost' },
		onEnvVarKeyChange: vi.fn(),
		onEnvVarValueChange: vi.fn(),
		onEnvVarRemove: vi.fn(),
		onEnvVarAdd: vi.fn(),
		onEnvVarsBlur: vi.fn(),
		...overrides,
	};
}

describe('EnvironmentTab', () => {
	it('explains the layering and shows the rows and the built-in list', () => {
		render(<EnvironmentTab {...createProps()} />);

		expect(screen.getByRole('tabpanel')).toHaveAttribute('id', 'edit-agent-tabpanel-environment');
		expect(screen.getByText(/on top of the global environment from Settings/)).toBeInTheDocument();
		expect(screen.getByText(/A parked row is kept but not passed/)).toBeInTheDocument();
		expect(screen.getByDisplayValue('API_HOST')).toBeInTheDocument();
		expect(screen.getByText('MAESTRO_SESSION_RESUMED')).toBeInTheDocument();
	});

	it('passes edits through to the modal', () => {
		const onEnvVarAdd = vi.fn();
		const onEnvVarValueChange = vi.fn();
		render(<EnvironmentTab {...createProps({ onEnvVarAdd, onEnvVarValueChange })} />);

		fireEvent.click(screen.getByText('Add Variable'));
		expect(onEnvVarAdd).toHaveBeenCalledTimes(1);
		fireEvent.change(screen.getByDisplayValue('localhost'), { target: { value: 'remote' } });
		expect(onEnvVarValueChange).toHaveBeenCalledWith('API_HOST', 'remote', true);
	});

	it('names the provider whose environment is being edited', () => {
		render(<EnvironmentTab {...createProps({ providerName: 'Codex' })} />);
		expect(screen.getByText(/Editing the Codex environment\./)).toBeInTheDocument();
	});

	it('says nothing about a provider when none is named', () => {
		render(<EnvironmentTab {...createProps()} />);
		expect(screen.queryByText(/Editing the/)).not.toBeInTheDocument();
	});
});

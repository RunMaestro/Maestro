/**
 * @fileoverview Tests for ProviderEnvironmentSection: the intro copy, the provider hint,
 * and the env var section with its built-in list.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
	ProviderEnvironmentSection,
	type ProviderEnvironmentSectionProps,
} from '../../../../renderer/components/AgentSettings/ProviderEnvironmentSection';
import { createMockTheme } from '../../../helpers/mockTheme';

function createProps(
	overrides: Partial<ProviderEnvironmentSectionProps> = {}
): ProviderEnvironmentSectionProps {
	return {
		theme: createMockTheme(),
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

describe('ProviderEnvironmentSection', () => {
	it('explains the layering and shows the rows and the built-in list', () => {
		render(<ProviderEnvironmentSection {...createProps()} />);

		expect(screen.queryByRole('tabpanel')).not.toBeInTheDocument();
		expect(screen.getByText('Environment variables').closest('details')).toHaveAttribute('open');
		expect(screen.getByText(/override the global environment from Settings/)).toBeInTheDocument();
		expect(screen.getByText(/A parked row is kept but not passed/)).toBeInTheDocument();
		expect(screen.getByDisplayValue('API_HOST')).toBeInTheDocument();
		expect(screen.getByText('MAESTRO_SESSION_RESUMED')).toBeInTheDocument();
	});

	it('passes edits through to the modal', () => {
		const onEnvVarAdd = vi.fn();
		const onEnvVarValueChange = vi.fn();
		render(<ProviderEnvironmentSection {...createProps({ onEnvVarAdd, onEnvVarValueChange })} />);

		fireEvent.click(screen.getByText('Add Variable'));
		expect(onEnvVarAdd).toHaveBeenCalledTimes(1);
		fireEvent.change(screen.getByDisplayValue('localhost'), { target: { value: 'remote' } });
		expect(onEnvVarValueChange).toHaveBeenCalledWith('API_HOST', 'remote', true);
	});

	it('names the provider whose environment is being edited', () => {
		render(<ProviderEnvironmentSection {...createProps({ providerName: 'Codex' })} />);
		expect(screen.getByText(/Editing the Codex environment\./)).toBeInTheDocument();
	});

	it('says nothing about a provider when none is named', () => {
		render(<ProviderEnvironmentSection {...createProps()} />);
		expect(screen.queryByText(/Editing the/)).not.toBeInTheDocument();
	});

	it('collapses an empty environment and lets the user expand it', () => {
		render(<ProviderEnvironmentSection {...createProps({ customEnvVars: {} })} />);
		const summary = screen.getByText('Environment variables');
		expect(summary.closest('details')).not.toHaveAttribute('open');
		fireEvent.click(summary);
		expect(summary.closest('details')).toHaveAttribute('open');
		expect(screen.getByText('Add Variable')).toBeVisible();
	});

	it('expands parked variables so the account configuration remains discoverable', () => {
		render(
			<ProviderEnvironmentSection
				{...createProps({
					customEnvVars: {},
					customEnvVarsDisabled: { CLAUDE_CONFIG_DIR: '~/.claude-work' },
					onEnvVarToggle: vi.fn(),
				})}
			/>
		);
		expect(screen.getByText('Environment variables').closest('details')).toHaveAttribute('open');
		expect(screen.getByDisplayValue('~/.claude-work')).toBeVisible();
	});
});

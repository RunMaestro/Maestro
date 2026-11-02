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
		expect(screen.getByRole('heading', { name: 'Environment variables' })).toBeVisible();
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

	it('keeps an empty environment visible without a collapse control', () => {
		render(<ProviderEnvironmentSection {...createProps({ customEnvVars: {} })} />);
		const heading = screen.getByRole('heading', { name: 'Environment variables' });
		expect(heading.closest('details')).toBeNull();
		expect(heading.parentElement?.querySelector('summary')).toBeNull();
		expect(screen.getByText('Add Variable')).toBeVisible();
		expect(screen.getByText('MAESTRO_SESSION_RESUMED')).toBeVisible();
		fireEvent.click(heading);
		expect(screen.getByText('Add Variable')).toBeVisible();
	});

	it('keeps parked variables visible so the account configuration remains discoverable', () => {
		render(
			<ProviderEnvironmentSection
				{...createProps({
					customEnvVars: {},
					customEnvVarsDisabled: { CLAUDE_CONFIG_DIR: '~/.claude-work' },
					onEnvVarToggle: vi.fn(),
				})}
			/>
		);
		expect(screen.getByRole('heading', { name: 'Environment variables' })).toBeVisible();
		expect(screen.getByDisplayValue('~/.claude-work')).toBeVisible();
	});
});

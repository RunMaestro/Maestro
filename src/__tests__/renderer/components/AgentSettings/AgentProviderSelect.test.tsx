/**
 * @fileoverview Tests for AgentProviderSelect, the provider `<select>` shared
 * by Edit Agent and Group Settings.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AgentProviderSelect } from '../../../../renderer/components/AgentSettings/AgentProviderSelect';
import { SUPPORTED_AGENTS } from '../../../../renderer/components/NewInstanceModal/types';
import { getAgentDisplayName } from '../../../../shared/agentMetadata';
import { createMockTheme } from '../../../helpers/mockTheme';

const theme = createMockTheme();

describe('AgentProviderSelect', () => {
	it('lists every provider a user can pick, by display name', () => {
		render(<AgentProviderSelect theme={theme} value="claude-code" onChange={vi.fn()} />);

		const select = screen.getByRole('combobox', { name: 'Agent Provider' });
		expect(select).toHaveValue('claude-code');
		expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(
			SUPPORTED_AGENTS.map((agentId) => getAgentDisplayName(agentId))
		);
	});

	it('reports the chosen provider id', () => {
		const onChange = vi.fn();
		render(<AgentProviderSelect theme={theme} value="claude-code" onChange={onChange} />);

		fireEvent.change(screen.getByRole('combobox'), { target: { value: 'codex' } });
		expect(onChange).toHaveBeenCalledWith('codex');
	});

	it('offers no provider only to a form that asks for it', () => {
		const onChange = vi.fn();
		render(
			<AgentProviderSelect
				theme={theme}
				value=""
				onChange={onChange}
				noneLabel="No default"
				testId="provider-select"
			/>
		);

		const select = screen.getByTestId('provider-select');
		expect(select).toHaveValue('');
		expect(screen.getAllByRole('option')[0]).toHaveTextContent('No default');

		fireEvent.change(select, { target: { value: 'codex' } });
		fireEvent.change(select, { target: { value: '' } });
		expect(onChange).toHaveBeenLastCalledWith('');
	});

	it('draws what the form says about the choice under the select', () => {
		render(
			<AgentProviderSelect theme={theme} value="codex" onChange={vi.fn()}>
				<p data-testid="notice">Your tabs are kept.</p>
			</AgentProviderSelect>
		);

		const select = screen.getByRole('combobox');
		const notice = screen.getByTestId('notice');
		expect(select.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});
	it('shows conversion labels and locks the picker while a migration saves', () => {
		render(
			<AgentProviderSelect
				theme={theme}
				value="claude-code"
				onChange={vi.fn()}
				disabled
				optionLabel={(id) => `${getAgentDisplayName(id)} - carry preview`}
			/>
		);
		expect(screen.getByRole('combobox', { name: 'Agent Provider' })).toBeDisabled();
		expect(screen.getByRole('option', { name: 'Codex - carry preview' })).toHaveValue('codex');
	});
});

/**
 * Tests for EnvVarKeyInput, the name half of an env-var row.
 *
 * The behaviors worth pinning: the list narrows as the user types, a pick
 * writes the exact provider spelling, and the field still accepts a name the
 * catalog has never heard of.
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { EnvVarKeyInput } from '../../../../renderer/components/shared/EnvVarKeyInput';
import { mockTheme } from '../../../helpers/mockTheme';

function renderInput(props: Partial<React.ComponentProps<typeof EnvVarKeyInput>> = {}) {
	const onChange = props.onChange ?? vi.fn();
	render(
		<EnvVarKeyInput
			theme={mockTheme}
			value={props.value ?? ''}
			onChange={onChange}
			toolType={props.toolType ?? 'claude-code'}
			className="p-2"
			style={{}}
			{...props}
		/>
	);
	return { onChange, input: screen.getByTestId('env-var-key-input') };
}

function ControlledInput(props: Partial<React.ComponentProps<typeof EnvVarKeyInput>> = {}) {
	const [value, setValue] = React.useState(props.value ?? '');
	return (
		<EnvVarKeyInput
			theme={mockTheme}
			toolType="claude-code"
			className="p-2"
			style={{}}
			{...props}
			value={value}
			onChange={setValue}
		/>
	);
}

describe('EnvVarKeyInput', () => {
	it('offers the provider catalog on focus', () => {
		const { input } = renderInput();
		fireEvent.focus(input);

		expect(screen.getByRole('option', { name: /CLAUDE_CONFIG_DIR/ })).toBeInTheDocument();
		expect(screen.queryByRole('option', { name: /CODEX_HOME/ })).not.toBeInTheDocument();
	});

	it('stays closed until focused', () => {
		renderInput();

		expect(screen.queryByTestId('env-var-key-input-suggestions')).not.toBeInTheDocument();
	});

	it('narrows the list as the user types', () => {
		render(<ControlledInput />);
		const input = screen.getByTestId('env-var-key-input');
		fireEvent.change(input, { target: { value: 'ANTHRO' } });

		expect(input).toHaveValue('ANTHRO');
		expect(screen.queryByRole('option', { name: /CLAUDE_CONFIG_DIR/ })).not.toBeInTheDocument();
		expect(screen.getByRole('option', { name: /ANTHROPIC_API_KEY/ })).toBeInTheDocument();
	});

	it('writes the picked name back', () => {
		const { input, onChange } = renderInput();
		fireEvent.focus(input);
		fireEvent.mouseDown(screen.getByRole('option', { name: /CLAUDE_CONFIG_DIR/ }));

		expect(onChange).toHaveBeenCalledWith('CLAUDE_CONFIG_DIR');
		expect(screen.queryByTestId('env-var-key-input-suggestions')).not.toBeInTheDocument();
	});

	it('picks the highlighted name on Enter', () => {
		const { input, onChange } = renderInput({ value: 'ANTHROPIC_' });
		fireEvent.focus(input);
		fireEvent.keyDown(input, { key: 'ArrowDown' });
		fireEvent.keyDown(input, { key: 'Enter' });

		expect(onChange).toHaveBeenCalledWith('ANTHROPIC_AUTH_TOKEN');
	});

	it('remembers names the user set on this provider before', () => {
		const { input } = renderInput({
			knownEnvVarKeys: { byProvider: { 'claude-code': ['MY_TEAM_TOKEN'] }, global: [] },
		});
		fireEvent.focus(input);

		expect(screen.getByRole('option', { name: /MY_TEAM_TOKEN/ })).toBeInTheDocument();
	});

	it('does not offer a name another row already uses', () => {
		const { input } = renderInput({ usedKeys: ['CLAUDE_CONFIG_DIR'] });
		fireEvent.focus(input);

		expect(screen.queryByRole('option', { name: /CLAUDE_CONFIG_DIR/ })).not.toBeInTheDocument();
	});

	it('still offers the row its own current name', () => {
		const { input } = renderInput({
			value: 'CLAUDE_CONFIG_DIR',
			usedKeys: ['CLAUDE_CONFIG_DIR', 'ANTHROPIC_MODEL'],
		});
		fireEvent.focus(input);

		// One exact hit and nothing else to say: the list stays out of the way.
		expect(screen.queryByTestId('env-var-key-input-suggestions')).not.toBeInTheDocument();
	});

	it('accepts a name the catalog has never heard of', () => {
		const { input, onChange } = renderInput();
		fireEvent.change(input, { target: { value: 'TOTALLY_CUSTOM' } });
		fireEvent.blur(input);

		expect(onChange).toHaveBeenCalledWith('TOTALLY_CUSTOM');
		expect(screen.queryByTestId('env-var-key-input-suggestions')).not.toBeInTheDocument();
	});

	it('closes on Escape without letting the key reach the modal behind it', () => {
		const { input } = renderInput();
		fireEvent.focus(input);
		const reachedDocument = vi.fn();
		document.addEventListener('keydown', reachedDocument);
		fireEvent.keyDown(input, { key: 'Escape' });
		document.removeEventListener('keydown', reachedDocument);

		expect(screen.queryByTestId('env-var-key-input-suggestions')).not.toBeInTheDocument();
		expect(reachedDocument).not.toHaveBeenCalled();
	});

	it('offers every provider catalog when no provider is named', () => {
		const { input } = renderInput({ toolType: undefined, value: 'HOME' });
		fireEvent.focus(input);

		expect(screen.getByRole('option', { name: /CODEX_HOME/ })).toBeInTheDocument();
		expect(screen.getByRole('option', { name: /COPILOT_HOME/ })).toBeInTheDocument();
	});
});

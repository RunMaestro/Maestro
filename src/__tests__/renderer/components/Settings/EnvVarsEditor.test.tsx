/**
 * Tests for EnvVarsEditor component
 *
 * Tests the environment variables editor including:
 * - Adding and removing entries
 * - Variable name validation
 * - Value validation (special characters)
 * - Display of valid entry count
 * - External sync from parent
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { EnvVarsEditor } from '../../../../renderer/components/Settings/EnvVarsEditor';
import type { Theme } from '../../../../renderer/types';

const mockTheme: Theme = {
	id: 'dracula',
	name: 'Dracula',
	mode: 'dark',
	colors: {
		bgMain: '#282a36',
		bgSidebar: '#21222c',
		bgActivity: '#343746',
		border: '#44475a',
		textMain: '#f8f8f2',
		textDim: '#6272a4',
		accent: '#bd93f9',
		accentDim: '#bd93f920',
		accentText: '#ff79c6',
		accentForeground: '#ffffff',
		success: '#50fa7b',
		warning: '#ffb86c',
		error: '#ff5555',
	},
};

describe('EnvVarsEditor', () => {
	let mockSetEnvVars: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		mockSetEnvVars = vi.fn();
	});

	it('should render with empty env vars', () => {
		render(<EnvVarsEditor envVars={{}} setEnvVars={mockSetEnvVars} theme={mockTheme} />);

		expect(screen.getByText('Environment Variables (optional)')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Add Variable' })).toBeInTheDocument();
	});

	it('should render existing env vars', () => {
		render(
			<EnvVarsEditor
				envVars={{ MY_VAR: 'hello', OTHER_VAR: 'world' }}
				setEnvVars={mockSetEnvVars}
				theme={mockTheme}
			/>
		);

		const keyInputs = screen.getAllByPlaceholderText('VARIABLE');
		expect(keyInputs).toHaveLength(2);
		expect(keyInputs[0]).toHaveValue('MY_VAR');
		expect(keyInputs[1]).toHaveValue('OTHER_VAR');

		const valueInputs = screen.getAllByPlaceholderText('value');
		expect(valueInputs[0]).toHaveValue('hello');
		expect(valueInputs[1]).toHaveValue('world');
	});

	it('should display count of valid entries', () => {
		render(
			<EnvVarsEditor
				envVars={{ EXISTING_VAR: 'value' }}
				setEnvVars={mockSetEnvVars}
				theme={mockTheme}
			/>
		);

		expect(screen.getByText(/✓ Valid.*1.*variables loaded/)).toBeInTheDocument();
	});

	it('should not display count when no env vars', () => {
		render(<EnvVarsEditor envVars={{}} setEnvVars={mockSetEnvVars} theme={mockTheme} />);

		expect(screen.queryByText(/✓ Valid/)).not.toBeInTheDocument();
	});

	it('should add a new entry when clicking Add Variable', () => {
		render(<EnvVarsEditor envVars={{}} setEnvVars={mockSetEnvVars} theme={mockTheme} />);

		const addButton = screen.getByRole('button', { name: 'Add Variable' });
		fireEvent.click(addButton);

		// Should have one entry now with default key "VAR"
		const inputs = screen.getAllByPlaceholderText('VARIABLE');
		expect(inputs).toHaveLength(1);
		expect(inputs[0]).toHaveValue('VAR');
	});

	it('should generate unique default key names', () => {
		render(
			<EnvVarsEditor envVars={{ VAR: 'test' }} setEnvVars={mockSetEnvVars} theme={mockTheme} />
		);

		const addButton = screen.getByRole('button', { name: 'Add Variable' });
		fireEvent.click(addButton);

		const inputs = screen.getAllByPlaceholderText('VARIABLE');
		// First is "VAR" (existing), second should be "VAR_1"
		expect(inputs[1]).toHaveValue('VAR_1');
	});

	it('should show validation error for invalid variable names', () => {
		render(<EnvVarsEditor envVars={{}} setEnvVars={mockSetEnvVars} theme={mockTheme} />);

		// Add a new entry
		const addButton = screen.getByRole('button', { name: 'Add Variable' });
		fireEvent.click(addButton);

		// Change key to invalid name
		const keyInput = screen.getAllByPlaceholderText('VARIABLE')[0];
		fireEvent.change(keyInput, { target: { value: 'MY-VAR' } });

		expect(screen.getByText(/Invalid variable name/)).toBeInTheDocument();
	});

	it('should only add valid entries to envVars state (not invalid ones)', () => {
		render(<EnvVarsEditor envVars={{}} setEnvVars={mockSetEnvVars} theme={mockTheme} />);

		const addButton = screen.getByRole('button', { name: 'Add Variable' });
		fireEvent.click(addButton);

		const keyInput = screen.getAllByPlaceholderText('VARIABLE')[0];
		fireEvent.change(keyInput, { target: { value: 'MY-VAR' } });

		// The setEnvVars should NOT have been called with this invalid entry
		if (mockSetEnvVars.mock.calls.length > 0) {
			const lastCall = mockSetEnvVars.mock.calls[mockSetEnvVars.mock.calls.length - 1][0];
			expect(lastCall['MY-VAR']).toBeUndefined();
		}
	});

	it('should add valid entries and skip invalid entries', () => {
		render(<EnvVarsEditor envVars={{}} setEnvVars={mockSetEnvVars} theme={mockTheme} />);

		const addButton = screen.getByRole('button', { name: 'Add Variable' });

		// Add first valid entry
		fireEvent.click(addButton);
		let inputs = screen.getAllByPlaceholderText('VARIABLE');
		fireEvent.change(inputs[inputs.length - 1], { target: { value: 'VALID_VAR' } });

		const valueInputs = screen.getAllByPlaceholderText('value');
		fireEvent.change(valueInputs[valueInputs.length - 1], { target: { value: 'test_value' } });

		// Add second invalid entry
		fireEvent.click(addButton);
		inputs = screen.getAllByPlaceholderText('VARIABLE');
		fireEvent.change(inputs[inputs.length - 1], { target: { value: 'INVALID-VAR' } });

		// Check the last call to setEnvVars
		const lastCall = mockSetEnvVars.mock.calls[mockSetEnvVars.mock.calls.length - 1][0];

		// Should include valid entry
		expect(lastCall['VALID_VAR']).toBe('test_value');

		// Should NOT include invalid entry
		expect(lastCall['INVALID-VAR']).toBeUndefined();
	});

	it('should show warning for values with special characters', () => {
		render(<EnvVarsEditor envVars={{}} setEnvVars={mockSetEnvVars} theme={mockTheme} />);

		const addButton = screen.getByRole('button', { name: 'Add Variable' });
		fireEvent.click(addButton);

		const keyInput = screen.getAllByPlaceholderText('VARIABLE')[0];
		fireEvent.change(keyInput, { target: { value: 'MY_VAR' } });

		const valueInput = screen.getAllByPlaceholderText('value')[0];
		fireEvent.change(valueInput, { target: { value: 'value&with|special' } });

		expect(screen.getByText(/contains disallowed special characters/)).toBeInTheDocument();
	});

	it('should remove entries when trash button is clicked', () => {
		render(
			<EnvVarsEditor
				envVars={{ VALID_VAR: 'test' }}
				setEnvVars={mockSetEnvVars}
				theme={mockTheme}
			/>
		);

		// Add an invalid entry
		const addButton = screen.getByRole('button', { name: 'Add Variable' });
		fireEvent.click(addButton);

		let inputs = screen.getAllByPlaceholderText('VARIABLE');
		fireEvent.change(inputs[inputs.length - 1], { target: { value: 'INVALID-VAR' } });

		// Delete the invalid entry
		const trashButtons = screen.getAllByRole('button', { name: 'Remove variable' });
		fireEvent.click(trashButtons[trashButtons.length - 1]);

		// After deletion, only VALID_VAR should remain
		const lastCall = mockSetEnvVars.mock.calls[mockSetEnvVars.mock.calls.length - 1][0];
		expect(lastCall['VALID_VAR']).toBe('test');
		expect(lastCall['INVALID-VAR']).toBeUndefined();
	});

	it('should allow empty keys without validation errors', () => {
		render(<EnvVarsEditor envVars={{}} setEnvVars={mockSetEnvVars} theme={mockTheme} />);

		const addButton = screen.getByRole('button', { name: 'Add Variable' });
		fireEvent.click(addButton);

		const keyInput = screen.getAllByPlaceholderText('VARIABLE')[0];
		fireEvent.change(keyInput, { target: { value: '' } });

		// Should not show any validation error for empty key
		expect(screen.queryByText(/Invalid variable name/)).not.toBeInTheDocument();
	});

	it('should allow quoted values with special characters', () => {
		render(<EnvVarsEditor envVars={{}} setEnvVars={mockSetEnvVars} theme={mockTheme} />);

		const addButton = screen.getByRole('button', { name: 'Add Variable' });
		fireEvent.click(addButton);

		const keyInput = screen.getAllByPlaceholderText('VARIABLE')[0];
		fireEvent.change(keyInput, { target: { value: 'MY_VAR' } });

		const valueInput = screen.getAllByPlaceholderText('value')[0];
		fireEvent.change(valueInput, { target: { value: '"value&with|special"' } });

		// Should NOT show warning — value is quoted
		expect(screen.queryByText(/contains disallowed special characters/)).not.toBeInTheDocument();
	});

	it('should allow single-quoted values with special characters', () => {
		render(<EnvVarsEditor envVars={{}} setEnvVars={mockSetEnvVars} theme={mockTheme} />);

		const addButton = screen.getByRole('button', { name: 'Add Variable' });
		fireEvent.click(addButton);

		const keyInput = screen.getAllByPlaceholderText('VARIABLE')[0];
		fireEvent.change(keyInput, { target: { value: 'MY_VAR' } });

		const valueInput = screen.getAllByPlaceholderText('value')[0];
		fireEvent.change(valueInput, { target: { value: "'value&with|special'" } });

		expect(screen.queryByText(/contains disallowed special characters/)).not.toBeInTheDocument();
	});

	it('should reject variable names starting with a number', () => {
		render(<EnvVarsEditor envVars={{}} setEnvVars={mockSetEnvVars} theme={mockTheme} />);

		const addButton = screen.getByRole('button', { name: 'Add Variable' });
		fireEvent.click(addButton);

		const keyInput = screen.getAllByPlaceholderText('VARIABLE')[0];
		fireEvent.change(keyInput, { target: { value: '1VAR' } });

		expect(screen.getByText(/Invalid variable name/)).toBeInTheDocument();
	});

	it('should accept variable names with underscores', () => {
		render(<EnvVarsEditor envVars={{}} setEnvVars={mockSetEnvVars} theme={mockTheme} />);

		const addButton = screen.getByRole('button', { name: 'Add Variable' });
		fireEvent.click(addButton);

		const keyInput = screen.getAllByPlaceholderText('VARIABLE')[0];
		fireEvent.change(keyInput, { target: { value: '_MY_VAR_123' } });

		expect(screen.queryByText(/Invalid variable name/)).not.toBeInTheDocument();
	});

	it('should commit value changes to parent', () => {
		render(<EnvVarsEditor envVars={{}} setEnvVars={mockSetEnvVars} theme={mockTheme} />);

		const addButton = screen.getByRole('button', { name: 'Add Variable' });
		fireEvent.click(addButton);

		// Key is already "VAR" (default)
		const valueInput = screen.getAllByPlaceholderText('value')[0];
		fireEvent.change(valueInput, { target: { value: 'hello_world' } });

		const lastCall = mockSetEnvVars.mock.calls[mockSetEnvVars.mock.calls.length - 1][0];
		expect(lastCall['VAR']).toBe('hello_world');
	});

	it('should handle multiple entries simultaneously', () => {
		render(
			<EnvVarsEditor
				envVars={{ A: '1', B: '2', C: '3' }}
				setEnvVars={mockSetEnvVars}
				theme={mockTheme}
			/>
		);

		const keyInputs = screen.getAllByPlaceholderText('VARIABLE');
		expect(keyInputs).toHaveLength(3);

		const valueInputs = screen.getAllByPlaceholderText('value');
		expect(valueInputs).toHaveLength(3);

		// All trash buttons present
		const trashButtons = screen.getAllByRole('button', { name: 'Remove variable' });
		expect(trashButtons).toHaveLength(3);
	});

	it('should show description text', () => {
		render(<EnvVarsEditor envVars={{}} setEnvVars={mockSetEnvVars} theme={mockTheme} />);

		expect(
			screen.getByText(/Environment variables passed to all terminal sessions/)
		).toBeInTheDocument();
	});

	it('should display correct count for multiple valid entries', () => {
		render(
			<EnvVarsEditor
				envVars={{ VAR_A: 'a', VAR_B: 'b', VAR_C: 'c' }}
				setEnvVars={mockSetEnvVars}
				theme={mockTheme}
			/>
		);

		expect(screen.getByText(/✓ Valid.*3.*variables loaded/)).toBeInTheDocument();
	});

	it('should generate sequential unique names (VAR_1, VAR_2, ...)', () => {
		render(
			<EnvVarsEditor
				envVars={{ VAR: 'a', VAR_1: 'b' }}
				setEnvVars={mockSetEnvVars}
				theme={mockTheme}
			/>
		);

		const addButton = screen.getByRole('button', { name: 'Add Variable' });
		fireEvent.click(addButton);

		const inputs = screen.getAllByPlaceholderText('VARIABLE');
		// Should be VAR_2 since VAR and VAR_1 are taken
		expect(inputs[2]).toHaveValue('VAR_2');
	});

	it('should allow values without special characters', () => {
		render(<EnvVarsEditor envVars={{}} setEnvVars={mockSetEnvVars} theme={mockTheme} />);

		const addButton = screen.getByRole('button', { name: 'Add Variable' });
		fireEvent.click(addButton);

		const keyInput = screen.getAllByPlaceholderText('VARIABLE')[0];
		fireEvent.change(keyInput, { target: { value: 'PATH' } });

		const valueInput = screen.getAllByPlaceholderText('value')[0];
		fireEvent.change(valueInput, { target: { value: '/usr/local/bin' } });

		expect(screen.queryByText(/contains disallowed special characters/)).not.toBeInTheDocument();
		expect(screen.queryByText(/Invalid variable name/)).not.toBeInTheDocument();
	});

	it('should sync when parent envVars change externally', () => {
		const { rerender } = render(
			<EnvVarsEditor envVars={{ OLD: 'val' }} setEnvVars={mockSetEnvVars} theme={mockTheme} />
		);

		// Verify initial state
		expect(screen.getByDisplayValue('OLD')).toBeInTheDocument();

		// Rerender with different envVars
		rerender(
			<EnvVarsEditor envVars={{ NEW: 'newval' }} setEnvVars={mockSetEnvVars} theme={mockTheme} />
		);

		// Should show the new variable
		expect(screen.getByDisplayValue('NEW')).toBeInTheDocument();
		expect(screen.getByDisplayValue('newval')).toBeInTheDocument();
		expect(screen.queryByDisplayValue('OLD')).not.toBeInTheDocument();
	});

	it('should show = separator between key and value', () => {
		render(
			<EnvVarsEditor envVars={{ MY_VAR: 'hello' }} setEnvVars={mockSetEnvVars} theme={mockTheme} />
		);

		expect(screen.getByText('=')).toBeInTheDocument();
	});
});

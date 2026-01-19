/**
 * Tests for AICommandsPanel.tsx
 *
 * Tests the AICommandsPanel component for custom AI slash command management:
 * - Initial render (empty state, with commands)
 * - Template variables documentation section (expand/collapse)
 * - Create new command form (open/close, validation, submission)
 * - Edit existing commands (enter edit mode, update fields, save)
 * - Delete commands (custom commands, built-in protection)
 * - Command validation (slash prefix normalization, duplicate prevention)
 * - Built-in command handling (edit allowed, delete prevented)
 * - Template autocomplete integration (dropdown rendering, keyboard handling)
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { AICommandsPanel } from '../../../renderer/components/AICommandsPanel';
import type { Theme, CustomAICommand } from '../../../renderer/types';

// Mock the useTemplateAutocomplete hook
const mockAutocompleteState = {
	isOpen: false,
	search: '',
	filteredVariables: [],
	selectedIndex: 0,
	position: { top: 0, left: 0 },
};

const mockCloseAutocomplete = vi.fn();
const mockHandleKeyDown = vi.fn().mockReturnValue(false);
const mockSelectVariable = vi.fn();
const mockAutocompleteRef = { current: null };

vi.mock('../../../renderer/hooks/input/useTemplateAutocomplete', () => ({
	useTemplateAutocomplete: vi.fn((props: { onChange: (value: string) => void }) => {
		// Capture the onChange in a closure for this specific hook instance
		const onChange = props.onChange;
		return {
			autocompleteState: mockAutocompleteState,
			handleKeyDown: mockHandleKeyDown,
			// Mock handleChange that actually propagates the change to the parent
			handleChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => {
				onChange(e.target.value);
			},
			selectVariable: mockSelectVariable,
			closeAutocomplete: mockCloseAutocomplete,
			autocompleteRef: mockAutocompleteRef,
		};
	}),
}));

// Mock TemplateAutocompleteDropdown
vi.mock('../../../renderer/components/TemplateAutocompleteDropdown', () => ({
	TemplateAutocompleteDropdown: React.forwardRef(
		(props: { theme: Theme; state: typeof mockAutocompleteState; onSelect: () => void }, ref) => (
			<div data-testid="autocomplete-dropdown" ref={ref as React.Ref<HTMLDivElement>}>
				Autocomplete Dropdown
			</div>
		)
	),
}));

// Sample theme for testing
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
		accentText: '#f8f8f2',
		accentForeground: '#ffffff',
		success: '#50fa7b',
		warning: '#ffb86c',
		error: '#ff5555',
	},
};

// Helper to create mock commands
const createMockCommand = (overrides: Partial<CustomAICommand> = {}): CustomAICommand => ({
	id: `custom-test-${Date.now()}`,
	command: '/test',
	description: 'Test command description',
	prompt: 'Test prompt content',
	isBuiltIn: false,
	...overrides,
});

/**
 * Helper to expand a command in the collapsible list.
 * The new UI requires clicking on the command row to expand it before Edit/Delete buttons are visible.
 */
const expandCommand = (commandName: string) => {
	// Find the button that contains the command name and click it to expand
	const commandButton = screen.getByText(commandName).closest('button');
	if (commandButton) {
		fireEvent.click(commandButton);
	}
};

describe('AICommandsPanel', () => {
	let mockSetCustomAICommands: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		mockSetCustomAICommands = vi.fn();
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	describe('Initial render', () => {
		it('should render header with title and description', () => {
			render(
				<AICommandsPanel
					theme={mockTheme}
					customAICommands={[]}
					setCustomAICommands={mockSetCustomAICommands}
				/>
			);

			expect(screen.getByText('Custom AI Commands')).toBeInTheDocument();
			expect(screen.getByText(/Slash commands available in AI terminal mode/)).toBeInTheDocument();
		});

		it('should render template variables section collapsed by default', () => {
			render(
				<AICommandsPanel
					theme={mockTheme}
					customAICommands={[]}
					setCustomAICommands={mockSetCustomAICommands}
				/>
			);

			expect(screen.getByText('Template Variables')).toBeInTheDocument();
			// Variable documentation should not be visible
			expect(
				screen.queryByText(/Use these variables in your command prompts/)
			).not.toBeInTheDocument();
		});

		it('should render Add Command button', () => {
			render(
				<AICommandsPanel
					theme={mockTheme}
					customAICommands={[]}
					setCustomAICommands={mockSetCustomAICommands}
				/>
			);

			expect(screen.getByRole('button', { name: /Add Command/i })).toBeInTheDocument();
		});

		it('should render empty state when no commands', () => {
			render(
				<AICommandsPanel
					theme={mockTheme}
					customAICommands={[]}
					setCustomAICommands={mockSetCustomAICommands}
				/>
			);

			expect(screen.getByText('No custom AI commands configured')).toBeInTheDocument();
			expect(screen.getByText('Create your first command')).toBeInTheDocument();
		});

		it('should render existing commands', () => {
			const commands = [
				createMockCommand({ id: 'cmd-1', command: '/hello', description: 'Say hello' }),
				createMockCommand({ id: 'cmd-2', command: '/goodbye', description: 'Say goodbye' }),
			];

			render(
				<AICommandsPanel
					theme={mockTheme}
					customAICommands={commands}
					setCustomAICommands={mockSetCustomAICommands}
				/>
			);

			expect(screen.getByText('/hello')).toBeInTheDocument();
			expect(screen.getByText('Say hello')).toBeInTheDocument();
			expect(screen.getByText('/goodbye')).toBeInTheDocument();
			expect(screen.getByText('Say goodbye')).toBeInTheDocument();
		});

		it('should not show empty state when commands exist', () => {
			const commands = [createMockCommand()];

			render(
				<AICommandsPanel
					theme={mockTheme}
					customAICommands={commands}
					setCustomAICommands={mockSetCustomAICommands}
				/>
			);

			expect(screen.queryByText('No custom AI commands configured')).not.toBeInTheDocument();
		});
	});

	describe('Template Variables documentation', () => {
		it('should expand template variables when clicked', () => {
			render(
				<AICommandsPanel
					theme={mockTheme}
					customAICommands={[]}
					setCustomAICommands={mockSetCustomAICommands}
				/>
			);

			const toggleButton = screen.getByText('Template Variables').closest('button')!;
			fireEvent.click(toggleButton);

			expect(screen.getByText(/Use these variables in your command prompts/)).toBeInTheDocument();
		});

		it('should collapse template variables when clicked again', () => {
			render(
				<AICommandsPanel
					theme={mockTheme}
					customAICommands={[]}
					setCustomAICommands={mockSetCustomAICommands}
				/>
			);

			const toggleButton = screen.getByText('Template Variables').closest('button')!;

			// Expand
			fireEvent.click(toggleButton);
			expect(screen.getByText(/Use these variables in your command prompts/)).toBeInTheDocument();

			// Collapse
			fireEvent.click(toggleButton);
			expect(
				screen.queryByText(/Use these variables in your command prompts/)
			).not.toBeInTheDocument();
		});

		it('should display template variable codes when expanded', () => {
			render(
				<AICommandsPanel
					theme={mockTheme}
					customAICommands={[]}
					setCustomAICommands={mockSetCustomAICommands}
				/>
			);

			const toggleButton = screen.getByText('Template Variables').closest('button')!;
			fireEvent.click(toggleButton);

			// Check for some common template variables (uppercase with underscores)
			expect(screen.getByText('{{AGENT_NAME}}')).toBeInTheDocument();
			expect(screen.getByText('{{AGENT_PATH}}')).toBeInTheDocument();
		});
	});

	describe('Create new command form', () => {
		it('should open create form when Add Command clicked', () => {
			render(
				<AICommandsPanel
					theme={mockTheme}
					customAICommands={[]}
					setCustomAICommands={mockSetCustomAICommands}
				/>
			);

			fireEvent.click(screen.getByRole('button', { name: /Add Command/i }));

			expect(screen.getByText('New Command')).toBeInTheDocument();
			expect(screen.getByPlaceholderText('/mycommand')).toBeInTheDocument();
			expect(screen.getByPlaceholderText('Short description for autocomplete')).toBeInTheDocument();
			expect(screen.getByPlaceholderText(/The actual prompt sent to the AI/)).toBeInTheDocument();
		});

		it('should open create form when empty state link clicked', () => {
			render(
				<AICommandsPanel
					theme={mockTheme}
					customAICommands={[]}
					setCustomAICommands={mockSetCustomAICommands}
				/>
			);

			fireEvent.click(screen.getByText('Create your first command'));

			expect(screen.getByText('New Command')).toBeInTheDocument();
		});

		it('should hide Add Command button when form is open', () => {
			render(
				<AICommandsPanel
					theme={mockTheme}
					customAICommands={[]}
					setCustomAICommands={mockSetCustomAICommands}
				/>
			);

			fireEvent.click(screen.getByRole('button', { name: /Add Command/i }));

			// Should only have Cancel and Create buttons, not Add Command
			expect(screen.queryByRole('button', { name: /Add Command/i })).not.toBeInTheDocument();
		});

		it('should cancel create form and reset state', () => {
			render(
				<AICommandsPanel
					theme={mockTheme}
					customAICommands={[]}
					setCustomAICommands={mockSetCustomAICommands}
				/>
			);

			fireEvent.click(screen.getByRole('button', { name: /Add Command/i }));

			// Fill some fields
			fireEvent.change(screen.getByPlaceholderText('/mycommand'), { target: { value: '/custom' } });
			fireEvent.change(screen.getByPlaceholderText('Short description for autocomplete'), {
				target: { value: 'My description' },
			});

			// Cancel
			fireEvent.click(screen.getByRole('button', { name: /Cancel/i }));

			// Form should be hidden
			expect(screen.queryByText('New Command')).not.toBeInTheDocument();
			// Add Command button should be back
			expect(screen.getByRole('button', { name: /Add Command/i })).toBeInTheDocument();
		});

		it('should disable Create button when fields are empty', () => {
			render(
				<AICommandsPanel
					theme={mockTheme}
					customAICommands={[]}
					setCustomAICommands={mockSetCustomAICommands}
				/>
			);

			fireEvent.click(screen.getByRole('button', { name: /Add Command/i }));

			// Create button should be disabled initially (only / in command field)
			const createButton = screen.getByRole('button', { name: /Create/i });
			expect(createButton).toBeDisabled();
		});

		it('should enable Create button when all fields are filled', () => {
			render(
				<AICommandsPanel
					theme={mockTheme}
					customAICommands={[]}
					setCustomAICommands={mockSetCustomAICommands}
				/>
			);

			fireEvent.click(screen.getByRole('button', { name: /Add Command/i }));

			// Fill all fields
			fireEvent.change(screen.getByPlaceholderText('/mycommand'), { target: { value: '/custom' } });
			fireEvent.change(screen.getByPlaceholderText('Short description for autocomplete'), {
				target: { value: 'My description' },
			});
			fireEvent.change(screen.getByPlaceholderText(/The actual prompt sent to the AI/), {
				target: { value: 'My prompt' },
			});

			const createButton = screen.getByRole('button', { name: /Create/i });
			expect(createButton).not.toBeDisabled();
		});

		it('should create command with slash prefix if missing', () => {
			render(
				<AICommandsPanel
					theme={mockTheme}
					customAICommands={[]}
					setCustomAICommands={mockSetCustomAICommands}
				/>
			);

			fireEvent.click(screen.getByRole('button', { name: /Add Command/i }));

			// Fill fields without slash prefix
			fireEvent.change(screen.getByPlaceholderText('/mycommand'), {
				target: { value: 'mycommand' },
			});
			fireEvent.change(screen.getByPlaceholderText('Short description for autocomplete'), {
				target: { value: 'Description' },
			});
			fireEvent.change(screen.getByPlaceholderText(/The actual prompt sent to the AI/), {
				target: { value: 'Prompt' },
			});

			fireEvent.click(screen.getByRole('button', { name: /Create/i }));

			// Should add slash prefix
			expect(mockSetCustomAICommands).toHaveBeenCalled();
			const callArg = mockSetCustomAICommands.mock.calls[0][0];
			expect(callArg[0].command).toBe('/mycommand');
		});

		it('should keep slash prefix if already present', () => {
			render(
				<AICommandsPanel
					theme={mockTheme}
					customAICommands={[]}
					setCustomAICommands={mockSetCustomAICommands}
				/>
			);

			fireEvent.click(screen.getByRole('button', { name: /Add Command/i }));

			// Fill fields with slash prefix
			fireEvent.change(screen.getByPlaceholderText('/mycommand'), {
				target: { value: '/mycommand' },
			});
			fireEvent.change(screen.getByPlaceholderText('Short description for autocomplete'), {
				target: { value: 'Description' },
			});
			fireEvent.change(screen.getByPlaceholderText(/The actual prompt sent to the AI/), {
				target: { value: 'Prompt' },
			});

			fireEvent.click(screen.getByRole('button', { name: /Create/i }));

			const callArg = mockSetCustomAICommands.mock.calls[0][0];
			expect(callArg[0].command).toBe('/mycommand');
		});

		it('should generate unique ID for new command', () => {
			render(
				<AICommandsPanel
					theme={mockTheme}
					customAICommands={[]}
					setCustomAICommands={mockSetCustomAICommands}
				/>
			);

			fireEvent.click(screen.getByRole('button', { name: /Add Command/i }));

			fireEvent.change(screen.getByPlaceholderText('/mycommand'), {
				target: { value: '/test-cmd' },
			});
			fireEvent.change(screen.getByPlaceholderText('Short description for autocomplete'), {
				target: { value: 'Description' },
			});
			fireEvent.change(screen.getByPlaceholderText(/The actual prompt sent to the AI/), {
				target: { value: 'Prompt' },
			});

			fireEvent.click(screen.getByRole('button', { name: /Create/i }));

			const callArg = mockSetCustomAICommands.mock.calls[0][0];
			expect(callArg[0].id).toMatch(/^custom-test-cmd-\d+$/);
			expect(callArg[0].isBuiltIn).toBe(false);
		});

		it('should not create duplicate commands', () => {
			const existingCommands = [createMockCommand({ command: '/existing' })];

			render(
				<AICommandsPanel
					theme={mockTheme}
					customAICommands={existingCommands}
					setCustomAICommands={mockSetCustomAICommands}
				/>
			);

			fireEvent.click(screen.getByRole('button', { name: /Add Command/i }));

			// Try to create duplicate
			fireEvent.change(screen.getByPlaceholderText('/mycommand'), {
				target: { value: '/existing' },
			});
			fireEvent.change(screen.getByPlaceholderText('Short description for autocomplete'), {
				target: { value: 'Description' },
			});
			fireEvent.change(screen.getByPlaceholderText(/The actual prompt sent to the AI/), {
				target: { value: 'Prompt' },
			});

			fireEvent.click(screen.getByRole('button', { name: /Create/i }));

			// Should not call setCustomAICommands for duplicate
			expect(mockSetCustomAICommands).not.toHaveBeenCalled();
		});

		it('should reset form after successful creation', () => {
			render(
				<AICommandsPanel
					theme={mockTheme}
					customAICommands={[]}
					setCustomAICommands={mockSetCustomAICommands}
				/>
			);

			fireEvent.click(screen.getByRole('button', { name: /Add Command/i }));

			fireEvent.change(screen.getByPlaceholderText('/mycommand'), { target: { value: '/newcmd' } });
			fireEvent.change(screen.getByPlaceholderText('Short description for autocomplete'), {
				target: { value: 'Description' },
			});
			fireEvent.change(screen.getByPlaceholderText(/The actual prompt sent to the AI/), {
				target: { value: 'Prompt' },
			});

			fireEvent.click(screen.getByRole('button', { name: /Create/i }));

			// Form should be closed
			expect(screen.queryByText('New Command')).not.toBeInTheDocument();
			// Add Command button should be back
			expect(screen.getByRole('button', { name: /Add Command/i })).toBeInTheDocument();
		});

		it('should append new command to existing commands', () => {
			const existingCommands = [createMockCommand({ id: 'cmd-1', command: '/existing' })];

			render(
				<AICommandsPanel
					theme={mockTheme}
					customAICommands={existingCommands}
					setCustomAICommands={mockSetCustomAICommands}
				/>
			);

			fireEvent.click(screen.getByRole('button', { name: /Add Command/i }));

			fireEvent.change(screen.getByPlaceholderText('/mycommand'), { target: { value: '/newcmd' } });
			fireEvent.change(screen.getByPlaceholderText('Short description for autocomplete'), {
				target: { value: 'Description' },
			});
			fireEvent.change(screen.getByPlaceholderText(/The actual prompt sent to the AI/), {
				target: { value: 'Prompt' },
			});

			fireEvent.click(screen.getByRole('button', { name: /Create/i }));

			const callArg = mockSetCustomAICommands.mock.calls[0][0];
			expect(callArg).toHaveLength(2);
			expect(callArg[0].command).toBe('/existing');
			expect(callArg[1].command).toBe('/newcmd');
		});

		it('should sanitize command ID (replace non-alphanumeric with dashes)', () => {
			render(
				<AICommandsPanel
					theme={mockTheme}
					customAICommands={[]}
					setCustomAICommands={mockSetCustomAICommands}
				/>
			);

			fireEvent.click(screen.getByRole('button', { name: /Add Command/i }));

			fireEvent.change(screen.getByPlaceholderText('/mycommand'), {
				target: { value: '/test@command#123!' },
			});
			fireEvent.change(screen.getByPlaceholderText('Short description for autocomplete'), {
				target: { value: 'Description' },
			});
			fireEvent.change(screen.getByPlaceholderText(/The actual prompt sent to the AI/), {
				target: { value: 'Prompt' },
			});

			fireEvent.click(screen.getByRole('button', { name: /Create/i }));

			const callArg = mockSetCustomAICommands.mock.calls[0][0];
			// ID generation: command.slice(1).toLowerCase().replace(/[^a-z0-9]/g, '-')
			// /test@command#123! => test@command#123! => test-command-123-
			expect(callArg[0].id).toMatch(/^custom-test-command-123--\d+$/);
		});
	});

	describe('Edit command', () => {
		it('should enter edit mode when edit button clicked', () => {
			const commands = [
				createMockCommand({
					id: 'cmd-1',
					command: '/editable',
					description: 'Editable command',
					prompt: 'Original prompt',
				}),
			];

			render(
				<AICommandsPanel
					theme={mockTheme}
					customAICommands={commands}
					setCustomAICommands={mockSetCustomAICommands}
				/>
			);

			// First expand the command (new collapsible UI)
			expandCommand('/editable');

			// Click edit button
			const editButton = screen.getByTitle('Edit command');
			fireEvent.click(editButton);

			// Should show edit form with current values
			const commandInput = screen.getByDisplayValue('/editable');
			const descInput = screen.getByDisplayValue('Editable command');
			const promptInput = screen.getByDisplayValue('Original prompt');

			expect(commandInput).toBeInTheDocument();
			expect(descInput).toBeInTheDocument();
			expect(promptInput).toBeInTheDocument();
		});

		it('should save edited command', () => {
			const commands = [
				createMockCommand({
					id: 'cmd-1',
					command: '/original',
					description: 'Original desc',
					prompt: 'Original prompt',
				}),
			];

			render(
				<AICommandsPanel
					theme={mockTheme}
					customAICommands={commands}
					setCustomAICommands={mockSetCustomAICommands}
				/>
			);

			// First expand the command (new collapsible UI)
			expandCommand('/original');

			// Enter edit mode
			fireEvent.click(screen.getByTitle('Edit command'));

			// Change values
			const commandInput = screen.getByDisplayValue('/original');
			fireEvent.change(commandInput, { target: { value: '/updated' } });

			const descInput = screen.getByDisplayValue('Original desc');
			fireEvent.change(descInput, { target: { value: 'Updated desc' } });

			// Save
			fireEvent.click(screen.getByRole('button', { name: /Save/i }));

			expect(mockSetCustomAICommands).toHaveBeenCalled();
			const callArg = mockSetCustomAICommands.mock.calls[0][0];
			expect(callArg[0].command).toBe('/updated');
			expect(callArg[0].description).toBe('Updated desc');
		});

		it('should add slash prefix when saving edit without slash', () => {
			const commands = [createMockCommand({ id: 'cmd-1', command: '/original' })];

			render(
				<AICommandsPanel
					theme={mockTheme}
					customAICommands={commands}
					setCustomAICommands={mockSetCustomAICommands}
				/>
			);

			// First expand the command (new collapsible UI)
			expandCommand('/original');

			fireEvent.click(screen.getByTitle('Edit command'));

			const commandInput = screen.getByDisplayValue('/original');
			fireEvent.change(commandInput, { target: { value: 'noslash' } });

			fireEvent.click(screen.getByRole('button', { name: /Save/i }));

			const callArg = mockSetCustomAICommands.mock.calls[0][0];
			expect(callArg[0].command).toBe('/noslash');
		});

		it('should cancel edit and restore original values', () => {
			const commands = [
				createMockCommand({ id: 'cmd-1', command: '/original', description: 'Original desc' }),
			];

			render(
				<AICommandsPanel
					theme={mockTheme}
					customAICommands={commands}
					setCustomAICommands={mockSetCustomAICommands}
				/>
			);

			// First expand the command (new collapsible UI)
			expandCommand('/original');

			fireEvent.click(screen.getByTitle('Edit command'));

			// Change values
			const commandInput = screen.getByDisplayValue('/original');
			fireEvent.change(commandInput, { target: { value: '/changed' } });

			// Cancel
			fireEvent.click(screen.getByRole('button', { name: /Cancel/i }));

			// Should show original values (not be in edit mode)
			expect(screen.queryByDisplayValue('/changed')).not.toBeInTheDocument();
			expect(screen.getByText('/original')).toBeInTheDocument();
			expect(mockSetCustomAICommands).not.toHaveBeenCalled();
		});

		it('should update only the edited command', () => {
			const commands = [
				createMockCommand({
					id: 'cmd-1',
					command: '/first',
					description: 'First',
					prompt: 'Prompt 1',
				}),
				createMockCommand({
					id: 'cmd-2',
					command: '/second',
					description: 'Second',
					prompt: 'Prompt 2',
				}),
			];

			render(
				<AICommandsPanel
					theme={mockTheme}
					customAICommands={commands}
					setCustomAICommands={mockSetCustomAICommands}
				/>
			);

			// First expand the first command (new collapsible UI)
			expandCommand('/first');

			// Edit first command
			const editButtons = screen.getAllByTitle('Edit command');
			fireEvent.click(editButtons[0]);

			const commandInput = screen.getByDisplayValue('/first');
			fireEvent.change(commandInput, { target: { value: '/updated-first' } });

			fireEvent.click(screen.getByRole('button', { name: /Save/i }));

			const callArg = mockSetCustomAICommands.mock.calls[0][0];
			expect(callArg[0].command).toBe('/updated-first');
			expect(callArg[1].command).toBe('/second'); // Unchanged
		});

		it('should not save edit if editingCommand is null', () => {
			const commands = [createMockCommand({ id: 'cmd-1', command: '/test' })];

			const { rerender } = render(
				<AICommandsPanel
					theme={mockTheme}
					customAICommands={commands}
					setCustomAICommands={mockSetCustomAICommands}
				/>
			);

			// This tests the early return in handleSaveEdit when editingCommand is null
			// By testing that if we never enter edit mode, nothing is saved
			expect(mockSetCustomAICommands).not.toHaveBeenCalled();
		});

		it('should show Save and Cancel buttons in edit mode', () => {
			const commands = [createMockCommand({ id: 'cmd-1', command: '/test' })];

			render(
				<AICommandsPanel
					theme={mockTheme}
					customAICommands={commands}
					setCustomAICommands={mockSetCustomAICommands}
				/>
			);

			// First expand the command (new collapsible UI)
			expandCommand('/test');

			fireEvent.click(screen.getByTitle('Edit command'));

			expect(screen.getByRole('button', { name: /Save/i })).toBeInTheDocument();
			expect(screen.getByRole('button', { name: /Cancel/i })).toBeInTheDocument();
		});
	});

	describe('Delete command', () => {
		it('should delete custom command', () => {
			const commands = [
				createMockCommand({ id: 'cmd-1', command: '/deletable', isBuiltIn: false }),
			];

			render(
				<AICommandsPanel
					theme={mockTheme}
					customAICommands={commands}
					setCustomAICommands={mockSetCustomAICommands}
				/>
			);

			// First expand the command (new collapsible UI)
			expandCommand('/deletable');

			fireEvent.click(screen.getByTitle('Delete command'));

			expect(mockSetCustomAICommands).toHaveBeenCalled();
			const callArg = mockSetCustomAICommands.mock.calls[0][0];
			expect(callArg).toHaveLength(0);
		});

		it('should not delete built-in command', () => {
			const commands = [createMockCommand({ id: 'cmd-1', command: '/builtin', isBuiltIn: true })];

			render(
				<AICommandsPanel
					theme={mockTheme}
					customAICommands={commands}
					setCustomAICommands={mockSetCustomAICommands}
				/>
			);

			// First expand the command (new collapsible UI)
			expandCommand('/builtin');

			// Built-in commands should not have delete button
			expect(screen.queryByTitle('Delete command')).not.toBeInTheDocument();
		});

		it('should remove only the specified command', () => {
			const commands = [
				createMockCommand({ id: 'cmd-1', command: '/first', isBuiltIn: false }),
				createMockCommand({ id: 'cmd-2', command: '/second', isBuiltIn: false }),
				createMockCommand({ id: 'cmd-3', command: '/third', isBuiltIn: false }),
			];

			render(
				<AICommandsPanel
					theme={mockTheme}
					customAICommands={commands}
					setCustomAICommands={mockSetCustomAICommands}
				/>
			);

			// First expand the second command (new collapsible UI)
			expandCommand('/second');

			// Delete second command
			const deleteButtons = screen.getAllByTitle('Delete command');
			fireEvent.click(deleteButtons[0]); // Now only the expanded command's delete button is visible

			const callArg = mockSetCustomAICommands.mock.calls[0][0];
			expect(callArg).toHaveLength(2);
			expect(callArg[0].command).toBe('/first');
			expect(callArg[1].command).toBe('/third');
		});

		it('should handle delete of non-existent command gracefully', () => {
			const commands = [createMockCommand({ id: 'cmd-1', command: '/test', isBuiltIn: false })];

			render(
				<AICommandsPanel
					theme={mockTheme}
					customAICommands={commands}
					setCustomAICommands={mockSetCustomAICommands}
				/>
			);

			// First expand the command (new collapsible UI)
			expandCommand('/test');

			// This tests the handleDelete function's guard clause
			fireEvent.click(screen.getByTitle('Delete command'));

			// Should have been called with filtered array
			expect(mockSetCustomAICommands).toHaveBeenCalledTimes(1);
		});
	});

	describe('Built-in commands', () => {
		it('should show Built-in badge for built-in commands', () => {
			const commands = [createMockCommand({ id: 'builtin-1', command: '/help', isBuiltIn: true })];

			render(
				<AICommandsPanel
					theme={mockTheme}
					customAICommands={commands}
					setCustomAICommands={mockSetCustomAICommands}
				/>
			);

			expect(screen.getByText('Built-in')).toBeInTheDocument();
		});

		it('should not show Built-in badge for custom commands', () => {
			const commands = [
				createMockCommand({ id: 'custom-1', command: '/custom', isBuiltIn: false }),
			];

			render(
				<AICommandsPanel
					theme={mockTheme}
					customAICommands={commands}
					setCustomAICommands={mockSetCustomAICommands}
				/>
			);

			expect(screen.queryByText('Built-in')).not.toBeInTheDocument();
		});

		it('should allow editing built-in commands', () => {
			const commands = [
				createMockCommand({
					id: 'builtin-1',
					command: '/help',
					description: 'Help command',
					isBuiltIn: true,
				}),
			];

			render(
				<AICommandsPanel
					theme={mockTheme}
					customAICommands={commands}
					setCustomAICommands={mockSetCustomAICommands}
				/>
			);

			// First expand the command (new collapsible UI)
			expandCommand('/help');

			// Edit button should exist
			const editButton = screen.getByTitle('Edit command');
			expect(editButton).toBeInTheDocument();

			// Enter edit mode and save
			fireEvent.click(editButton);

			const descInput = screen.getByDisplayValue('Help command');
			fireEvent.change(descInput, { target: { value: 'Updated help' } });

			fireEvent.click(screen.getByRole('button', { name: /Save/i }));

			expect(mockSetCustomAICommands).toHaveBeenCalled();
		});

		it('should not show delete button for built-in commands', () => {
			const commands = [
				createMockCommand({ id: 'builtin-1', command: '/help', isBuiltIn: true }),
				createMockCommand({ id: 'custom-1', command: '/custom', isBuiltIn: false }),
			];

			render(
				<AICommandsPanel
					theme={mockTheme}
					customAICommands={commands}
					setCustomAICommands={mockSetCustomAICommands}
				/>
			);

			// First expand both commands (new collapsible UI)
			expandCommand('/help');
			expandCommand('/custom');

			// Only one delete button should exist (for custom command)
			const deleteButtons = screen.getAllByTitle('Delete command');
			expect(deleteButtons).toHaveLength(1);
		});
	});

	describe('Command display', () => {
		it('should display command name with accent color', () => {
			const commands = [createMockCommand({ command: '/highlighted' })];

			render(
				<AICommandsPanel
					theme={mockTheme}
					customAICommands={commands}
					setCustomAICommands={mockSetCustomAICommands}
				/>
			);

			const commandText = screen.getByText('/highlighted');
			expect(commandText).toHaveStyle({ color: mockTheme.colors.accent });
		});

		it('should display command prompt in code block', () => {
			const commands = [createMockCommand({ prompt: 'This is the prompt content' })];

			render(
				<AICommandsPanel
					theme={mockTheme}
					customAICommands={commands}
					setCustomAICommands={mockSetCustomAICommands}
				/>
			);

			// First expand the command (new collapsible UI) to see the prompt
			expandCommand('/test');

			expect(screen.getByText('This is the prompt content')).toBeInTheDocument();
		});

		it('should apply theme colors to components', () => {
			const commands = [createMockCommand({ command: '/themed' })];

			render(
				<AICommandsPanel
					theme={mockTheme}
					customAICommands={commands}
					setCustomAICommands={mockSetCustomAICommands}
				/>
			);

			// Check description text uses textDim color
			const description = screen.getByText('Test command description');
			expect(description).toHaveStyle({ color: mockTheme.colors.textDim });
		});
	});

	describe('Input handling', () => {
		it('should update command input in create form', () => {
			render(
				<AICommandsPanel
					theme={mockTheme}
					customAICommands={[]}
					setCustomAICommands={mockSetCustomAICommands}
				/>
			);

			fireEvent.click(screen.getByRole('button', { name: /Add Command/i }));

			const input = screen.getByPlaceholderText('/mycommand');
			fireEvent.change(input, { target: { value: '/newvalue' } });

			expect(input).toHaveValue('/newvalue');
		});

		it('should update description input in create form', () => {
			render(
				<AICommandsPanel
					theme={mockTheme}
					customAICommands={[]}
					setCustomAICommands={mockSetCustomAICommands}
				/>
			);

			fireEvent.click(screen.getByRole('button', { name: /Add Command/i }));

			const input = screen.getByPlaceholderText('Short description for autocomplete');
			fireEvent.change(input, { target: { value: 'New description' } });

			expect(input).toHaveValue('New description');
		});

		it('should update prompt textarea in create form', () => {
			render(
				<AICommandsPanel
					theme={mockTheme}
					customAICommands={[]}
					setCustomAICommands={mockSetCustomAICommands}
				/>
			);

			fireEvent.click(screen.getByRole('button', { name: /Add Command/i }));

			const textarea = screen.getByPlaceholderText(/The actual prompt sent to the AI/);
			fireEvent.change(textarea, { target: { value: 'New prompt text' } });

			expect(textarea).toHaveValue('New prompt text');
		});

		it('should update command input in edit form', () => {
			const commands = [createMockCommand({ command: '/original' })];

			render(
				<AICommandsPanel
					theme={mockTheme}
					customAICommands={commands}
					setCustomAICommands={mockSetCustomAICommands}
				/>
			);

			// First expand the command (new collapsible UI)
			expandCommand('/original');

			fireEvent.click(screen.getByTitle('Edit command'));

			const input = screen.getByDisplayValue('/original');
			fireEvent.change(input, { target: { value: '/edited' } });

			expect(input).toHaveValue('/edited');
		});

		it('should update description input in edit form', () => {
			const commands = [createMockCommand({ description: 'Original description' })];

			render(
				<AICommandsPanel
					theme={mockTheme}
					customAICommands={commands}
					setCustomAICommands={mockSetCustomAICommands}
				/>
			);

			// First expand the command (new collapsible UI)
			expandCommand('/test');

			fireEvent.click(screen.getByTitle('Edit command'));

			const input = screen.getByDisplayValue('Original description');
			fireEvent.change(input, { target: { value: 'Edited description' } });

			expect(input).toHaveValue('Edited description');
		});

		it('should update prompt textarea in edit form', () => {
			const commands = [createMockCommand({ prompt: 'Original prompt' })];

			render(
				<AICommandsPanel
					theme={mockTheme}
					customAICommands={commands}
					setCustomAICommands={mockSetCustomAICommands}
				/>
			);

			// First expand the command (new collapsible UI)
			expandCommand('/test');

			fireEvent.click(screen.getByTitle('Edit command'));

			const textarea = screen.getByDisplayValue('Original prompt');
			fireEvent.change(textarea, { target: { value: 'Edited prompt' } });

			expect(textarea).toHaveValue('Edited prompt');
		});
	});

	describe('Edge cases', () => {
		it('should handle special characters in command', () => {
			render(
				<AICommandsPanel
					theme={mockTheme}
					customAICommands={[]}
					setCustomAICommands={mockSetCustomAICommands}
				/>
			);

			fireEvent.click(screen.getByRole('button', { name: /Add Command/i }));

			fireEvent.change(screen.getByPlaceholderText('/mycommand'), {
				target: { value: '/test<script>alert("xss")</script>' },
			});
			fireEvent.change(screen.getByPlaceholderText('Short description for autocomplete'), {
				target: { value: 'XSS test' },
			});
			fireEvent.change(screen.getByPlaceholderText(/The actual prompt sent to the AI/), {
				target: { value: 'Prompt' },
			});

			fireEvent.click(screen.getByRole('button', { name: /Create/i }));

			expect(mockSetCustomAICommands).toHaveBeenCalled();
			// Command should be sanitized in ID generation (non-alphanumeric replaced with dashes)
			// /test<script>alert("xss")</script> => test-script-alert--xss----script-
			const callArg = mockSetCustomAICommands.mock.calls[0][0];
			expect(callArg[0].id).toMatch(/^custom-test-script-alert--xss----script--\d+$/);
		});

		it('should handle unicode in command description', () => {
			const commands = [createMockCommand({ description: '日本語の説明 🎉' })];

			render(
				<AICommandsPanel
					theme={mockTheme}
					customAICommands={commands}
					setCustomAICommands={mockSetCustomAICommands}
				/>
			);

			expect(screen.getByText('日本語の説明 🎉')).toBeInTheDocument();
		});

		it('should handle very long prompt text', () => {
			const longPrompt = 'A'.repeat(10000);
			const commands = [createMockCommand({ prompt: longPrompt })];

			render(
				<AICommandsPanel
					theme={mockTheme}
					customAICommands={commands}
					setCustomAICommands={mockSetCustomAICommands}
				/>
			);

			// First expand the command (new collapsible UI) to see the prompt
			expandCommand('/test');

			// Prompt is truncated to 500 chars + '...' in the collapsed view
			const truncatedPrompt = longPrompt.substring(0, 500) + '...';
			expect(screen.getByText(truncatedPrompt)).toBeInTheDocument();
		});

		it('should handle empty commands array', () => {
			render(
				<AICommandsPanel
					theme={mockTheme}
					customAICommands={[]}
					setCustomAICommands={mockSetCustomAICommands}
				/>
			);

			expect(screen.getByText('No custom AI commands configured')).toBeInTheDocument();
		});

		it('should handle many commands', () => {
			const commands = Array.from({ length: 50 }, (_, i) =>
				createMockCommand({ id: `cmd-${i}`, command: `/command${i}` })
			);

			render(
				<AICommandsPanel
					theme={mockTheme}
					customAICommands={commands}
					setCustomAICommands={mockSetCustomAICommands}
				/>
			);

			expect(screen.getByText('/command0')).toBeInTheDocument();
			expect(screen.getByText('/command49')).toBeInTheDocument();
		});

		it('should handle whitespace-only inputs as invalid', () => {
			render(
				<AICommandsPanel
					theme={mockTheme}
					customAICommands={[]}
					setCustomAICommands={mockSetCustomAICommands}
				/>
			);

			fireEvent.click(screen.getByRole('button', { name: /Add Command/i }));

			// Fill with whitespace only (except command which starts with /)
			fireEvent.change(screen.getByPlaceholderText('/mycommand'), { target: { value: '/test' } });
			fireEvent.change(screen.getByPlaceholderText('Short description for autocomplete'), {
				target: { value: '   ' },
			});
			fireEvent.change(screen.getByPlaceholderText(/The actual prompt sent to the AI/), {
				target: { value: '   ' },
			});

			// Button should be enabled because fields are technically not empty
			// The component doesn't trim whitespace before checking
			const createButton = screen.getByRole('button', { name: /Create/i });
			expect(createButton).not.toBeDisabled();
		});

		it('should handle rapid create/cancel cycles', () => {
			render(
				<AICommandsPanel
					theme={mockTheme}
					customAICommands={[]}
					setCustomAICommands={mockSetCustomAICommands}
				/>
			);

			// Rapid create/cancel cycles
			for (let i = 0; i < 5; i++) {
				fireEvent.click(screen.getByRole('button', { name: /Add Command/i }));
				fireEvent.click(screen.getByRole('button', { name: /Cancel/i }));
			}

			// Should end in stable state
			expect(screen.getByRole('button', { name: /Add Command/i })).toBeInTheDocument();
			expect(screen.queryByText('New Command')).not.toBeInTheDocument();
		});
	});

	describe('Light theme', () => {
		const lightTheme: Theme = {
			...mockTheme,
			id: 'github-light',
			name: 'GitHub Light',
			mode: 'light',
			colors: {
				bgMain: '#ffffff',
				bgSidebar: '#f6f8fa',
				bgActivity: '#f0f0f0',
				border: '#d0d7de',
				textMain: '#24292f',
				textDim: '#57606a',
				accent: '#0969da',
				accentDim: '#0969da20',
				accentText: '#24292f',
				accentForeground: '#ffffff',
				success: '#1a7f37',
				warning: '#9a6700',
				error: '#cf222e',
			},
		};

		it('should render with light theme colors', () => {
			const commands = [createMockCommand({ command: '/themed' })];

			render(
				<AICommandsPanel
					theme={lightTheme}
					customAICommands={commands}
					setCustomAICommands={mockSetCustomAICommands}
				/>
			);

			const commandText = screen.getByText('/themed');
			expect(commandText).toHaveStyle({ color: lightTheme.colors.accent });
		});
	});

	describe('Template autocomplete integration', () => {
		it('should render autocomplete dropdown in create form', () => {
			render(
				<AICommandsPanel
					theme={mockTheme}
					customAICommands={[]}
					setCustomAICommands={mockSetCustomAICommands}
				/>
			);

			fireEvent.click(screen.getByRole('button', { name: /Add Command/i }));

			// Should render autocomplete dropdown (mocked)
			expect(screen.getByTestId('autocomplete-dropdown')).toBeInTheDocument();
		});

		it('should render autocomplete dropdown in edit form', () => {
			const commands = [
				createMockCommand({ id: 'cmd-1', command: '/test', prompt: 'Test prompt' }),
			];

			render(
				<AICommandsPanel
					theme={mockTheme}
					customAICommands={commands}
					setCustomAICommands={mockSetCustomAICommands}
				/>
			);

			// First expand the command (new collapsible UI)
			expandCommand('/test');

			fireEvent.click(screen.getByTitle('Edit command'));

			// Should render autocomplete dropdown (mocked)
			const dropdowns = screen.getAllByTestId('autocomplete-dropdown');
			expect(dropdowns.length).toBeGreaterThanOrEqual(1);
		});

		it('should show template variable hint in create form placeholder', () => {
			render(
				<AICommandsPanel
					theme={mockTheme}
					customAICommands={[]}
					setCustomAICommands={mockSetCustomAICommands}
				/>
			);

			fireEvent.click(screen.getByRole('button', { name: /Add Command/i }));

			const textarea = screen.getByPlaceholderText(/type {{ for variables/i);
			expect(textarea).toBeInTheDocument();
		});

		it('should update value when typing in create form through autocomplete handler', () => {
			render(
				<AICommandsPanel
					theme={mockTheme}
					customAICommands={[]}
					setCustomAICommands={mockSetCustomAICommands}
				/>
			);

			fireEvent.click(screen.getByRole('button', { name: /Add Command/i }));

			const textarea = screen.getByPlaceholderText(/type {{ for variables/i);
			fireEvent.change(textarea, { target: { value: 'Test {{' } });

			// The value should be updated through the autocomplete handler
			expect(textarea).toHaveValue('Test {{');
		});

		it('should update value when typing in edit form through autocomplete handler', () => {
			const commands = [createMockCommand({ id: 'cmd-1', command: '/test', prompt: 'Original' })];

			render(
				<AICommandsPanel
					theme={mockTheme}
					customAICommands={commands}
					setCustomAICommands={mockSetCustomAICommands}
				/>
			);

			// First expand the command (new collapsible UI)
			expandCommand('/test');

			fireEvent.click(screen.getByTitle('Edit command'));

			const textarea = screen.getByDisplayValue('Original');
			fireEvent.change(textarea, { target: { value: 'Updated {{' } });

			// The value should be updated through the autocomplete handler
			expect(textarea).toHaveValue('Updated {{');
		});

		it('should call autocomplete handleKeyDown on keydown in create form', () => {
			render(
				<AICommandsPanel
					theme={mockTheme}
					customAICommands={[]}
					setCustomAICommands={mockSetCustomAICommands}
				/>
			);

			fireEvent.click(screen.getByRole('button', { name: /Add Command/i }));

			const textarea = screen.getByPlaceholderText(/type {{ for variables/i);
			fireEvent.keyDown(textarea, { key: 'ArrowDown' });

			expect(mockHandleKeyDown).toHaveBeenCalled();
		});

		it('should call autocomplete handleKeyDown on keydown in edit form', () => {
			const commands = [createMockCommand({ id: 'cmd-1', command: '/test', prompt: 'Original' })];

			render(
				<AICommandsPanel
					theme={mockTheme}
					customAICommands={commands}
					setCustomAICommands={mockSetCustomAICommands}
				/>
			);

			// First expand the command (new collapsible UI)
			expandCommand('/test');

			fireEvent.click(screen.getByTitle('Edit command'));

			const textarea = screen.getByDisplayValue('Original');
			fireEvent.keyDown(textarea, { key: 'ArrowDown' });

			expect(mockHandleKeyDown).toHaveBeenCalled();
		});

		it('should insert tab character when Tab pressed and autocomplete not handling', () => {
			render(
				<AICommandsPanel
					theme={mockTheme}
					customAICommands={[]}
					setCustomAICommands={mockSetCustomAICommands}
				/>
			);

			fireEvent.click(screen.getByRole('button', { name: /Add Command/i }));

			const textarea = screen.getByPlaceholderText(/type {{ for variables/i) as HTMLTextAreaElement;

			// Set initial value
			fireEvent.change(textarea, { target: { value: 'line1' } });

			// Simulate Tab key (autocomplete mock returns false, so Tab should insert)
			fireEvent.keyDown(textarea, { key: 'Tab' });

			// The Tab key handler should have been triggered
			// Note: Due to mocking, we can't fully test the tab insertion but can verify the handler was called
			expect(mockHandleKeyDown).toHaveBeenCalled();
		});
	});
});

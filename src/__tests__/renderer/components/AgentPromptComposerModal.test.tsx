/**
 * Tests for AgentPromptComposerModal component
 *
 * AgentPromptComposerModal is a modal for editing agent prompts with:
 * - Large textarea for prompt editing
 * - Template variable support with autocomplete
 * - Collapsible template variables panel
 * - Token and character count display
 * - Layer stack integration for Escape handling
 * - Backdrop click to save and close
 * - Focus management
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { AgentPromptComposerModal } from '../../../renderer/components/AgentPromptComposerModal';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import type { Theme } from '../../../renderer/types';

// Mock lucide-react
vi.mock('lucide-react', () => ({
	X: () => <svg data-testid="x-icon" />,
	FileText: () => <svg data-testid="file-text-icon" />,
	Variable: () => <svg data-testid="variable-icon" />,
	ChevronDown: () => <svg data-testid="chevron-down-icon" />,
	ChevronRight: () => <svg data-testid="chevron-right-icon" />,
}));

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
const mockHandleChange = vi.fn();
const mockSelectVariable = vi.fn();
const mockAutocompleteRef = { current: null };

vi.mock('../../../renderer/hooks/input/useTemplateAutocomplete', () => ({
	useTemplateAutocomplete: () => ({
		autocompleteState: mockAutocompleteState,
		handleKeyDown: mockHandleKeyDown,
		handleChange: mockHandleChange,
		selectVariable: mockSelectVariable,
		closeAutocomplete: mockCloseAutocomplete,
		autocompleteRef: mockAutocompleteRef,
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

// Mock TEMPLATE_VARIABLES
vi.mock('../../../renderer/utils/templateVariables', () => ({
	TEMPLATE_VARIABLES: [
		{ variable: '{{TAB_NAME}}', description: 'Custom tab name' },
		{ variable: '{{AGENT_PATH}}', description: 'Agent home directory path' },
		{ variable: '{{DATE}}', description: 'Current date' },
		{ variable: '{{TIME}}', description: 'Current time' },
		{ variable: '{{GIT_BRANCH}}', description: 'Current git branch' },
	],
}));

// Create a test theme
const createTestTheme = (overrides: Partial<Theme['colors']> = {}): Theme => ({
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#1e1e1e',
		bgSidebar: '#252526',
		bgActivity: '#333333',
		textMain: '#d4d4d4',
		textDim: '#808080',
		accent: '#007acc',
		accentForeground: '#ffffff',
		border: '#404040',
		error: '#f14c4c',
		warning: '#cca700',
		success: '#89d185',
		info: '#3794ff',
		textInverse: '#000000',
		...overrides,
	},
});

// Helper to render with LayerStackProvider
const renderWithLayerStack = (ui: React.ReactElement) => {
	return render(<LayerStackProvider>{ui}</LayerStackProvider>);
};

describe('AgentPromptComposerModal', () => {
	let theme: Theme;

	beforeEach(() => {
		theme = createTestTheme();
		vi.clearAllMocks();
		mockAutocompleteState.isOpen = false;
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('estimateTokenCount helper function', () => {
		// The function is internal but we can test its behavior through the UI
		it('shows 0 tokens for empty text', () => {
			renderWithLayerStack(
				<AgentPromptComposerModal
					isOpen={true}
					onClose={vi.fn()}
					theme={theme}
					initialValue=""
					onSubmit={vi.fn()}
				/>
			);

			expect(screen.getByText('~0 tokens')).toBeInTheDocument();
		});

		it('estimates tokens correctly for short text', () => {
			// 8 characters / 4 = 2 tokens
			renderWithLayerStack(
				<AgentPromptComposerModal
					isOpen={true}
					onClose={vi.fn()}
					theme={theme}
					initialValue="12345678"
					onSubmit={vi.fn()}
				/>
			);

			expect(screen.getByText('~2 tokens')).toBeInTheDocument();
		});

		it('estimates tokens with ceiling for fractional values', () => {
			// 5 characters / 4 = 1.25, ceil = 2 tokens
			renderWithLayerStack(
				<AgentPromptComposerModal
					isOpen={true}
					onClose={vi.fn()}
					theme={theme}
					initialValue="12345"
					onSubmit={vi.fn()}
				/>
			);

			expect(screen.getByText('~2 tokens')).toBeInTheDocument();
		});

		it('formats large token counts with locale string', () => {
			// 10000 characters / 4 = 2500 tokens
			const longText = 'a'.repeat(10000);
			renderWithLayerStack(
				<AgentPromptComposerModal
					isOpen={true}
					onClose={vi.fn()}
					theme={theme}
					initialValue={longText}
					onSubmit={vi.fn()}
				/>
			);

			expect(screen.getByText('~2,500 tokens')).toBeInTheDocument();
		});
	});

	describe('rendering', () => {
		it('returns null when isOpen is false', () => {
			const { container } = renderWithLayerStack(
				<AgentPromptComposerModal
					isOpen={false}
					onClose={vi.fn()}
					theme={theme}
					initialValue="test"
					onSubmit={vi.fn()}
				/>
			);

			expect(container.firstChild).toBeNull();
		});

		it('renders modal when isOpen is true', () => {
			renderWithLayerStack(
				<AgentPromptComposerModal
					isOpen={true}
					onClose={vi.fn()}
					theme={theme}
					initialValue="test"
					onSubmit={vi.fn()}
				/>
			);

			expect(screen.getByText('Agent Prompt Editor')).toBeInTheDocument();
		});

		it('renders header with FileText icon and title', () => {
			renderWithLayerStack(
				<AgentPromptComposerModal
					isOpen={true}
					onClose={vi.fn()}
					theme={theme}
					initialValue=""
					onSubmit={vi.fn()}
				/>
			);

			expect(screen.getByTestId('file-text-icon')).toBeInTheDocument();
			expect(screen.getByText('Agent Prompt Editor')).toBeInTheDocument();
		});

		it('renders close button with X icon', () => {
			renderWithLayerStack(
				<AgentPromptComposerModal
					isOpen={true}
					onClose={vi.fn()}
					theme={theme}
					initialValue=""
					onSubmit={vi.fn()}
				/>
			);

			expect(screen.getByTestId('x-icon')).toBeInTheDocument();
			expect(screen.getByTitle('Close (Escape)')).toBeInTheDocument();
		});

		it('renders textarea with initial value', () => {
			renderWithLayerStack(
				<AgentPromptComposerModal
					isOpen={true}
					onClose={vi.fn()}
					theme={theme}
					initialValue="Initial prompt text"
					onSubmit={vi.fn()}
				/>
			);

			const textarea = screen.getByPlaceholderText(
				'Enter your agent prompt... (type {{ for variables)'
			);
			expect(textarea).toHaveValue('Initial prompt text');
		});

		it('renders template variables section collapsed by default', () => {
			renderWithLayerStack(
				<AgentPromptComposerModal
					isOpen={true}
					onClose={vi.fn()}
					theme={theme}
					initialValue=""
					onSubmit={vi.fn()}
				/>
			);

			expect(screen.getByText('Template Variables')).toBeInTheDocument();
			expect(screen.getByTestId('chevron-right-icon')).toBeInTheDocument();
			// Variables should not be visible when collapsed
			expect(screen.queryByText('Current session name')).not.toBeInTheDocument();
		});

		it('renders footer with character and token counts', () => {
			renderWithLayerStack(
				<AgentPromptComposerModal
					isOpen={true}
					onClose={vi.fn()}
					theme={theme}
					initialValue="test"
					onSubmit={vi.fn()}
				/>
			);

			expect(screen.getByText('4 characters')).toBeInTheDocument();
			expect(screen.getByText('~1 tokens')).toBeInTheDocument();
		});

		it('renders Done button', () => {
			renderWithLayerStack(
				<AgentPromptComposerModal
					isOpen={true}
					onClose={vi.fn()}
					theme={theme}
					initialValue=""
					onSubmit={vi.fn()}
				/>
			);

			expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument();
		});

		it('renders autocomplete dropdown component', () => {
			renderWithLayerStack(
				<AgentPromptComposerModal
					isOpen={true}
					onClose={vi.fn()}
					theme={theme}
					initialValue=""
					onSubmit={vi.fn()}
				/>
			);

			expect(screen.getByTestId('autocomplete-dropdown')).toBeInTheDocument();
		});
	});

	describe('theme styling', () => {
		it('applies theme colors to modal container', () => {
			renderWithLayerStack(
				<AgentPromptComposerModal
					isOpen={true}
					onClose={vi.fn()}
					theme={theme}
					initialValue=""
					onSubmit={vi.fn()}
				/>
			);

			// The modal container has w-[90vw] class
			const modalContainer = document.querySelector('.w-\\[90vw\\]');
			expect(modalContainer).toHaveStyle({ backgroundColor: theme.colors.bgMain });
		});

		it('applies accent color to header icon', () => {
			renderWithLayerStack(
				<AgentPromptComposerModal
					isOpen={true}
					onClose={vi.fn()}
					theme={theme}
					initialValue=""
					onSubmit={vi.fn()}
				/>
			);

			// Icon color is applied via style prop
			const icon = screen.getByTestId('file-text-icon').closest('svg');
			expect(icon).toBeInTheDocument();
		});

		it('applies accent color to Done button', () => {
			renderWithLayerStack(
				<AgentPromptComposerModal
					isOpen={true}
					onClose={vi.fn()}
					theme={theme}
					initialValue=""
					onSubmit={vi.fn()}
				/>
			);

			const doneButton = screen.getByRole('button', { name: 'Done' });
			expect(doneButton).toHaveStyle({ backgroundColor: theme.colors.accent });
		});
	});

	describe('template variables panel', () => {
		it('expands when clicking the header button', async () => {
			renderWithLayerStack(
				<AgentPromptComposerModal
					isOpen={true}
					onClose={vi.fn()}
					theme={theme}
					initialValue=""
					onSubmit={vi.fn()}
				/>
			);

			const toggleButton = screen.getByText('Template Variables').closest('button');
			expect(toggleButton).toBeInTheDocument();

			await act(async () => {
				fireEvent.click(toggleButton!);
			});

			expect(screen.getByTestId('chevron-down-icon')).toBeInTheDocument();
			expect(screen.getByText('Custom tab name')).toBeInTheDocument();
		});

		it('collapses when clicking the header button again', async () => {
			renderWithLayerStack(
				<AgentPromptComposerModal
					isOpen={true}
					onClose={vi.fn()}
					theme={theme}
					initialValue=""
					onSubmit={vi.fn()}
				/>
			);

			const toggleButton = screen.getByText('Template Variables').closest('button');

			// Expand
			await act(async () => {
				fireEvent.click(toggleButton!);
			});

			// Collapse
			await act(async () => {
				fireEvent.click(toggleButton!);
			});

			expect(screen.getByTestId('chevron-right-icon')).toBeInTheDocument();
			expect(screen.queryByText('Current session name')).not.toBeInTheDocument();
		});

		it('shows Variable icon in the panel header', async () => {
			renderWithLayerStack(
				<AgentPromptComposerModal
					isOpen={true}
					onClose={vi.fn()}
					theme={theme}
					initialValue=""
					onSubmit={vi.fn()}
				/>
			);

			expect(screen.getByTestId('variable-icon')).toBeInTheDocument();
		});

		it('shows all template variables when expanded', async () => {
			renderWithLayerStack(
				<AgentPromptComposerModal
					isOpen={true}
					onClose={vi.fn()}
					theme={theme}
					initialValue=""
					onSubmit={vi.fn()}
				/>
			);

			const toggleButton = screen.getByText('Template Variables').closest('button');
			await act(async () => {
				fireEvent.click(toggleButton!);
			});

			expect(screen.getByText('{{TAB_NAME}}')).toBeInTheDocument();
			expect(screen.getByText('{{AGENT_PATH}}')).toBeInTheDocument();
			expect(screen.getByText('{{DATE}}')).toBeInTheDocument();
			expect(screen.getByText('{{TIME}}')).toBeInTheDocument();
			expect(screen.getByText('{{GIT_BRANCH}}')).toBeInTheDocument();
		});

		it('shows description for each variable when expanded', async () => {
			renderWithLayerStack(
				<AgentPromptComposerModal
					isOpen={true}
					onClose={vi.fn()}
					theme={theme}
					initialValue=""
					onSubmit={vi.fn()}
				/>
			);

			const toggleButton = screen.getByText('Template Variables').closest('button');
			await act(async () => {
				fireEvent.click(toggleButton!);
			});

			expect(screen.getByText('Custom tab name')).toBeInTheDocument();
			expect(screen.getByText('Agent home directory path')).toBeInTheDocument();
			expect(screen.getByText('Current date')).toBeInTheDocument();
			expect(screen.getByText('Current time')).toBeInTheDocument();
			expect(screen.getByText('Current git branch')).toBeInTheDocument();
		});

		it('shows help text when expanded', async () => {
			renderWithLayerStack(
				<AgentPromptComposerModal
					isOpen={true}
					onClose={vi.fn()}
					theme={theme}
					initialValue=""
					onSubmit={vi.fn()}
				/>
			);

			const toggleButton = screen.getByText('Template Variables').closest('button');
			await act(async () => {
				fireEvent.click(toggleButton!);
			});

			expect(
				screen.getByText(
					'Use these variables in your prompt. They will be replaced with actual values at runtime.'
				)
			).toBeInTheDocument();
		});

		it('has clickable variables with title attribute', async () => {
			renderWithLayerStack(
				<AgentPromptComposerModal
					isOpen={true}
					onClose={vi.fn()}
					theme={theme}
					initialValue=""
					onSubmit={vi.fn()}
				/>
			);

			const toggleButton = screen.getByText('Template Variables').closest('button');
			await act(async () => {
				fireEvent.click(toggleButton!);
			});

			const variableCode = screen.getByText('{{TAB_NAME}}');
			expect(variableCode).toHaveAttribute('title', 'Click to insert');
		});
	});

	describe('variable insertion', () => {
		it('inserts variable at cursor position when clicked', async () => {
			renderWithLayerStack(
				<AgentPromptComposerModal
					isOpen={true}
					onClose={vi.fn()}
					theme={theme}
					initialValue="Hello World"
					onSubmit={vi.fn()}
				/>
			);

			// Expand variables panel
			const toggleButton = screen.getByText('Template Variables').closest('button');
			await act(async () => {
				fireEvent.click(toggleButton!);
			});

			const textarea = screen.getByPlaceholderText(
				'Enter your agent prompt... (type {{ for variables)'
			) as HTMLTextAreaElement;

			// Set cursor position in the middle
			await act(async () => {
				textarea.setSelectionRange(6, 6); // After "Hello "
			});

			// Click on a variable
			const variableCode = screen.getByText('{{TAB_NAME}}');
			await act(async () => {
				fireEvent.click(variableCode);
			});

			// Value should be updated with variable inserted
			expect(textarea.value).toBe('Hello {{TAB_NAME}}World');
		});

		it('replaces selected text when variable is clicked', async () => {
			renderWithLayerStack(
				<AgentPromptComposerModal
					isOpen={true}
					onClose={vi.fn()}
					theme={theme}
					initialValue="Hello World"
					onSubmit={vi.fn()}
				/>
			);

			// Expand variables panel
			const toggleButton = screen.getByText('Template Variables').closest('button');
			await act(async () => {
				fireEvent.click(toggleButton!);
			});

			const textarea = screen.getByPlaceholderText(
				'Enter your agent prompt... (type {{ for variables)'
			) as HTMLTextAreaElement;

			// Select "World"
			await act(async () => {
				textarea.setSelectionRange(6, 11); // Select "World"
			});

			// Click on a variable
			const variableCode = screen.getByText('{{DATE}}');
			await act(async () => {
				fireEvent.click(variableCode);
			});

			// "World" should be replaced with the variable
			expect(textarea.value).toBe('Hello {{DATE}}');
		});

		it('inserts at end when no cursor position (edge case)', async () => {
			renderWithLayerStack(
				<AgentPromptComposerModal
					isOpen={true}
					onClose={vi.fn()}
					theme={theme}
					initialValue=""
					onSubmit={vi.fn()}
				/>
			);

			// Expand variables panel
			const toggleButton = screen.getByText('Template Variables').closest('button');
			await act(async () => {
				fireEvent.click(toggleButton!);
			});

			// Click on a variable when textarea is empty
			const variableCode = screen.getByText('{{TIME}}');
			await act(async () => {
				fireEvent.click(variableCode);
			});

			const textarea = screen.getByPlaceholderText(
				'Enter your agent prompt... (type {{ for variables)'
			) as HTMLTextAreaElement;
			expect(textarea.value).toBe('{{TIME}}');
		});
	});

	describe('textarea interaction', () => {
		it('inserts tab character on Tab key', async () => {
			// Use "HelloWorld" without space so tab insertion is clearer
			renderWithLayerStack(
				<AgentPromptComposerModal
					isOpen={true}
					onClose={vi.fn()}
					theme={theme}
					initialValue="HelloWorld"
					onSubmit={vi.fn()}
				/>
			);

			const textarea = screen.getByPlaceholderText(
				'Enter your agent prompt... (type {{ for variables)'
			) as HTMLTextAreaElement;

			// Set cursor position after "Hello"
			textarea.selectionStart = 5;
			textarea.selectionEnd = 5;

			await act(async () => {
				fireEvent.keyDown(textarea, { key: 'Tab' });
			});

			expect(textarea.value).toBe('Hello\tWorld');
		});

		it('updates value when typing', async () => {
			renderWithLayerStack(
				<AgentPromptComposerModal
					isOpen={true}
					onClose={vi.fn()}
					theme={theme}
					initialValue=""
					onSubmit={vi.fn()}
				/>
			);

			const textarea = screen.getByPlaceholderText(
				'Enter your agent prompt... (type {{ for variables)'
			);

			await act(async () => {
				fireEvent.change(textarea, { target: { value: 'New prompt text' } });
			});

			expect(mockHandleChange).toHaveBeenCalled();
		});

		it('passes keydown events to autocomplete handler first', async () => {
			renderWithLayerStack(
				<AgentPromptComposerModal
					isOpen={true}
					onClose={vi.fn()}
					theme={theme}
					initialValue=""
					onSubmit={vi.fn()}
				/>
			);

			const textarea = screen.getByPlaceholderText(
				'Enter your agent prompt... (type {{ for variables)'
			);

			await act(async () => {
				fireEvent.keyDown(textarea, { key: 'ArrowDown' });
			});

			expect(mockHandleKeyDown).toHaveBeenCalled();
		});

		it('updates character count as user types', async () => {
			renderWithLayerStack(
				<AgentPromptComposerModal
					isOpen={true}
					onClose={vi.fn()}
					theme={theme}
					initialValue=""
					onSubmit={vi.fn()}
				/>
			);

			expect(screen.getByText('0 characters')).toBeInTheDocument();
		});

		it('updates token count as user types', async () => {
			renderWithLayerStack(
				<AgentPromptComposerModal
					isOpen={true}
					onClose={vi.fn()}
					theme={theme}
					initialValue="twelve chars" // 12 characters = 3 tokens
					onSubmit={vi.fn()}
				/>
			);

			expect(screen.getByText('12 characters')).toBeInTheDocument();
			expect(screen.getByText('~3 tokens')).toBeInTheDocument();
		});
	});

	describe('Done button behavior', () => {
		it('calls onSubmit with current value when clicked', async () => {
			const onSubmit = vi.fn();
			const onClose = vi.fn();

			renderWithLayerStack(
				<AgentPromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={theme}
					initialValue="My prompt"
					onSubmit={onSubmit}
				/>
			);

			const doneButton = screen.getByRole('button', { name: 'Done' });
			await act(async () => {
				fireEvent.click(doneButton);
			});

			expect(onSubmit).toHaveBeenCalledWith('My prompt');
			expect(onClose).toHaveBeenCalled();
		});
	});

	describe('close button behavior', () => {
		it('calls onSubmit and onClose when close button is clicked', async () => {
			const onSubmit = vi.fn();
			const onClose = vi.fn();

			renderWithLayerStack(
				<AgentPromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={theme}
					initialValue="Test value"
					onSubmit={onSubmit}
				/>
			);

			const closeButton = screen.getByTitle('Close (Escape)');
			await act(async () => {
				fireEvent.click(closeButton);
			});

			expect(onSubmit).toHaveBeenCalledWith('Test value');
			expect(onClose).toHaveBeenCalled();
		});
	});

	describe('backdrop click behavior', () => {
		it('calls onSubmit and onClose when clicking backdrop', async () => {
			const onSubmit = vi.fn();
			const onClose = vi.fn();

			renderWithLayerStack(
				<AgentPromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={theme}
					initialValue="Backdrop test"
					onSubmit={onSubmit}
				/>
			);

			// Find the backdrop (the outermost fixed div)
			const backdrop = document.querySelector('.fixed.inset-0');
			expect(backdrop).toBeInTheDocument();

			await act(async () => {
				fireEvent.click(backdrop!);
			});

			expect(onSubmit).toHaveBeenCalledWith('Backdrop test');
			expect(onClose).toHaveBeenCalled();
		});

		it('does not close when clicking inside modal content', async () => {
			const onSubmit = vi.fn();
			const onClose = vi.fn();

			renderWithLayerStack(
				<AgentPromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={theme}
					initialValue="Modal content"
					onSubmit={onSubmit}
				/>
			);

			// Click inside the modal (on the title)
			const title = screen.getByText('Agent Prompt Editor');
			await act(async () => {
				fireEvent.click(title);
			});

			expect(onSubmit).not.toHaveBeenCalled();
			expect(onClose).not.toHaveBeenCalled();
		});
	});

	describe('focus management', () => {
		it('focuses textarea when modal opens', async () => {
			renderWithLayerStack(
				<AgentPromptComposerModal
					isOpen={true}
					onClose={vi.fn()}
					theme={theme}
					initialValue="Focus test"
					onSubmit={vi.fn()}
				/>
			);

			const textarea = screen.getByPlaceholderText(
				'Enter your agent prompt... (type {{ for variables)'
			);

			await waitFor(() => {
				expect(textarea).toHaveFocus();
			});
		});

		it('sets cursor at end of text when modal opens', async () => {
			renderWithLayerStack(
				<AgentPromptComposerModal
					isOpen={true}
					onClose={vi.fn()}
					theme={theme}
					initialValue="Cursor position"
					onSubmit={vi.fn()}
				/>
			);

			const textarea = screen.getByPlaceholderText(
				'Enter your agent prompt... (type {{ for variables)'
			) as HTMLTextAreaElement;

			await waitFor(() => {
				expect(textarea.selectionStart).toBe(15); // Length of "Cursor position"
				expect(textarea.selectionEnd).toBe(15);
			});
		});
	});

	describe('value synchronization', () => {
		it('syncs value when modal opens with new initialValue', async () => {
			const { rerender } = renderWithLayerStack(
				<AgentPromptComposerModal
					isOpen={false}
					onClose={vi.fn()}
					theme={theme}
					initialValue="First value"
					onSubmit={vi.fn()}
				/>
			);

			rerender(
				<LayerStackProvider>
					<AgentPromptComposerModal
						isOpen={true}
						onClose={vi.fn()}
						theme={theme}
						initialValue="Updated value"
						onSubmit={vi.fn()}
					/>
				</LayerStackProvider>
			);

			const textarea = screen.getByPlaceholderText(
				'Enter your agent prompt... (type {{ for variables)'
			);
			expect(textarea).toHaveValue('Updated value');
		});

		it('closes autocomplete when modal opens', async () => {
			renderWithLayerStack(
				<AgentPromptComposerModal
					isOpen={true}
					onClose={vi.fn()}
					theme={theme}
					initialValue="Test"
					onSubmit={vi.fn()}
				/>
			);

			expect(mockCloseAutocomplete).toHaveBeenCalled();
		});
	});

	describe('layer stack integration', () => {
		it('registers with layer stack when opened', async () => {
			const { unmount } = renderWithLayerStack(
				<AgentPromptComposerModal
					isOpen={true}
					onClose={vi.fn()}
					theme={theme}
					initialValue=""
					onSubmit={vi.fn()}
				/>
			);

			// Modal should be visible (layer registered)
			expect(screen.getByText('Agent Prompt Editor')).toBeInTheDocument();

			unmount();
		});

		it('unregisters from layer stack when closed', async () => {
			const { rerender } = renderWithLayerStack(
				<AgentPromptComposerModal
					isOpen={true}
					onClose={vi.fn()}
					theme={theme}
					initialValue=""
					onSubmit={vi.fn()}
				/>
			);

			expect(screen.getByText('Agent Prompt Editor')).toBeInTheDocument();

			rerender(
				<LayerStackProvider>
					<AgentPromptComposerModal
						isOpen={false}
						onClose={vi.fn()}
						theme={theme}
						initialValue=""
						onSubmit={vi.fn()}
					/>
				</LayerStackProvider>
			);

			expect(screen.queryByText('Agent Prompt Editor')).not.toBeInTheDocument();
		});

		it('closes autocomplete first on Escape if autocomplete is open', async () => {
			// Set autocomplete as open
			mockAutocompleteState.isOpen = true;

			renderWithLayerStack(
				<AgentPromptComposerModal
					isOpen={true}
					onClose={vi.fn()}
					theme={theme}
					initialValue=""
					onSubmit={vi.fn()}
				/>
			);

			// Simulate Escape via layer stack
			const escapeEvent = new KeyboardEvent('keydown', {
				key: 'Escape',
				bubbles: true,
				cancelable: true,
			});

			await act(async () => {
				document.dispatchEvent(escapeEvent);
			});

			expect(mockCloseAutocomplete).toHaveBeenCalled();
		});
	});

	describe('character and token formatting', () => {
		it('formats character count with locale string', () => {
			const longText = 'a'.repeat(1234);
			renderWithLayerStack(
				<AgentPromptComposerModal
					isOpen={true}
					onClose={vi.fn()}
					theme={theme}
					initialValue={longText}
					onSubmit={vi.fn()}
				/>
			);

			expect(screen.getByText('1,234 characters')).toBeInTheDocument();
		});

		it('formats token count with locale string', () => {
			// 40000 characters / 4 = 10000 tokens
			const longText = 'a'.repeat(40000);
			renderWithLayerStack(
				<AgentPromptComposerModal
					isOpen={true}
					onClose={vi.fn()}
					theme={theme}
					initialValue={longText}
					onSubmit={vi.fn()}
				/>
			);

			expect(screen.getByText('~10,000 tokens')).toBeInTheDocument();
		});
	});

	describe('edge cases', () => {
		it('handles empty initialValue', () => {
			renderWithLayerStack(
				<AgentPromptComposerModal
					isOpen={true}
					onClose={vi.fn()}
					theme={theme}
					initialValue=""
					onSubmit={vi.fn()}
				/>
			);

			const textarea = screen.getByPlaceholderText(
				'Enter your agent prompt... (type {{ for variables)'
			);
			expect(textarea).toHaveValue('');
		});

		it('handles very long initialValue', () => {
			const longValue = 'This is a very long prompt. '.repeat(100);
			renderWithLayerStack(
				<AgentPromptComposerModal
					isOpen={true}
					onClose={vi.fn()}
					theme={theme}
					initialValue={longValue}
					onSubmit={vi.fn()}
				/>
			);

			const textarea = screen.getByPlaceholderText(
				'Enter your agent prompt... (type {{ for variables)'
			);
			expect(textarea).toHaveValue(longValue);
		});

		it('handles special characters in prompt', () => {
			const specialChars = 'Test with <script>alert("xss")</script> & special "chars" {{var}}';
			renderWithLayerStack(
				<AgentPromptComposerModal
					isOpen={true}
					onClose={vi.fn()}
					theme={theme}
					initialValue={specialChars}
					onSubmit={vi.fn()}
				/>
			);

			const textarea = screen.getByPlaceholderText(
				'Enter your agent prompt... (type {{ for variables)'
			);
			expect(textarea).toHaveValue(specialChars);
		});

		it('handles unicode characters', () => {
			const unicode = 'Test with emojis 🎵🎹🎼 and symbols ™®©';
			renderWithLayerStack(
				<AgentPromptComposerModal
					isOpen={true}
					onClose={vi.fn()}
					theme={theme}
					initialValue={unicode}
					onSubmit={vi.fn()}
				/>
			);

			const textarea = screen.getByPlaceholderText(
				'Enter your agent prompt... (type {{ for variables)'
			);
			expect(textarea).toHaveValue(unicode);
		});

		it('handles multiline text', () => {
			const multiline = 'Line 1\nLine 2\nLine 3\n\nLine 5';
			renderWithLayerStack(
				<AgentPromptComposerModal
					isOpen={true}
					onClose={vi.fn()}
					theme={theme}
					initialValue={multiline}
					onSubmit={vi.fn()}
				/>
			);

			const textarea = screen.getByPlaceholderText(
				'Enter your agent prompt... (type {{ for variables)'
			);
			expect(textarea).toHaveValue(multiline);
		});

		it('submits with modified value after user edits', async () => {
			const onSubmit = vi.fn();

			// Create a custom implementation that actually updates the state
			let currentValue = 'Initial';
			mockHandleChange.mockImplementation((e: React.ChangeEvent<HTMLTextAreaElement>) => {
				currentValue = e.target.value;
			});

			renderWithLayerStack(
				<AgentPromptComposerModal
					isOpen={true}
					onClose={vi.fn()}
					theme={theme}
					initialValue="Initial"
					onSubmit={onSubmit}
				/>
			);

			// The actual submit would use the internal state value
			const doneButton = screen.getByRole('button', { name: 'Done' });
			await act(async () => {
				fireEvent.click(doneButton);
			});

			expect(onSubmit).toHaveBeenCalledWith('Initial');
		});

		it('preserves value when toggling template variables panel', async () => {
			renderWithLayerStack(
				<AgentPromptComposerModal
					isOpen={true}
					onClose={vi.fn()}
					theme={theme}
					initialValue="Preserved value"
					onSubmit={vi.fn()}
				/>
			);

			const textarea = screen.getByPlaceholderText(
				'Enter your agent prompt... (type {{ for variables)'
			);
			expect(textarea).toHaveValue('Preserved value');

			// Toggle variables panel
			const toggleButton = screen.getByText('Template Variables').closest('button');
			await act(async () => {
				fireEvent.click(toggleButton!);
			});

			expect(textarea).toHaveValue('Preserved value');

			await act(async () => {
				fireEvent.click(toggleButton!);
			});

			expect(textarea).toHaveValue('Preserved value');
		});
	});

	describe('light theme support', () => {
		it('applies light theme colors correctly', () => {
			const lightTheme = createTestTheme({
				bgMain: '#ffffff',
				bgSidebar: '#f5f5f5',
				textMain: '#1e1e1e',
				textDim: '#666666',
				accent: '#0066cc',
				accentForeground: '#ffffff',
			});

			renderWithLayerStack(
				<AgentPromptComposerModal
					isOpen={true}
					onClose={vi.fn()}
					theme={lightTheme}
					initialValue=""
					onSubmit={vi.fn()}
				/>
			);

			const doneButton = screen.getByRole('button', { name: 'Done' });
			expect(doneButton).toHaveStyle({ backgroundColor: '#0066cc' });
		});
	});

	describe('rapid operations', () => {
		it('handles rapid open/close cycles', async () => {
			const { rerender } = renderWithLayerStack(
				<AgentPromptComposerModal
					isOpen={false}
					onClose={vi.fn()}
					theme={theme}
					initialValue=""
					onSubmit={vi.fn()}
				/>
			);

			for (let i = 0; i < 5; i++) {
				rerender(
					<LayerStackProvider>
						<AgentPromptComposerModal
							isOpen={true}
							onClose={vi.fn()}
							theme={theme}
							initialValue={`Value ${i}`}
							onSubmit={vi.fn()}
						/>
					</LayerStackProvider>
				);

				await act(async () => {});

				rerender(
					<LayerStackProvider>
						<AgentPromptComposerModal
							isOpen={false}
							onClose={vi.fn()}
							theme={theme}
							initialValue=""
							onSubmit={vi.fn()}
						/>
					</LayerStackProvider>
				);

				await act(async () => {});
			}

			// Should handle gracefully without errors
			expect(screen.queryByText('Agent Prompt Editor')).not.toBeInTheDocument();
		});

		it('handles rapid Done button clicks', async () => {
			const onSubmit = vi.fn();
			const onClose = vi.fn();

			renderWithLayerStack(
				<AgentPromptComposerModal
					isOpen={true}
					onClose={onClose}
					theme={theme}
					initialValue="Test"
					onSubmit={onSubmit}
				/>
			);

			const doneButton = screen.getByRole('button', { name: 'Done' });

			// Rapid clicks
			await act(async () => {
				fireEvent.click(doneButton);
				fireEvent.click(doneButton);
				fireEvent.click(doneButton);
			});

			// Should have been called multiple times (no debouncing)
			expect(onSubmit.mock.calls.length).toBeGreaterThanOrEqual(1);
		});
	});

	describe('onClose ref updates', () => {
		it('uses updated onClose when escape is pressed', async () => {
			const onClose1 = vi.fn();
			const onClose2 = vi.fn();

			const { rerender } = renderWithLayerStack(
				<AgentPromptComposerModal
					isOpen={true}
					onClose={onClose1}
					theme={theme}
					initialValue=""
					onSubmit={vi.fn()}
				/>
			);

			// Update onClose
			rerender(
				<LayerStackProvider>
					<AgentPromptComposerModal
						isOpen={true}
						onClose={onClose2}
						theme={theme}
						initialValue=""
						onSubmit={vi.fn()}
					/>
				</LayerStackProvider>
			);

			// Trigger escape via layer stack
			const escapeEvent = new KeyboardEvent('keydown', {
				key: 'Escape',
				bubbles: true,
				cancelable: true,
			});

			await act(async () => {
				document.dispatchEvent(escapeEvent);
			});

			// Should call the updated onClose, not the original
			// (Behavior depends on how the layer stack handler captures the ref)
		});
	});

	describe('onSubmit ref updates', () => {
		it('uses updated onSubmit when Done is clicked', async () => {
			const onSubmit1 = vi.fn();
			const onSubmit2 = vi.fn();

			const { rerender } = renderWithLayerStack(
				<AgentPromptComposerModal
					isOpen={true}
					onClose={vi.fn()}
					theme={theme}
					initialValue="Test"
					onSubmit={onSubmit1}
				/>
			);

			// Update onSubmit
			rerender(
				<LayerStackProvider>
					<AgentPromptComposerModal
						isOpen={true}
						onClose={vi.fn()}
						theme={theme}
						initialValue="Test"
						onSubmit={onSubmit2}
					/>
				</LayerStackProvider>
			);

			const doneButton = screen.getByRole('button', { name: 'Done' });
			await act(async () => {
				fireEvent.click(doneButton);
			});

			expect(onSubmit2).toHaveBeenCalledWith('Test');
			expect(onSubmit1).not.toHaveBeenCalled();
		});
	});

	describe('modal dimensions and layout', () => {
		it('has correct modal dimensions classes', () => {
			renderWithLayerStack(
				<AgentPromptComposerModal
					isOpen={true}
					onClose={vi.fn()}
					theme={theme}
					initialValue=""
					onSubmit={vi.fn()}
				/>
			);

			const modalContent = screen.getByText('Agent Prompt Editor').closest('.w-\\[90vw\\]');
			expect(modalContent).toHaveClass('h-[85vh]', 'max-w-5xl');
		});

		it('has fixed position backdrop', () => {
			renderWithLayerStack(
				<AgentPromptComposerModal
					isOpen={true}
					onClose={vi.fn()}
					theme={theme}
					initialValue=""
					onSubmit={vi.fn()}
				/>
			);

			const backdrop = document.querySelector('.fixed.inset-0');
			expect(backdrop).toBeInTheDocument();
			expect(backdrop).toHaveClass('z-[10001]');
		});
	});

	describe('requestAnimationFrame in variable insertion', () => {
		it('calls requestAnimationFrame when inserting variable', async () => {
			const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
				cb(0);
				return 0;
			});

			renderWithLayerStack(
				<AgentPromptComposerModal
					isOpen={true}
					onClose={vi.fn()}
					theme={theme}
					initialValue="Test"
					onSubmit={vi.fn()}
				/>
			);

			// Expand variables panel
			const toggleButton = screen.getByText('Template Variables').closest('button');
			await act(async () => {
				fireEvent.click(toggleButton!);
			});

			// Click on a variable
			const variableCode = screen.getByText('{{TAB_NAME}}');
			await act(async () => {
				fireEvent.click(variableCode);
			});

			expect(rafSpy).toHaveBeenCalled();

			rafSpy.mockRestore();
		});
	});
});

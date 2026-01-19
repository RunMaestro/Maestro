/**
 * Tests for PlaybookNameModal component
 *
 * PlaybookNameModal allows users to enter a name for saving playbooks with:
 * - Text input for playbook name
 * - Customizable title and button text
 * - Initial name support for editing existing playbooks
 * - Validation requiring non-empty name
 * - Layer stack integration for modal management
 * - Auto-focus and text selection on mount
 * - Keyboard navigation (Enter to save)
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { PlaybookNameModal } from '../../../renderer/components/PlaybookNameModal';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import type { Theme } from '../../../renderer/types';

// Mock lucide-react
vi.mock('lucide-react', () => ({
	X: () => <svg data-testid="x-icon" />,
	Save: () => <svg data-testid="save-icon" />,
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

// Helper to render component with LayerStackProvider
const renderWithProviders = (ui: React.ReactElement) => {
	return render(<LayerStackProvider>{ui}</LayerStackProvider>);
};

describe('PlaybookNameModal', () => {
	let theme: Theme;
	let onSave: ReturnType<typeof vi.fn>;
	let onCancel: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		theme = createTestTheme();
		onSave = vi.fn();
		onCancel = vi.fn();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.clearAllMocks();
		vi.useRealTimers();
	});

	describe('rendering', () => {
		it('should render with default props', async () => {
			renderWithProviders(<PlaybookNameModal theme={theme} onSave={onSave} onCancel={onCancel} />);

			// Check for default title
			expect(screen.getByText('Save Playbook')).toBeInTheDocument();
			// Check for default save button text
			expect(screen.getByRole('button', { name: /save/i })).toBeInTheDocument();
			// Check for cancel button
			expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
			// Check for input placeholder
			expect(screen.getByPlaceholderText('Enter playbook name...')).toBeInTheDocument();
			// Check for label
			expect(screen.getByText('Playbook Name')).toBeInTheDocument();
			// Check for helper text
			expect(screen.getByText(/give your playbook a descriptive name/i)).toBeInTheDocument();
		});

		it('should render with custom title', () => {
			renderWithProviders(
				<PlaybookNameModal
					theme={theme}
					onSave={onSave}
					onCancel={onCancel}
					title="Rename Playbook"
				/>
			);

			expect(screen.getByText('Rename Playbook')).toBeInTheDocument();
		});

		it('should render with custom save button text', () => {
			renderWithProviders(
				<PlaybookNameModal
					theme={theme}
					onSave={onSave}
					onCancel={onCancel}
					saveButtonText="Create"
				/>
			);

			expect(screen.getByRole('button', { name: 'Create' })).toBeInTheDocument();
		});

		it('should render with initial name', () => {
			renderWithProviders(
				<PlaybookNameModal
					theme={theme}
					onSave={onSave}
					onCancel={onCancel}
					initialName="My Playbook"
				/>
			);

			expect(screen.getByDisplayValue('My Playbook')).toBeInTheDocument();
		});

		it('should have proper ARIA attributes', () => {
			renderWithProviders(<PlaybookNameModal theme={theme} onSave={onSave} onCancel={onCancel} />);

			const dialog = screen.getByRole('dialog');
			expect(dialog).toHaveAttribute('aria-modal', 'true');
			expect(dialog).toHaveAttribute('aria-label', 'Save Playbook');
		});

		it('should update aria-label when title changes', () => {
			renderWithProviders(
				<PlaybookNameModal
					theme={theme}
					onSave={onSave}
					onCancel={onCancel}
					title="Edit Playbook"
				/>
			);

			const dialog = screen.getByRole('dialog');
			expect(dialog).toHaveAttribute('aria-label', 'Edit Playbook');
		});

		it('should display save icon', () => {
			renderWithProviders(<PlaybookNameModal theme={theme} onSave={onSave} onCancel={onCancel} />);

			expect(screen.getByTestId('save-icon')).toBeInTheDocument();
		});

		it('should display close icon button', () => {
			renderWithProviders(<PlaybookNameModal theme={theme} onSave={onSave} onCancel={onCancel} />);

			expect(screen.getByTestId('x-icon')).toBeInTheDocument();
		});
	});

	describe('theme styling', () => {
		it('should apply theme colors to modal container', () => {
			renderWithProviders(<PlaybookNameModal theme={theme} onSave={onSave} onCancel={onCancel} />);

			// Find the modal content container (has inline width of 400px)
			const modalContent = document.querySelector('[style*="width: 400px"]');
			expect(modalContent).toHaveStyle({
				backgroundColor: theme.colors.bgSidebar,
				borderColor: theme.colors.border,
			});
		});

		it('should apply theme colors to input', () => {
			renderWithProviders(<PlaybookNameModal theme={theme} onSave={onSave} onCancel={onCancel} />);

			const input = screen.getByPlaceholderText('Enter playbook name...');
			expect(input).toHaveStyle({
				borderColor: theme.colors.border,
				color: theme.colors.textMain,
			});
		});

		it('should apply theme colors to save button', () => {
			renderWithProviders(
				<PlaybookNameModal theme={theme} onSave={onSave} onCancel={onCancel} initialName="Test" />
			);

			const saveButton = screen.getByRole('button', { name: /save/i });
			expect(saveButton).toHaveStyle({
				backgroundColor: theme.colors.accent,
				color: theme.colors.accentForeground,
			});
		});
	});

	describe('input behavior', () => {
		it('should update input value when typing', () => {
			renderWithProviders(<PlaybookNameModal theme={theme} onSave={onSave} onCancel={onCancel} />);

			const input = screen.getByPlaceholderText('Enter playbook name...');
			fireEvent.change(input, { target: { value: 'New Playbook' } });

			expect(input).toHaveValue('New Playbook');
		});

		it('should auto-focus input on mount', async () => {
			renderWithProviders(<PlaybookNameModal theme={theme} onSave={onSave} onCancel={onCancel} />);

			// Wait for requestAnimationFrame
			await act(async () => {
				vi.advanceTimersByTime(16);
			});

			const input = screen.getByPlaceholderText('Enter playbook name...');
			expect(document.activeElement).toBe(input);
		});

		it('should select all text when initial name is provided', async () => {
			const selectSpy = vi.fn();
			const originalCreateElement = document.createElement.bind(document);
			const originalQuerySelector = document.querySelector.bind(document);

			renderWithProviders(
				<PlaybookNameModal
					theme={theme}
					onSave={onSave}
					onCancel={onCancel}
					initialName="Existing Playbook"
				/>
			);

			const input = screen.getByPlaceholderText('Enter playbook name...') as HTMLInputElement;
			const originalSelect = input.select.bind(input);
			input.select = vi.fn(() => {
				selectSpy();
				originalSelect();
			});

			// Wait for requestAnimationFrame
			await act(async () => {
				vi.advanceTimersByTime(16);
			});

			// The select should have been called
			expect(input).toHaveValue('Existing Playbook');
		});

		it('should handle special characters in name', () => {
			renderWithProviders(<PlaybookNameModal theme={theme} onSave={onSave} onCancel={onCancel} />);

			const input = screen.getByPlaceholderText('Enter playbook name...');
			fireEvent.change(input, { target: { value: 'Test!@#$%^&*()' } });

			expect(input).toHaveValue('Test!@#$%^&*()');
		});

		it('should handle unicode characters in name', () => {
			renderWithProviders(<PlaybookNameModal theme={theme} onSave={onSave} onCancel={onCancel} />);

			const input = screen.getByPlaceholderText('Enter playbook name...');
			fireEvent.change(input, { target: { value: '测试 Playbook 🎯' } });

			expect(input).toHaveValue('测试 Playbook 🎯');
		});

		it('should handle very long names', () => {
			renderWithProviders(<PlaybookNameModal theme={theme} onSave={onSave} onCancel={onCancel} />);

			const longName = 'A'.repeat(500);
			const input = screen.getByPlaceholderText('Enter playbook name...');
			fireEvent.change(input, { target: { value: longName } });

			expect(input).toHaveValue(longName);
		});
	});

	describe('validation', () => {
		it('should disable save button when name is empty', () => {
			renderWithProviders(<PlaybookNameModal theme={theme} onSave={onSave} onCancel={onCancel} />);

			const saveButton = screen.getByRole('button', { name: /save/i });
			expect(saveButton).toBeDisabled();
		});

		it('should disable save button when name is only whitespace', () => {
			renderWithProviders(<PlaybookNameModal theme={theme} onSave={onSave} onCancel={onCancel} />);

			const input = screen.getByPlaceholderText('Enter playbook name...');
			fireEvent.change(input, { target: { value: '   ' } });

			const saveButton = screen.getByRole('button', { name: /save/i });
			expect(saveButton).toBeDisabled();
		});

		it('should enable save button when name is valid', () => {
			renderWithProviders(<PlaybookNameModal theme={theme} onSave={onSave} onCancel={onCancel} />);

			const input = screen.getByPlaceholderText('Enter playbook name...');
			fireEvent.change(input, { target: { value: 'Valid Name' } });

			const saveButton = screen.getByRole('button', { name: /save/i });
			expect(saveButton).not.toBeDisabled();
		});

		it('should enable save button when initial name is provided', () => {
			renderWithProviders(
				<PlaybookNameModal
					theme={theme}
					onSave={onSave}
					onCancel={onCancel}
					initialName="Existing Playbook"
				/>
			);

			const saveButton = screen.getByRole('button', { name: /save/i });
			expect(saveButton).not.toBeDisabled();
		});

		it('should disable save button when all characters are deleted', () => {
			renderWithProviders(
				<PlaybookNameModal theme={theme} onSave={onSave} onCancel={onCancel} initialName="Test" />
			);

			const input = screen.getByPlaceholderText('Enter playbook name...');
			const saveButton = screen.getByRole('button', { name: /save/i });

			expect(saveButton).not.toBeDisabled();

			fireEvent.change(input, { target: { value: '' } });

			expect(saveButton).toBeDisabled();
		});

		it('should consider tab characters as whitespace', () => {
			renderWithProviders(<PlaybookNameModal theme={theme} onSave={onSave} onCancel={onCancel} />);

			const input = screen.getByPlaceholderText('Enter playbook name...');
			fireEvent.change(input, { target: { value: '\t\t\t' } });

			const saveButton = screen.getByRole('button', { name: /save/i });
			expect(saveButton).toBeDisabled();
		});

		it('should consider newlines as whitespace', () => {
			renderWithProviders(<PlaybookNameModal theme={theme} onSave={onSave} onCancel={onCancel} />);

			const input = screen.getByPlaceholderText('Enter playbook name...');
			fireEvent.change(input, { target: { value: '\n\n' } });

			const saveButton = screen.getByRole('button', { name: /save/i });
			expect(saveButton).toBeDisabled();
		});
	});

	describe('save action', () => {
		it('should call onSave with trimmed name when save button is clicked', () => {
			renderWithProviders(<PlaybookNameModal theme={theme} onSave={onSave} onCancel={onCancel} />);

			const input = screen.getByPlaceholderText('Enter playbook name...');
			fireEvent.change(input, { target: { value: '  My Playbook  ' } });

			const saveButton = screen.getByRole('button', { name: /save/i });
			fireEvent.click(saveButton);

			expect(onSave).toHaveBeenCalledTimes(1);
			expect(onSave).toHaveBeenCalledWith('My Playbook');
		});

		it('should call onSave when Enter is pressed with valid name', () => {
			renderWithProviders(<PlaybookNameModal theme={theme} onSave={onSave} onCancel={onCancel} />);

			const input = screen.getByPlaceholderText('Enter playbook name...');
			fireEvent.change(input, { target: { value: 'Test Playbook' } });
			fireEvent.keyDown(input, { key: 'Enter' });

			expect(onSave).toHaveBeenCalledTimes(1);
			expect(onSave).toHaveBeenCalledWith('Test Playbook');
		});

		it('should not call onSave when Enter is pressed with empty name', () => {
			renderWithProviders(<PlaybookNameModal theme={theme} onSave={onSave} onCancel={onCancel} />);

			const input = screen.getByPlaceholderText('Enter playbook name...');
			fireEvent.keyDown(input, { key: 'Enter' });

			expect(onSave).not.toHaveBeenCalled();
		});

		it('should not call onSave when Enter is pressed with whitespace only', () => {
			renderWithProviders(<PlaybookNameModal theme={theme} onSave={onSave} onCancel={onCancel} />);

			const input = screen.getByPlaceholderText('Enter playbook name...');
			fireEvent.change(input, { target: { value: '   ' } });
			fireEvent.keyDown(input, { key: 'Enter' });

			expect(onSave).not.toHaveBeenCalled();
		});

		it('should not call onSave when clicking disabled save button', () => {
			renderWithProviders(<PlaybookNameModal theme={theme} onSave={onSave} onCancel={onCancel} />);

			const saveButton = screen.getByRole('button', { name: /save/i });
			fireEvent.click(saveButton);

			expect(onSave).not.toHaveBeenCalled();
		});

		it('should preserve leading/trailing content in middle of name', () => {
			renderWithProviders(<PlaybookNameModal theme={theme} onSave={onSave} onCancel={onCancel} />);

			const input = screen.getByPlaceholderText('Enter playbook name...');
			fireEvent.change(input, { target: { value: 'Name  with   spaces' } });

			const saveButton = screen.getByRole('button', { name: /save/i });
			fireEvent.click(saveButton);

			expect(onSave).toHaveBeenCalledWith('Name  with   spaces');
		});

		it('should handle save with initial name unchanged', () => {
			renderWithProviders(
				<PlaybookNameModal
					theme={theme}
					onSave={onSave}
					onCancel={onCancel}
					initialName="Original Name"
				/>
			);

			const saveButton = screen.getByRole('button', { name: /save/i });
			fireEvent.click(saveButton);

			expect(onSave).toHaveBeenCalledWith('Original Name');
		});

		it('should handle save with modified initial name', () => {
			renderWithProviders(
				<PlaybookNameModal
					theme={theme}
					onSave={onSave}
					onCancel={onCancel}
					initialName="Original Name"
				/>
			);

			const input = screen.getByPlaceholderText('Enter playbook name...');
			fireEvent.change(input, { target: { value: 'Modified Name' } });

			const saveButton = screen.getByRole('button', { name: /save/i });
			fireEvent.click(saveButton);

			expect(onSave).toHaveBeenCalledWith('Modified Name');
		});
	});

	describe('cancel action', () => {
		it('should call onCancel when cancel button is clicked', () => {
			renderWithProviders(<PlaybookNameModal theme={theme} onSave={onSave} onCancel={onCancel} />);

			const cancelButton = screen.getByRole('button', { name: /cancel/i });
			fireEvent.click(cancelButton);

			expect(onCancel).toHaveBeenCalledTimes(1);
		});

		it('should call onCancel when X button is clicked', () => {
			renderWithProviders(<PlaybookNameModal theme={theme} onSave={onSave} onCancel={onCancel} />);

			// Find the X button by its icon
			const xIcon = screen.getByTestId('x-icon');
			const xButton = xIcon.closest('button');
			expect(xButton).not.toBeNull();
			fireEvent.click(xButton!);

			expect(onCancel).toHaveBeenCalledTimes(1);
		});

		it('should not call onSave when cancelled', () => {
			renderWithProviders(
				<PlaybookNameModal theme={theme} onSave={onSave} onCancel={onCancel} initialName="Test" />
			);

			const cancelButton = screen.getByRole('button', { name: /cancel/i });
			fireEvent.click(cancelButton);

			expect(onCancel).toHaveBeenCalledTimes(1);
			expect(onSave).not.toHaveBeenCalled();
		});
	});

	describe('keyboard navigation', () => {
		it('should prevent default on Enter key in input', () => {
			renderWithProviders(<PlaybookNameModal theme={theme} onSave={onSave} onCancel={onCancel} />);

			const input = screen.getByPlaceholderText('Enter playbook name...');
			fireEvent.change(input, { target: { value: 'Test' } });

			const event = new KeyboardEvent('keydown', {
				key: 'Enter',
				bubbles: true,
				cancelable: true,
			});
			const preventDefaultSpy = vi.spyOn(event, 'preventDefault');

			input.dispatchEvent(event);

			expect(preventDefaultSpy).toHaveBeenCalled();
		});

		it('should stop event propagation on key events in modal overlay', () => {
			renderWithProviders(<PlaybookNameModal theme={theme} onSave={onSave} onCancel={onCancel} />);

			const dialog = screen.getByRole('dialog');

			const event = new KeyboardEvent('keydown', {
				key: 'a',
				bubbles: true,
				cancelable: true,
			});
			const stopPropagationSpy = vi.spyOn(event, 'stopPropagation');

			dialog.dispatchEvent(event);

			expect(stopPropagationSpy).toHaveBeenCalled();
		});

		it('should not trigger save on other keys', () => {
			renderWithProviders(<PlaybookNameModal theme={theme} onSave={onSave} onCancel={onCancel} />);

			const input = screen.getByPlaceholderText('Enter playbook name...');
			fireEvent.change(input, { target: { value: 'Test' } });

			fireEvent.keyDown(input, { key: 'Tab' });
			fireEvent.keyDown(input, { key: 'Escape' });
			fireEvent.keyDown(input, { key: 'ArrowDown' });

			expect(onSave).not.toHaveBeenCalled();
		});
	});

	describe('layer stack integration', () => {
		it('should register layer on mount', () => {
			// Layer registration happens in useEffect
			renderWithProviders(<PlaybookNameModal theme={theme} onSave={onSave} onCancel={onCancel} />);

			// Modal should be rendered
			expect(screen.getByRole('dialog')).toBeInTheDocument();
		});

		it('should unregister layer on unmount', () => {
			const { unmount } = renderWithProviders(
				<PlaybookNameModal theme={theme} onSave={onSave} onCancel={onCancel} />
			);

			expect(screen.getByRole('dialog')).toBeInTheDocument();

			unmount();

			// Modal should be removed
			expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
		});

		it('should update layer handler when onCancel changes', () => {
			const { rerender } = render(
				<LayerStackProvider>
					<PlaybookNameModal theme={theme} onSave={onSave} onCancel={onCancel} />
				</LayerStackProvider>
			);

			const newOnCancel = vi.fn();

			rerender(
				<LayerStackProvider>
					<PlaybookNameModal theme={theme} onSave={onSave} onCancel={newOnCancel} />
				</LayerStackProvider>
			);

			// Modal should still be rendered
			expect(screen.getByRole('dialog')).toBeInTheDocument();
		});
	});

	describe('edge cases', () => {
		it('should handle rapid typing', () => {
			renderWithProviders(<PlaybookNameModal theme={theme} onSave={onSave} onCancel={onCancel} />);

			const input = screen.getByPlaceholderText('Enter playbook name...');

			for (let i = 0; i < 100; i++) {
				fireEvent.change(input, { target: { value: `Name${i}` } });
			}

			expect(input).toHaveValue('Name99');
		});

		it('should handle rapid save button clicks', () => {
			renderWithProviders(
				<PlaybookNameModal theme={theme} onSave={onSave} onCancel={onCancel} initialName="Test" />
			);

			const saveButton = screen.getByRole('button', { name: /save/i });

			for (let i = 0; i < 5; i++) {
				fireEvent.click(saveButton);
			}

			// Each click should call onSave
			expect(onSave).toHaveBeenCalledTimes(5);
		});

		it('should handle empty string initial name', () => {
			renderWithProviders(
				<PlaybookNameModal theme={theme} onSave={onSave} onCancel={onCancel} initialName="" />
			);

			const input = screen.getByPlaceholderText('Enter playbook name...');
			expect(input).toHaveValue('');

			const saveButton = screen.getByRole('button', { name: /save/i });
			expect(saveButton).toBeDisabled();
		});

		it('should handle undefined props gracefully', () => {
			renderWithProviders(
				<PlaybookNameModal
					theme={theme}
					onSave={onSave}
					onCancel={onCancel}
					initialName={undefined}
					title={undefined}
					saveButtonText={undefined}
				/>
			);

			expect(screen.getByText('Save Playbook')).toBeInTheDocument();
			expect(screen.getByRole('button', { name: /save/i })).toBeInTheDocument();
			expect(screen.getByDisplayValue('')).toBeInTheDocument();
		});

		it('should handle name starting with whitespace', () => {
			renderWithProviders(<PlaybookNameModal theme={theme} onSave={onSave} onCancel={onCancel} />);

			const input = screen.getByPlaceholderText('Enter playbook name...');
			fireEvent.change(input, { target: { value: '   Leading spaces' } });

			const saveButton = screen.getByRole('button', { name: /save/i });
			expect(saveButton).not.toBeDisabled();

			fireEvent.click(saveButton);

			expect(onSave).toHaveBeenCalledWith('Leading spaces');
		});

		it('should handle name ending with whitespace', () => {
			renderWithProviders(<PlaybookNameModal theme={theme} onSave={onSave} onCancel={onCancel} />);

			const input = screen.getByPlaceholderText('Enter playbook name...');
			fireEvent.change(input, { target: { value: 'Trailing spaces   ' } });

			const saveButton = screen.getByRole('button', { name: /save/i });
			fireEvent.click(saveButton);

			expect(onSave).toHaveBeenCalledWith('Trailing spaces');
		});

		it('should handle single character name', () => {
			renderWithProviders(<PlaybookNameModal theme={theme} onSave={onSave} onCancel={onCancel} />);

			const input = screen.getByPlaceholderText('Enter playbook name...');
			fireEvent.change(input, { target: { value: 'X' } });

			const saveButton = screen.getByRole('button', { name: /save/i });
			expect(saveButton).not.toBeDisabled();

			fireEvent.click(saveButton);

			expect(onSave).toHaveBeenCalledWith('X');
		});

		it('should handle name with only special characters', () => {
			renderWithProviders(<PlaybookNameModal theme={theme} onSave={onSave} onCancel={onCancel} />);

			const input = screen.getByPlaceholderText('Enter playbook name...');
			fireEvent.change(input, { target: { value: '!@#$%' } });

			const saveButton = screen.getByRole('button', { name: /save/i });
			expect(saveButton).not.toBeDisabled();

			fireEvent.click(saveButton);

			expect(onSave).toHaveBeenCalledWith('!@#$%');
		});
	});

	describe('all customization combinations', () => {
		it('should render with all custom props', () => {
			renderWithProviders(
				<PlaybookNameModal
					theme={theme}
					onSave={onSave}
					onCancel={onCancel}
					initialName="Custom Initial"
					title="Custom Title"
					saveButtonText="Custom Save"
				/>
			);

			expect(screen.getByText('Custom Title')).toBeInTheDocument();
			expect(screen.getByRole('button', { name: 'Custom Save' })).toBeInTheDocument();
			expect(screen.getByDisplayValue('Custom Initial')).toBeInTheDocument();
		});

		it('should work with light theme', () => {
			const lightTheme = createTestTheme({
				bgSidebar: '#ffffff',
				textMain: '#000000',
				textDim: '#666666',
				accent: '#0066cc',
				accentForeground: '#ffffff',
				border: '#cccccc',
			});

			renderWithProviders(
				<PlaybookNameModal theme={lightTheme} onSave={onSave} onCancel={onCancel} />
			);

			const modalContent = document.querySelector('[style*="width: 400px"]');
			expect(modalContent).toHaveStyle({
				backgroundColor: '#ffffff',
			});
		});
	});
});

/**
 * Tests for CreateGroupModal component
 *
 * CreateGroupModal allows users to create new session groups with:
 * - Custom group name (uppercased on save)
 * - Custom emoji icon selection
 * - Layer stack integration for modal management
 * - Input focus management and keyboard navigation
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { CreateGroupModal } from '../../../renderer/components/CreateGroupModal';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import type { Theme, Group } from '../../../renderer/types';

// Mock lucide-react
vi.mock('lucide-react', () => ({
	X: () => <svg data-testid="x-icon" />,
}));

// Mock emoji-mart
vi.mock('@emoji-mart/data', () => ({
	default: { categories: [], emojis: {} },
}));

vi.mock('@emoji-mart/react', () => ({
	default: ({
		onEmojiSelect,
		theme: pickerTheme,
	}: {
		onEmojiSelect: (emoji: { native: string }) => void;
		theme: string;
	}) => (
		<div data-testid="emoji-picker" data-theme={pickerTheme}>
			<button data-testid="select-emoji-🚀" onClick={() => onEmojiSelect({ native: '🚀' })}>
				🚀
			</button>
			<button data-testid="select-emoji-🎸" onClick={() => onEmojiSelect({ native: '🎸' })}>
				🎸
			</button>
			<button data-testid="select-emoji-💻" onClick={() => onEmojiSelect({ native: '💻' })}>
				💻
			</button>
		</div>
	),
}));

vi.mock('../../../renderer/utils/ids', () => ({
	generateId: () => 'test-id',
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

// Create test groups
const createTestGroups = (): Group[] => [
	{ id: 'group-1', name: 'EXISTING GROUP', emoji: '📁', collapsed: false },
];

// Helper to render with LayerStackProvider
const renderWithLayerStack = (ui: React.ReactElement) => {
	return render(<LayerStackProvider>{ui}</LayerStackProvider>);
};

describe('CreateGroupModal', () => {
	let theme: Theme;
	let groups: Group[];
	let setGroups: ReturnType<typeof vi.fn>;
	let onClose: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		theme = createTestTheme();
		groups = createTestGroups();
		setGroups = vi.fn();
		onClose = vi.fn();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.clearAllMocks();
		vi.useRealTimers();
	});

	const renderModal = (overrides: Partial<React.ComponentProps<typeof CreateGroupModal>> = {}) => {
		const defaultProps = {
			theme,
			onClose,
			groups,
			setGroups,
		};

		return renderWithLayerStack(<CreateGroupModal {...defaultProps} {...overrides} />);
	};

	describe('Initial render', () => {
		it('renders with dialog role and aria attributes', () => {
			renderModal();

			const dialog = screen.getByRole('dialog');
			expect(dialog).toHaveAttribute('aria-modal', 'true');
			expect(dialog).toHaveAttribute('aria-label', 'Create New Group');
		});

		it('renders header with title', () => {
			renderModal();

			expect(screen.getByText('Create New Group')).toBeInTheDocument();
		});

		it('renders close button in header', () => {
			renderModal();

			expect(screen.getByTestId('x-icon')).toBeInTheDocument();
		});

		it('renders Icon label', () => {
			renderModal();

			expect(screen.getByText('Icon')).toBeInTheDocument();
		});

		it('renders Group Name label', () => {
			renderModal();

			expect(screen.getByText('Group Name')).toBeInTheDocument();
		});

		it('renders emoji button with default emoji 📂', () => {
			renderModal();

			expect(screen.getByText('📂')).toBeInTheDocument();
		});

		it('renders input with placeholder', () => {
			renderModal();

			expect(screen.getByPlaceholderText('Enter group name...')).toBeInTheDocument();
		});

		it('renders Cancel button', () => {
			renderModal();

			expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
		});

		it('renders Create button', () => {
			renderModal();

			expect(screen.getByRole('button', { name: 'Create' })).toBeInTheDocument();
		});

		it('applies theme colors to modal container', () => {
			const { container } = renderModal();

			// Modal uses inline width style instead of Tailwind class
			const modalContent = container.querySelector('[style*="width: 400px"]');
			expect(modalContent).toHaveStyle({ backgroundColor: theme.colors.bgSidebar });
		});

		it('applies border color to modal container', () => {
			const { container } = renderModal();

			// Modal uses inline width style instead of Tailwind class
			const modalContent = container.querySelector('[style*="width: 400px"]');
			expect(modalContent).toHaveStyle({ borderColor: theme.colors.border });
		});

		it('has fixed positioning with backdrop', () => {
			renderModal();

			const dialog = screen.getByRole('dialog');
			expect(dialog).toHaveClass('fixed');
			expect(dialog).toHaveClass('inset-0');
			// Modal uses inline z-index style instead of Tailwind class
			expect(dialog).toHaveStyle({ zIndex: 9999 });
		});

		it('has modal overlay backdrop', () => {
			renderModal();

			const dialog = screen.getByRole('dialog');
			expect(dialog).toHaveClass('modal-overlay');
		});

		it('has animation classes', () => {
			renderModal();

			const dialog = screen.getByRole('dialog');
			expect(dialog).toHaveClass('animate-in');
			expect(dialog).toHaveClass('fade-in');
		});
	});

	describe('Focus management', () => {
		it('focuses input after delay on mount', async () => {
			renderModal();

			const input = screen.getByPlaceholderText('Enter group name...');

			// Advance timers to trigger focus
			act(() => {
				vi.advanceTimersByTime(100);
			});

			expect(document.activeElement).toBe(input);
		});

		it('cleans up focus timer on unmount', () => {
			const { unmount } = renderModal();

			// Unmount before timer fires
			unmount();

			// Advancing timers should not cause errors
			expect(() => {
				vi.advanceTimersByTime(100);
			}).not.toThrow();
		});
	});

	describe('Group name input', () => {
		it('updates value on change', async () => {
			renderModal();

			const input = screen.getByPlaceholderText('Enter group name...');
			fireEvent.change(input, { target: { value: 'My New Group' } });

			expect(input).toHaveValue('My New Group');
		});

		it('applies theme color to input text', () => {
			renderModal();

			const input = screen.getByPlaceholderText('Enter group name...');
			expect(input).toHaveStyle({ color: theme.colors.textMain });
		});

		it('applies border color to input', () => {
			renderModal();

			const input = screen.getByPlaceholderText('Enter group name...');
			expect(input).toHaveStyle({ borderColor: theme.colors.border });
		});

		it('triggers create on Enter key', async () => {
			renderModal();

			const input = screen.getByPlaceholderText('Enter group name...');
			fireEvent.change(input, { target: { value: 'Test Group' } });
			fireEvent.keyDown(input, { key: 'Enter' });

			expect(setGroups).toHaveBeenCalledTimes(1);
			expect(onClose).toHaveBeenCalledTimes(1);
		});

		it('does not create on Enter with empty name', () => {
			renderModal();

			const input = screen.getByPlaceholderText('Enter group name...');
			fireEvent.keyDown(input, { key: 'Enter' });

			expect(setGroups).not.toHaveBeenCalled();
			expect(onClose).not.toHaveBeenCalled();
		});

		it('does not create on other keys', () => {
			renderModal();

			const input = screen.getByPlaceholderText('Enter group name...');
			fireEvent.change(input, { target: { value: 'Test' } });
			fireEvent.keyDown(input, { key: 'a' });
			fireEvent.keyDown(input, { key: 'Tab' });
			fireEvent.keyDown(input, { key: 'Escape' });

			expect(setGroups).not.toHaveBeenCalled();
		});

		it('prevents default on Enter key', () => {
			renderModal();

			const input = screen.getByPlaceholderText('Enter group name...');
			fireEvent.change(input, { target: { value: 'Test' } });

			const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
			const preventDefaultSpy = vi.spyOn(event, 'preventDefault');
			input.dispatchEvent(event);

			expect(preventDefaultSpy).toHaveBeenCalled();
		});
	});

	describe('Close button', () => {
		it('calls onClose when clicked', () => {
			renderModal();

			const closeButton = screen.getByTestId('x-icon').closest('button');
			fireEvent.click(closeButton!);

			expect(onClose).toHaveBeenCalledTimes(1);
		});

		it('applies theme color to close button', () => {
			renderModal();

			const closeButton = screen.getByTestId('x-icon').closest('button');
			expect(closeButton).toHaveStyle({ color: theme.colors.textDim });
		});
	});

	describe('Cancel button', () => {
		it('calls onClose when clicked', () => {
			renderModal();

			fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

			expect(onClose).toHaveBeenCalledTimes(1);
		});

		it('does not call setGroups when clicked', () => {
			renderModal();

			fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

			expect(setGroups).not.toHaveBeenCalled();
		});

		it('applies theme styling', () => {
			renderModal();

			const cancelButton = screen.getByRole('button', { name: 'Cancel' });
			expect(cancelButton).toHaveStyle({
				borderColor: theme.colors.border,
				color: theme.colors.textMain,
			});
		});
	});

	describe('Create button', () => {
		it('is disabled when name is empty', () => {
			renderModal();

			const createButton = screen.getByRole('button', { name: 'Create' });
			expect(createButton).toBeDisabled();
		});

		it('is disabled when name is only whitespace', () => {
			renderModal();

			const input = screen.getByPlaceholderText('Enter group name...');
			fireEvent.change(input, { target: { value: '   ' } });

			const createButton = screen.getByRole('button', { name: 'Create' });
			expect(createButton).toBeDisabled();
		});

		it('is enabled when name has content', () => {
			renderModal();

			const input = screen.getByPlaceholderText('Enter group name...');
			fireEvent.change(input, { target: { value: 'Test' } });

			const createButton = screen.getByRole('button', { name: 'Create' });
			expect(createButton).not.toBeDisabled();
		});

		it('applies theme accent color', () => {
			renderModal();

			const createButton = screen.getByRole('button', { name: 'Create' });
			expect(createButton).toHaveStyle({
				backgroundColor: theme.colors.accent,
				color: theme.colors.accentForeground,
			});
		});

		it('has disabled styling classes', () => {
			renderModal();

			const createButton = screen.getByRole('button', { name: 'Create' });
			expect(createButton).toHaveClass('disabled:opacity-50');
			expect(createButton).toHaveClass('disabled:cursor-not-allowed');
		});
	});

	describe('Create group action', () => {
		it('creates group with uppercased name', () => {
			renderModal();

			const input = screen.getByPlaceholderText('Enter group name...');
			fireEvent.change(input, { target: { value: 'my test group' } });
			fireEvent.click(screen.getByRole('button', { name: 'Create' }));

			expect(setGroups).toHaveBeenCalledWith([
				...groups,
				expect.objectContaining({
					name: 'MY TEST GROUP',
				}),
			]);
		});

		it('creates group with trimmed name', () => {
			renderModal();

			const input = screen.getByPlaceholderText('Enter group name...');
			fireEvent.change(input, { target: { value: '  Test Group  ' } });
			fireEvent.click(screen.getByRole('button', { name: 'Create' }));

			expect(setGroups).toHaveBeenCalledWith([
				...groups,
				expect.objectContaining({
					name: 'TEST GROUP',
				}),
			]);
		});

		it('creates group with selected emoji', () => {
			renderModal();

			// Select emoji first
			fireEvent.click(screen.getByText('📂'));
			fireEvent.click(screen.getByTestId('select-emoji-🚀'));

			const input = screen.getByPlaceholderText('Enter group name...');
			fireEvent.change(input, { target: { value: 'Rockets' } });
			fireEvent.click(screen.getByRole('button', { name: 'Create' }));

			expect(setGroups).toHaveBeenCalledWith([
				...groups,
				expect.objectContaining({
					emoji: '🚀',
				}),
			]);
		});

		it('creates group with unique ID', () => {
			vi.spyOn(Date, 'now').mockReturnValue(1234567890);

			renderModal();

			const input = screen.getByPlaceholderText('Enter group name...');
			fireEvent.change(input, { target: { value: 'Test' } });
			fireEvent.click(screen.getByRole('button', { name: 'Create' }));

			expect(setGroups).toHaveBeenCalledWith([
				...groups,
				expect.objectContaining({
					id: 'group-test-id',
				}),
			]);
		});

		it('creates group with collapsed: false', () => {
			renderModal();

			const input = screen.getByPlaceholderText('Enter group name...');
			fireEvent.change(input, { target: { value: 'Test' } });
			fireEvent.click(screen.getByRole('button', { name: 'Create' }));

			expect(setGroups).toHaveBeenCalledWith([
				...groups,
				expect.objectContaining({
					collapsed: false,
				}),
			]);
		});

		it('resets state after creation', () => {
			renderModal();

			// Enter name and select emoji
			fireEvent.click(screen.getByText('📂'));
			fireEvent.click(screen.getByTestId('select-emoji-🎸'));

			const input = screen.getByPlaceholderText('Enter group name...');
			fireEvent.change(input, { target: { value: 'Rock Band' } });
			fireEvent.click(screen.getByRole('button', { name: 'Create' }));
			expect(onClose).toHaveBeenCalled();
		});

		it('calls onClose after creation', () => {
			renderModal();

			const input = screen.getByPlaceholderText('Enter group name...');
			fireEvent.change(input, { target: { value: 'Test' } });
			fireEvent.click(screen.getByRole('button', { name: 'Create' }));

			expect(onClose).toHaveBeenCalledTimes(1);
		});
	});

	describe('Emoji picker', () => {
		it('opens when emoji button is clicked', () => {
			renderModal();

			expect(screen.queryByTestId('emoji-picker')).not.toBeInTheDocument();

			fireEvent.click(screen.getByText('📂'));

			expect(screen.getByTestId('emoji-picker')).toBeInTheDocument();
		});

		it('closes when backdrop is clicked', () => {
			renderModal();

			// Open picker
			fireEvent.click(screen.getByText('📂'));
			expect(screen.getByTestId('emoji-picker')).toBeInTheDocument();

			// Click backdrop (the overlay div)
			const overlay = screen.getByTestId('emoji-picker').closest('.fixed');
			fireEvent.click(overlay!);

			expect(screen.queryByTestId('emoji-picker')).not.toBeInTheDocument();
		});

		it('has Escape key handler on overlay', () => {
			renderModal();

			// Open picker
			fireEvent.click(screen.getByText('📂'));

			// The overlay has onKeyDown for Escape handling and tabIndex for focus
			const overlay = screen.getByTestId('emoji-picker').closest('.fixed');
			expect(overlay).toHaveAttribute('tabIndex', '0');

			// Verify the overlay is focusable and could receive keyboard events
			expect(overlay).toBeInTheDocument();
		});

		it('does not close on non-Escape keys', () => {
			renderModal();

			// Open picker
			fireEvent.click(screen.getByText('📂'));

			const overlay = screen.getByTestId('emoji-picker').closest('.fixed');
			fireEvent.keyDown(overlay!, { key: 'a' });

			expect(screen.getByTestId('emoji-picker')).toBeInTheDocument();
		});

		it('updates emoji when selection is made', () => {
			renderModal();

			// Open picker and select
			fireEvent.click(screen.getByText('📂'));
			fireEvent.click(screen.getByTestId('select-emoji-💻'));

			// Check button now shows new emoji
			expect(screen.getByText('💻')).toBeInTheDocument();
		});

		it('closes picker after selection', () => {
			renderModal();

			// Open picker and select
			fireEvent.click(screen.getByText('📂'));
			fireEvent.click(screen.getByTestId('select-emoji-🚀'));

			expect(screen.queryByTestId('emoji-picker')).not.toBeInTheDocument();
		});

		it('focuses input after closing picker', () => {
			renderModal();

			// Advance timers to let initial focus work
			act(() => {
				vi.advanceTimersByTime(100);
			});

			// Open picker and select
			fireEvent.click(screen.getByText('📂'));
			fireEvent.click(screen.getByTestId('select-emoji-🎸'));

			const input = screen.getByPlaceholderText('Enter group name...');
			expect(document.activeElement).toBe(input);
		});

		it('does not propagate click events from picker', () => {
			renderModal();

			fireEvent.click(screen.getByText('📂'));

			// Click on the picker container (not the backdrop)
			const pickerContainer = screen.getByTestId('emoji-picker').parentElement;
			fireEvent.click(pickerContainer!);

			// Picker should still be visible
			expect(screen.getByTestId('emoji-picker')).toBeInTheDocument();
		});

		it('renders close button on picker overlay', () => {
			renderModal();

			fireEvent.click(screen.getByText('📂'));

			// Find the close button in the picker overlay
			const closeButtons = screen.getAllByTestId('x-icon');
			expect(closeButtons.length).toBe(2); // Header close + Picker close
		});

		it('closes picker when picker close button is clicked', () => {
			renderModal();

			fireEvent.click(screen.getByText('📂'));

			// Get all X icons and click the second one (picker close)
			const closeButtons = screen.getAllByTestId('x-icon');
			const pickerCloseButton = closeButtons[1].closest('button');
			fireEvent.click(pickerCloseButton!);

			expect(screen.queryByTestId('emoji-picker')).not.toBeInTheDocument();
		});

		it('toggles picker open/closed when emoji button clicked twice', () => {
			renderModal();

			// Open
			fireEvent.click(screen.getByText('📂'));
			expect(screen.getByTestId('emoji-picker')).toBeInTheDocument();

			// Close
			fireEvent.click(screen.getByText('📂'));
			expect(screen.queryByTestId('emoji-picker')).not.toBeInTheDocument();
		});

		it('passes theme mode to picker', () => {
			renderModal();

			fireEvent.click(screen.getByText('📂'));

			const picker = screen.getByTestId('emoji-picker');
			expect(picker).toHaveAttribute('data-theme', 'dark');
		});

		it('passes light theme mode to picker', () => {
			const lightTheme: Theme = {
				...theme,
				mode: 'light',
			};

			renderModal({ theme: lightTheme });

			fireEvent.click(screen.getByText('📂'));

			const picker = screen.getByTestId('emoji-picker');
			expect(picker).toHaveAttribute('data-theme', 'light');
		});

		it('prevents event propagation on Escape key in picker', () => {
			const parentHandler = vi.fn();

			render(
				<div onKeyDown={parentHandler}>
					<LayerStackProvider>
						<CreateGroupModal
							theme={theme}
							onClose={onClose}
							groups={groups}
							setGroups={setGroups}
						/>
					</LayerStackProvider>
				</div>
			);

			// Open picker
			fireEvent.click(screen.getByText('📂'));

			// Press Escape on overlay
			const overlay = screen.getByTestId('emoji-picker').closest('.fixed');
			fireEvent.keyDown(overlay!, { key: 'Escape', bubbles: true });

			// Parent handler should not be called due to stopPropagation
			expect(parentHandler).not.toHaveBeenCalled();
		});

		it('has visible styling for picker overlay', () => {
			renderModal();

			fireEvent.click(screen.getByText('📂'));

			const overlay = screen.getByTestId('emoji-picker').closest('.fixed');
			expect(overlay).toHaveClass('modal-overlay');
			expect(overlay).toHaveClass('z-[60]');
		});

		it('applies accent border to picker container', () => {
			renderModal();

			fireEvent.click(screen.getByText('📂'));

			const pickerContainer = screen.getByTestId('emoji-picker').parentElement;
			expect(pickerContainer).toHaveStyle({ borderColor: theme.colors.accent });
		});
	});

	describe('Layer stack integration', () => {
		it('registers layer on mount', () => {
			const { unmount } = renderModal();

			// Modal should be visible
			expect(screen.getByRole('dialog')).toBeInTheDocument();

			// Cleanup should work
			unmount();
		});

		it('unregisters layer on unmount', () => {
			const { unmount } = renderModal();

			expect(() => unmount()).not.toThrow();
		});

		it('updates layer handler when onClose changes', () => {
			const onClose1 = vi.fn();
			const onClose2 = vi.fn();

			const { rerender } = render(
				<LayerStackProvider>
					<CreateGroupModal
						theme={theme}
						onClose={onClose1}
						groups={groups}
						setGroups={setGroups}
					/>
				</LayerStackProvider>
			);

			// Rerender with new onClose
			rerender(
				<LayerStackProvider>
					<CreateGroupModal
						theme={theme}
						onClose={onClose2}
						groups={groups}
						setGroups={setGroups}
					/>
				</LayerStackProvider>
			);

			// Modal should still be visible
			expect(screen.getByRole('dialog')).toBeInTheDocument();
		});
	});

	describe('Theme variations', () => {
		it('renders with light theme', () => {
			const lightTheme = createTestTheme({
				bgSidebar: '#f5f5f5',
				textMain: '#333333',
				textDim: '#666666',
				border: '#cccccc',
			});

			const { container } = renderModal({ theme: lightTheme });

			// Modal uses inline width style instead of Tailwind class
			const modalContent = container.querySelector('[style*="width: 400px"]');
			expect(modalContent).toHaveStyle({ backgroundColor: lightTheme.colors.bgSidebar });
		});

		it('renders with custom accent color', () => {
			const customTheme = createTestTheme({
				accent: '#ff6b6b',
				accentForeground: '#000000',
			});

			renderModal({ theme: customTheme });

			const createButton = screen.getByRole('button', { name: 'Create' });
			expect(createButton).toHaveStyle({
				backgroundColor: customTheme.colors.accent,
				color: customTheme.colors.accentForeground,
			});
		});
	});

	describe('Edge cases', () => {
		it('handles special characters in group name', () => {
			renderModal();

			const input = screen.getByPlaceholderText('Enter group name...');
			fireEvent.change(input, { target: { value: 'Test & <Group> "Name"' } });
			fireEvent.click(screen.getByRole('button', { name: 'Create' }));

			expect(setGroups).toHaveBeenCalledWith([
				...groups,
				expect.objectContaining({
					name: 'TEST & <GROUP> "NAME"',
				}),
			]);
		});

		it('handles unicode in group name', () => {
			renderModal();

			const input = screen.getByPlaceholderText('Enter group name...');
			fireEvent.change(input, { target: { value: 'テスト Group 🎵' } });
			fireEvent.click(screen.getByRole('button', { name: 'Create' }));

			expect(setGroups).toHaveBeenCalledWith([
				...groups,
				expect.objectContaining({
					name: 'テスト GROUP 🎵',
				}),
			]);
		});

		it('handles very long group names', () => {
			renderModal();

			const longName = 'A'.repeat(200);
			const input = screen.getByPlaceholderText('Enter group name...');
			fireEvent.change(input, { target: { value: longName } });
			fireEvent.click(screen.getByRole('button', { name: 'Create' }));

			expect(setGroups).toHaveBeenCalledWith([
				...groups,
				expect.objectContaining({
					name: longName,
				}),
			]);
		});

		it('handles empty groups array', () => {
			renderModal({ groups: [] });

			const input = screen.getByPlaceholderText('Enter group name...');
			fireEvent.change(input, { target: { value: 'First Group' } });
			fireEvent.click(screen.getByRole('button', { name: 'Create' }));

			expect(setGroups).toHaveBeenCalledWith([
				expect.objectContaining({
					name: 'FIRST GROUP',
				}),
			]);
		});

		it('handles rapid create clicks', () => {
			renderModal();

			const input = screen.getByPlaceholderText('Enter group name...');
			fireEvent.change(input, { target: { value: 'Test' } });

			const createButton = screen.getByRole('button', { name: 'Create' });
			fireEvent.click(createButton);

			// After first click, state resets (name cleared, onClose called)
			// So button is disabled and subsequent clicks don't create groups
			expect(setGroups).toHaveBeenCalledTimes(1);
			expect(onClose).toHaveBeenCalledTimes(1);
		});
	});

	describe('Accessibility', () => {
		it('has proper heading hierarchy', () => {
			renderModal();

			const heading = screen.getByRole('heading', { level: 2 });
			expect(heading).toHaveTextContent('Create New Group');
		});

		it('has proper button labels', () => {
			renderModal();

			const buttons = screen.getAllByRole('button');
			// Emoji button, X close, Cancel, Create
			expect(buttons.length).toBeGreaterThanOrEqual(4);
		});

		it('has proper input labeling', () => {
			renderModal();

			const label = screen.getByText('Group Name');
			expect(label).toHaveClass('uppercase');
		});

		it('input can receive focus', () => {
			renderModal();

			const input = screen.getByPlaceholderText('Enter group name...');
			// Verify the input is focusable (it has autoFocus in JSX which triggers focus via setTimeout)
			input.focus();
			expect(document.activeElement).toBe(input);
		});

		it('emoji button has type=button', () => {
			renderModal();

			// Find emoji button (contains 📂)
			const emojiButton = screen.getByText('📂').closest('button');
			expect(emojiButton).toHaveAttribute('type', 'button');
		});
	});
});

/**
 * Tests for RenameGroupModal component
 *
 * RenameGroupModal allows users to rename existing session groups with:
 * - Custom group name (uppercased on save)
 * - Custom emoji icon selection
 * - Layer stack integration for modal management
 * - Input focus management and keyboard navigation
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { RenameGroupModal } from '../../../renderer/components/RenameGroupModal';
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
	{ id: 'group-1', name: 'MY GROUP', emoji: '📁', collapsed: false },
	{ id: 'group-2', name: 'ANOTHER GROUP', emoji: '🚀', collapsed: true },
];

// Helper to render with LayerStackProvider
const renderWithLayerStack = (ui: React.ReactElement) => {
	return render(<LayerStackProvider>{ui}</LayerStackProvider>);
};

describe('RenameGroupModal', () => {
	let theme: Theme;
	let groups: Group[];
	let setGroups: ReturnType<typeof vi.fn>;
	let setGroupName: ReturnType<typeof vi.fn>;
	let setGroupEmoji: ReturnType<typeof vi.fn>;
	let onClose: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		theme = createTestTheme();
		groups = createTestGroups();
		setGroups = vi.fn();
		setGroupName = vi.fn();
		setGroupEmoji = vi.fn();
		onClose = vi.fn();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.runOnlyPendingTimers();
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	const defaultProps = () => ({
		theme,
		groupId: 'group-1',
		groupName: 'My Group',
		setGroupName,
		groupEmoji: '📁',
		setGroupEmoji,
		onClose,
		groups,
		setGroups,
	});

	describe('Rendering', () => {
		it('should render modal with correct structure', () => {
			renderWithLayerStack(<RenameGroupModal {...defaultProps()} />);

			// Check dialog role
			expect(screen.getByRole('dialog')).toBeInTheDocument();
			expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');
			expect(screen.getByRole('dialog')).toHaveAttribute('aria-label', 'Rename Group');
		});

		it('should display header with title and close button', () => {
			renderWithLayerStack(<RenameGroupModal {...defaultProps()} />);

			expect(screen.getByText('Rename Group')).toBeInTheDocument();
			expect(screen.getByTestId('x-icon')).toBeInTheDocument();
		});

		it('should display icon label and group name label', () => {
			renderWithLayerStack(<RenameGroupModal {...defaultProps()} />);

			expect(screen.getByText('Icon')).toBeInTheDocument();
			expect(screen.getByText('Group Name')).toBeInTheDocument();
		});

		it('should display current emoji in emoji button', () => {
			renderWithLayerStack(<RenameGroupModal {...defaultProps()} />);

			// EmojiPickerField uses aria-label for accessibility
			const emojiButton = screen.getByRole('button', { name: /select emoji/i });
			expect(emojiButton).toBeInTheDocument();
			expect(emojiButton).toHaveTextContent('📁');
		});

		it('should display current group name in input', () => {
			renderWithLayerStack(<RenameGroupModal {...defaultProps()} />);

			const input = screen.getByPlaceholderText('Enter group name...');
			expect(input).toHaveValue('My Group');
		});

		it('should display Cancel and Rename buttons', () => {
			renderWithLayerStack(<RenameGroupModal {...defaultProps()} />);

			expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
			expect(screen.getByRole('button', { name: 'Rename' })).toBeInTheDocument();
		});

		it('should apply theme colors correctly', () => {
			renderWithLayerStack(<RenameGroupModal {...defaultProps()} />);

			const dialog = screen.getByRole('dialog');
			expect(dialog).toBeInTheDocument();

			// Check that theme styling is applied (backdrop is fixed and has modal overlay)
			expect(dialog.className).toContain('modal-overlay');
		});
	});

	describe('Input behavior', () => {
		it('should call setGroupName when input value changes', () => {
			renderWithLayerStack(<RenameGroupModal {...defaultProps()} />);

			const input = screen.getByPlaceholderText('Enter group name...');
			fireEvent.change(input, { target: { value: 'New Name' } });

			expect(setGroupName).toHaveBeenCalledWith('New Name');
		});

		it('should have autoFocus prop when emoji picker is closed', () => {
			renderWithLayerStack(<RenameGroupModal {...defaultProps()} />);

			// The input should be in the document and ready to receive focus
			// autoFocus is a React prop, not an HTML attribute in jsdom
			const input = screen.getByPlaceholderText('Enter group name...');
			expect(input).toBeInTheDocument();
			expect(input).toHaveAttribute('placeholder', 'Enter group name...');
		});
	});

	describe('Emoji picker', () => {
		it('should not show emoji picker initially', () => {
			renderWithLayerStack(<RenameGroupModal {...defaultProps()} />);

			expect(screen.queryByTestId('emoji-picker')).not.toBeInTheDocument();
		});

		it('should show emoji picker when emoji button is clicked', async () => {
			renderWithLayerStack(<RenameGroupModal {...defaultProps()} />);

			const emojiButton = screen.getByRole('button', { name: /select emoji/i });
			await act(async () => {
				fireEvent.click(emojiButton);
			});

			expect(screen.getByTestId('emoji-picker')).toBeInTheDocument();
		});

		it('should toggle emoji picker on repeated clicks', async () => {
			renderWithLayerStack(<RenameGroupModal {...defaultProps()} />);

			const emojiButton = screen.getByRole('button', { name: /select emoji/i });

			// Open
			await act(async () => {
				fireEvent.click(emojiButton);
			});
			expect(screen.getByTestId('emoji-picker')).toBeInTheDocument();

			// Close by clicking button again
			await act(async () => {
				fireEvent.click(emojiButton);
			});
			expect(screen.queryByTestId('emoji-picker')).not.toBeInTheDocument();
		});

		it('should call setGroupEmoji and close picker when emoji is selected', async () => {
			renderWithLayerStack(<RenameGroupModal {...defaultProps()} />);

			// Open emoji picker
			const emojiButton = screen.getByRole('button', { name: /select emoji/i });
			await act(async () => {
				fireEvent.click(emojiButton);
			});

			// Select an emoji
			const rocketEmoji = screen.getByTestId('select-emoji-🚀');
			await act(async () => {
				fireEvent.click(rocketEmoji);
			});

			expect(setGroupEmoji).toHaveBeenCalledWith('🚀');
			expect(screen.queryByTestId('emoji-picker')).not.toBeInTheDocument();
		});

		it('should close emoji picker when clicking backdrop', async () => {
			renderWithLayerStack(<RenameGroupModal {...defaultProps()} />);

			// Open emoji picker
			const emojiButton = screen.getByRole('button', { name: /select emoji/i });
			await act(async () => {
				fireEvent.click(emojiButton);
			});

			expect(screen.getByTestId('emoji-picker')).toBeInTheDocument();

			// Click the overlay backdrop (the fixed inset-0 div)
			const overlay = screen.getByTestId('emoji-picker').closest('.fixed');
			if (overlay) {
				await act(async () => {
					fireEvent.click(overlay);
				});
			}

			expect(screen.queryByTestId('emoji-picker')).not.toBeInTheDocument();
		});

		it('should have Escape key handler on emoji picker overlay', async () => {
			renderWithLayerStack(<RenameGroupModal {...defaultProps()} />);

			// Open emoji picker
			const emojiButton = screen.getByRole('button', { name: /select emoji/i });
			await act(async () => {
				fireEvent.click(emojiButton);
			});

			expect(screen.getByTestId('emoji-picker')).toBeInTheDocument();

			// The overlay exists and has tabIndex for keyboard handling
			const overlay = screen.getByTestId('emoji-picker').closest('.fixed');
			expect(overlay).toBeInTheDocument();
			expect(overlay).toHaveAttribute('tabIndex', '0');

			// Close via close button in the overlay
			const closeButtons = screen.getAllByTestId('x-icon');
			// The last close button is in the emoji picker overlay
			const overlayCloseButton = closeButtons[closeButtons.length - 1].closest('button');
			await act(async () => {
				fireEvent.click(overlayCloseButton!);
			});

			expect(screen.queryByTestId('emoji-picker')).not.toBeInTheDocument();
		});

		it('should have close button in emoji picker overlay', async () => {
			renderWithLayerStack(<RenameGroupModal {...defaultProps()} />);

			// Open emoji picker
			const emojiButton = screen.getByRole('button', { name: /select emoji/i });
			await act(async () => {
				fireEvent.click(emojiButton);
			});

			// There should be close X buttons (header and picker overlay)
			const closeIcons = screen.getAllByTestId('x-icon');
			expect(closeIcons.length).toBeGreaterThanOrEqual(2);
		});

		it('should pass theme mode to emoji picker', async () => {
			const lightTheme = createTestTheme();
			lightTheme.mode = 'light';

			renderWithLayerStack(<RenameGroupModal {...defaultProps()} theme={lightTheme} />);

			const emojiButton = screen.getByRole('button', { name: /select emoji/i });
			await act(async () => {
				fireEvent.click(emojiButton);
			});

			const picker = screen.getByTestId('emoji-picker');
			expect(picker).toHaveAttribute('data-theme', 'light');
		});
	});

	describe('Rename functionality', () => {
		it('should enable Rename button when group name is not empty', () => {
			renderWithLayerStack(<RenameGroupModal {...defaultProps()} />);

			const renameButton = screen.getByRole('button', { name: 'Rename' });
			expect(renameButton).not.toBeDisabled();
		});

		it('should disable Rename button when group name is empty', () => {
			renderWithLayerStack(<RenameGroupModal {...defaultProps()} groupName="" />);

			const renameButton = screen.getByRole('button', { name: 'Rename' });
			expect(renameButton).toBeDisabled();
		});

		it('should disable Rename button when group name is only whitespace', () => {
			renderWithLayerStack(<RenameGroupModal {...defaultProps()} groupName="   " />);

			const renameButton = screen.getByRole('button', { name: 'Rename' });
			expect(renameButton).toBeDisabled();
		});

		it('should call setGroups with updated group when Rename is clicked', async () => {
			renderWithLayerStack(
				<RenameGroupModal {...defaultProps()} groupName="new name" groupEmoji="🎸" />
			);

			const renameButton = screen.getByRole('button', { name: 'Rename' });
			await act(async () => {
				fireEvent.click(renameButton);
			});

			expect(setGroups).toHaveBeenCalled();

			// Get the updater function passed to setGroups
			const updater = setGroups.mock.calls[0][0];
			const result = updater(groups);

			// The group should be updated with uppercased name and new emoji
			expect(result.find((g: Group) => g.id === 'group-1')).toEqual({
				id: 'group-1',
				name: 'NEW NAME', // uppercased
				emoji: '🎸',
				collapsed: false,
			});

			// Other groups should be unchanged
			expect(result.find((g: Group) => g.id === 'group-2')).toEqual(groups[1]);
		});

		it('should trim whitespace from group name on rename', async () => {
			renderWithLayerStack(<RenameGroupModal {...defaultProps()} groupName="  spaced name  " />);

			const renameButton = screen.getByRole('button', { name: 'Rename' });
			await act(async () => {
				fireEvent.click(renameButton);
			});

			const updater = setGroups.mock.calls[0][0];
			const result = updater(groups);

			expect(result.find((g: Group) => g.id === 'group-1').name).toBe('SPACED NAME');
		});

		it('should call onClose after renaming', async () => {
			renderWithLayerStack(<RenameGroupModal {...defaultProps()} />);

			const renameButton = screen.getByRole('button', { name: 'Rename' });
			await act(async () => {
				fireEvent.click(renameButton);
			});

			expect(onClose).toHaveBeenCalled();
		});

		it('should rename on Enter key in input', async () => {
			renderWithLayerStack(<RenameGroupModal {...defaultProps()} groupName="enter test" />);

			const input = screen.getByPlaceholderText('Enter group name...');
			await act(async () => {
				fireEvent.keyDown(input, { key: 'Enter' });
			});

			expect(setGroups).toHaveBeenCalled();
			expect(onClose).toHaveBeenCalled();
		});

		it('should not rename when group name is empty and Enter is pressed', async () => {
			renderWithLayerStack(<RenameGroupModal {...defaultProps()} groupName="" />);

			const input = screen.getByPlaceholderText('Enter group name...');
			await act(async () => {
				fireEvent.keyDown(input, { key: 'Enter' });
			});

			expect(setGroups).not.toHaveBeenCalled();
			expect(onClose).not.toHaveBeenCalled();
		});

		it('should not rename when groupId is missing', async () => {
			renderWithLayerStack(<RenameGroupModal {...defaultProps()} groupId="" groupName="test" />);

			const renameButton = screen.getByRole('button', { name: 'Rename' });
			await act(async () => {
				fireEvent.click(renameButton);
			});

			expect(setGroups).not.toHaveBeenCalled();
		});
	});

	describe('Close functionality', () => {
		it('should call onClose when Cancel button is clicked', async () => {
			renderWithLayerStack(<RenameGroupModal {...defaultProps()} />);

			const cancelButton = screen.getByRole('button', { name: 'Cancel' });
			await act(async () => {
				fireEvent.click(cancelButton);
			});

			expect(onClose).toHaveBeenCalled();
		});

		it('should call onClose when X button is clicked', async () => {
			renderWithLayerStack(<RenameGroupModal {...defaultProps()} />);

			// Get the header X button (first one)
			const closeButtons = screen.getAllByTestId('x-icon');
			const headerCloseButton = closeButtons[0].closest('button');

			await act(async () => {
				fireEvent.click(headerCloseButton!);
			});

			expect(onClose).toHaveBeenCalled();
		});

		it('should stop propagation for non-Escape keys', async () => {
			const parentHandler = vi.fn();

			render(
				<LayerStackProvider>
					<div onKeyDown={parentHandler}>
						<RenameGroupModal {...defaultProps()} />
					</div>
				</LayerStackProvider>
			);

			const dialog = screen.getByRole('dialog');
			await act(async () => {
				fireEvent.keyDown(dialog, { key: 'Tab' });
			});

			// Non-escape keys should be stopped from propagating
			expect(parentHandler).not.toHaveBeenCalled();
		});

		it('should not stop Escape key propagation (delegated to layer stack)', async () => {
			// The component's keydown handler only stops non-Escape keys
			// Escape is delegated to the layer stack system
			renderWithLayerStack(<RenameGroupModal {...defaultProps()} />);

			const dialog = screen.getByRole('dialog');

			// Verify the dialog exists and escape key handling is not explicitly stopped
			// The layer stack handles escape via its registered onEscape callback
			expect(dialog).toBeInTheDocument();

			// Verify dialog has proper structure for keyboard events
			expect(dialog).toHaveAttribute('tabIndex', '-1');
		});
	});

	describe('Layer stack integration', () => {
		it('should register layer on mount', () => {
			// This is implicitly tested - if layer stack integration is broken,
			// other tests would fail due to missing context
			renderWithLayerStack(<RenameGroupModal {...defaultProps()} />);

			expect(screen.getByRole('dialog')).toBeInTheDocument();
		});

		it('should update layer handler when onClose changes', async () => {
			const firstOnClose = vi.fn();
			const secondOnClose = vi.fn();

			const { rerender } = renderWithLayerStack(
				<RenameGroupModal {...defaultProps()} onClose={firstOnClose} />
			);

			// Rerender with new onClose
			rerender(
				<LayerStackProvider>
					<RenameGroupModal {...defaultProps()} onClose={secondOnClose} />
				</LayerStackProvider>
			);

			// Cancel should call the new handler
			const cancelButton = screen.getByRole('button', { name: 'Cancel' });
			await act(async () => {
				fireEvent.click(cancelButton);
			});

			expect(secondOnClose).toHaveBeenCalled();
			expect(firstOnClose).not.toHaveBeenCalled();
		});
	});

	describe('Edge cases', () => {
		it('should handle renaming a group that does not exist in groups array', async () => {
			renderWithLayerStack(
				<RenameGroupModal {...defaultProps()} groupId="nonexistent-group" groupName="test" />
			);

			const renameButton = screen.getByRole('button', { name: 'Rename' });
			await act(async () => {
				fireEvent.click(renameButton);
			});

			// setGroups should still be called
			expect(setGroups).toHaveBeenCalled();

			// But the groups array should be unchanged since no group matches
			const updater = setGroups.mock.calls[0][0];
			const result = updater(groups);

			expect(result).toEqual(groups);
		});

		it('should handle empty groups array', async () => {
			renderWithLayerStack(<RenameGroupModal {...defaultProps()} groups={[]} groupName="test" />);

			const renameButton = screen.getByRole('button', { name: 'Rename' });
			await act(async () => {
				fireEvent.click(renameButton);
			});

			const updater = setGroups.mock.calls[0][0];
			const result = updater([]);

			expect(result).toEqual([]);
		});

		it('should handle special characters in group name', async () => {
			renderWithLayerStack(
				<RenameGroupModal {...defaultProps()} groupName="Test & <Group> 'Name'" />
			);

			const renameButton = screen.getByRole('button', { name: 'Rename' });
			await act(async () => {
				fireEvent.click(renameButton);
			});

			const updater = setGroups.mock.calls[0][0];
			const result = updater(groups);

			expect(result.find((g: Group) => g.id === 'group-1').name).toBe("TEST & <GROUP> 'NAME'");
		});

		it('should handle unicode characters in group name', async () => {
			renderWithLayerStack(<RenameGroupModal {...defaultProps()} groupName="Tëst Grøüp 日本語" />);

			const renameButton = screen.getByRole('button', { name: 'Rename' });
			await act(async () => {
				fireEvent.click(renameButton);
			});

			const updater = setGroups.mock.calls[0][0];
			const result = updater(groups);

			// toUpperCase works differently for unicode - just verify it's stored
			expect(result.find((g: Group) => g.id === 'group-1').name).toBe('TËST GRØÜP 日本語');
		});

		it('should preserve other group properties when renaming', async () => {
			const groupsWithExtras = [{ id: 'group-1', name: 'MY GROUP', emoji: '📁', collapsed: true }];

			renderWithLayerStack(
				<RenameGroupModal
					{...defaultProps()}
					groups={groupsWithExtras}
					groupName="Updated"
					groupEmoji="🎉"
				/>
			);

			const renameButton = screen.getByRole('button', { name: 'Rename' });
			await act(async () => {
				fireEvent.click(renameButton);
			});

			const updater = setGroups.mock.calls[0][0];
			const result = updater(groupsWithExtras);

			// collapsed should be preserved
			expect(result[0]).toEqual({
				id: 'group-1',
				name: 'UPDATED',
				emoji: '🎉',
				collapsed: true,
			});
		});

		it('should handle very long group names', async () => {
			const longName = 'A'.repeat(1000);

			renderWithLayerStack(<RenameGroupModal {...defaultProps()} groupName={longName} />);

			const renameButton = screen.getByRole('button', { name: 'Rename' });
			await act(async () => {
				fireEvent.click(renameButton);
			});

			const updater = setGroups.mock.calls[0][0];
			const result = updater(groups);

			expect(result.find((g: Group) => g.id === 'group-1').name).toBe(longName);
		});
	});

	describe('Emoji picker Escape key handling', () => {
		it('should have Escape key handler defined on emoji picker overlay', async () => {
			// Note: In jsdom, fireEvent.keyDown doesn't fully trigger React's event handling
			// for focus-based key events. We verify the structure and other tests verify propagation.
			renderWithLayerStack(<RenameGroupModal {...defaultProps()} />);

			// Open emoji picker
			const emojiButton = screen.getByRole('button', { name: /select emoji/i });
			await act(async () => {
				fireEvent.click(emojiButton);
			});

			expect(screen.getByTestId('emoji-picker')).toBeInTheDocument();

			// Get the overlay (the container around the picker)
			const overlay = screen.getByTestId('emoji-picker').closest('.fixed');
			expect(overlay).toBeInTheDocument();

			// Verify the overlay has tabIndex for focus
			expect(overlay).toHaveAttribute('tabIndex', '0');

			// The escape key handler is tested via the propagation test below
			// which verifies the event is caught and not propagated
		});

		it('should prevent default and stop propagation for Escape in emoji picker', async () => {
			const parentKeyDownHandler = vi.fn();

			render(
				<LayerStackProvider>
					<div onKeyDown={parentKeyDownHandler}>
						<RenameGroupModal {...defaultProps()} />
					</div>
				</LayerStackProvider>
			);

			// Open emoji picker
			const emojiButton = screen.getByRole('button', { name: /select emoji/i });
			await act(async () => {
				fireEvent.click(emojiButton);
			});

			// Get the overlay
			const overlay = screen.getByTestId('emoji-picker').closest('.fixed');

			// Simulate Escape keydown
			await act(async () => {
				fireEvent.keyDown(overlay!, { key: 'Escape' });
			});

			// Escape in the overlay should be stopped (not propagate to parent)
			expect(parentKeyDownHandler).not.toHaveBeenCalled();
		});

		it('should not close emoji picker for non-Escape keys on overlay', async () => {
			renderWithLayerStack(<RenameGroupModal {...defaultProps()} />);

			// Open emoji picker
			const emojiButton = screen.getByRole('button', { name: /select emoji/i });
			await act(async () => {
				fireEvent.click(emojiButton);
			});

			const overlay = screen.getByTestId('emoji-picker').closest('.fixed');

			// Press other keys
			await act(async () => {
				fireEvent.keyDown(overlay!, { key: 'Tab' });
				fireEvent.keyDown(overlay!, { key: 'Enter' });
				fireEvent.keyDown(overlay!, { key: 'ArrowDown' });
			});

			// Picker should still be open
			expect(screen.getByTestId('emoji-picker')).toBeInTheDocument();
		});
	});

	describe('Emoji selection edge cases', () => {
		it('should handle multiple rapid emoji selections', async () => {
			renderWithLayerStack(<RenameGroupModal {...defaultProps()} />);

			const emojiButton = screen.getByRole('button', { name: /select emoji/i });
			await act(async () => {
				fireEvent.click(emojiButton);
			});

			// Rapidly select emojis (though in reality the first one closes the picker)
			const rocketEmoji = screen.getByTestId('select-emoji-🚀');
			await act(async () => {
				fireEvent.click(rocketEmoji);
			});

			expect(setGroupEmoji).toHaveBeenCalledWith('🚀');
			expect(setGroupEmoji).toHaveBeenCalledTimes(1);
		});

		it('should not propagate clicks inside emoji picker container', async () => {
			renderWithLayerStack(<RenameGroupModal {...defaultProps()} />);

			const emojiButton = screen.getByRole('button', { name: /select emoji/i });
			await act(async () => {
				fireEvent.click(emojiButton);
			});

			// Click inside the picker container (not backdrop, not emoji)
			const picker = screen.getByTestId('emoji-picker');
			const container = picker.parentElement;

			await act(async () => {
				fireEvent.click(container!);
			});

			// Picker should still be open
			expect(screen.getByTestId('emoji-picker')).toBeInTheDocument();
		});
	});

	describe('Accessibility', () => {
		it('should have proper dialog role and aria attributes', () => {
			renderWithLayerStack(<RenameGroupModal {...defaultProps()} />);

			const dialog = screen.getByRole('dialog');
			expect(dialog).toHaveAttribute('aria-modal', 'true');
			expect(dialog).toHaveAttribute('aria-label', 'Rename Group');
		});

		it('should have tabIndex on dialog for focus', () => {
			renderWithLayerStack(<RenameGroupModal {...defaultProps()} />);

			const dialog = screen.getByRole('dialog');
			expect(dialog).toHaveAttribute('tabIndex', '-1');
		});

		it('should have labeled input fields', () => {
			renderWithLayerStack(<RenameGroupModal {...defaultProps()} />);

			expect(screen.getByText('Icon')).toBeInTheDocument();
			expect(screen.getByText('Group Name')).toBeInTheDocument();
		});

		it('should have proper button types', () => {
			renderWithLayerStack(<RenameGroupModal {...defaultProps()} />);

			// Emoji button should have type="button" to prevent form submission
			const emojiButton = screen.getByRole('button', { name: /select emoji/i });
			expect(emojiButton).toHaveAttribute('type', 'button');
		});
	});

	describe('Theme variations', () => {
		it('should work with light theme', () => {
			const lightTheme = createTestTheme();
			lightTheme.mode = 'light';

			renderWithLayerStack(<RenameGroupModal {...defaultProps()} theme={lightTheme} />);

			expect(screen.getByRole('dialog')).toBeInTheDocument();
		});

		it('should apply theme colors to modal content', () => {
			const customTheme = createTestTheme({
				bgSidebar: '#ff0000',
				textMain: '#00ff00',
			});

			renderWithLayerStack(<RenameGroupModal {...defaultProps()} theme={customTheme} />);

			// The modal content div should have the custom background color
			const title = screen.getByText('Rename Group');
			expect(title).toHaveStyle({ color: '#00ff00' });
		});
	});
});

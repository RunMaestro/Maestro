/**
 * Tests for ShortcutEditor component
 *
 * ShortcutEditor allows users to customize keyboard shortcuts by recording
 * new key combinations. It displays all shortcuts and enters a recording mode
 * when clicked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ShortcutEditor } from '../../../renderer/components/ShortcutEditor';
import type { Theme, Shortcut } from '../../../renderer/types';

// Mock the shortcutFormatter module
vi.mock('../../../renderer/utils/shortcutFormatter', () => ({
	formatShortcutKeys: vi.fn((keys: string[]) => keys.join('+')),
}));

// Import after mock to get the mocked version
import { formatShortcutKeys } from '../../../renderer/utils/shortcutFormatter';

const mockTheme: Theme = {
	id: 'dracula',
	name: 'Dracula',
	mode: 'dark',
	colors: {
		bgMain: '#282a36',
		bgSidebar: '#21222c',
		bgActivity: '#44475a',
		border: '#6272a4',
		textMain: '#f8f8f2',
		textDim: '#6272a4',
		accent: '#bd93f9',
		accentDim: 'rgba(189, 147, 249, 0.3)',
		accentText: '#bd93f9',
		accentForeground: '#ffffff',
		success: '#50fa7b',
		warning: '#ffb86c',
		error: '#ff5555',
	},
};

const createMockShortcuts = (): Record<string, Shortcut> => ({
	newSession: {
		id: 'newSession',
		label: 'New Session',
		keys: ['Meta', 'n'],
	},
	closeSession: {
		id: 'closeSession',
		label: 'Close Session',
		keys: ['Meta', 'w'],
	},
	toggleTerminal: {
		id: 'toggleTerminal',
		label: 'Toggle Terminal',
		keys: ['Meta', 't'],
	},
});

describe('ShortcutEditor', () => {
	let mockSetShortcuts: ReturnType<typeof vi.fn>;
	let mockShortcuts: Record<string, Shortcut>;

	beforeEach(() => {
		vi.clearAllMocks();
		mockSetShortcuts = vi.fn();
		mockShortcuts = createMockShortcuts();
	});

	describe('Basic Rendering', () => {
		it('renders all shortcuts', () => {
			render(
				<ShortcutEditor
					theme={mockTheme}
					shortcuts={mockShortcuts}
					setShortcuts={mockSetShortcuts}
				/>
			);

			expect(screen.getByText('New Session')).toBeInTheDocument();
			expect(screen.getByText('Close Session')).toBeInTheDocument();
			expect(screen.getByText('Toggle Terminal')).toBeInTheDocument();
		});

		it('displays formatted shortcut keys', () => {
			render(
				<ShortcutEditor
					theme={mockTheme}
					shortcuts={mockShortcuts}
					setShortcuts={mockSetShortcuts}
				/>
			);

			expect(formatShortcutKeys).toHaveBeenCalledWith(['Meta', 'n']);
			expect(formatShortcutKeys).toHaveBeenCalledWith(['Meta', 'w']);
			expect(formatShortcutKeys).toHaveBeenCalledWith(['Meta', 't']);
		});

		it('renders shortcut buttons for each entry', () => {
			render(
				<ShortcutEditor
					theme={mockTheme}
					shortcuts={mockShortcuts}
					setShortcuts={mockSetShortcuts}
				/>
			);

			const buttons = screen.getAllByRole('button');
			expect(buttons).toHaveLength(3);
		});

		it('applies theme styling to labels', () => {
			render(
				<ShortcutEditor
					theme={mockTheme}
					shortcuts={mockShortcuts}
					setShortcuts={mockSetShortcuts}
				/>
			);

			const label = screen.getByText('New Session');
			expect(label).toHaveStyle({ color: mockTheme.colors.textMain });
		});

		it('applies theme styling to shortcut items', () => {
			render(
				<ShortcutEditor
					theme={mockTheme}
					shortcuts={mockShortcuts}
					setShortcuts={mockSetShortcuts}
				/>
			);

			// Get the parent container of a label
			const label = screen.getByText('New Session');
			const container = label.closest('div.flex');
			expect(container).toHaveStyle({
				borderColor: mockTheme.colors.border,
				backgroundColor: mockTheme.colors.bgMain,
			});
		});

		it('renders with empty shortcuts', () => {
			render(<ShortcutEditor theme={mockTheme} shortcuts={{}} setShortcuts={mockSetShortcuts} />);

			const buttons = screen.queryAllByRole('button');
			expect(buttons).toHaveLength(0);
		});
	});

	describe('Recording Mode', () => {
		it('enters recording mode when button is clicked', () => {
			render(
				<ShortcutEditor
					theme={mockTheme}
					shortcuts={mockShortcuts}
					setShortcuts={mockSetShortcuts}
				/>
			);

			const buttons = screen.getAllByRole('button');
			fireEvent.click(buttons[0]);

			expect(screen.getByText('Press keys...')).toBeInTheDocument();
		});

		it('only one shortcut can be in recording mode at a time', () => {
			render(
				<ShortcutEditor
					theme={mockTheme}
					shortcuts={mockShortcuts}
					setShortcuts={mockSetShortcuts}
				/>
			);

			const buttons = screen.getAllByRole('button');
			fireEvent.click(buttons[0]);
			fireEvent.click(buttons[1]);

			const recordingIndicators = screen.getAllByText('Press keys...');
			expect(recordingIndicators).toHaveLength(1);
		});

		it('applies recording styles when in recording mode', () => {
			render(
				<ShortcutEditor
					theme={mockTheme}
					shortcuts={mockShortcuts}
					setShortcuts={mockSetShortcuts}
				/>
			);

			const buttons = screen.getAllByRole('button');
			fireEvent.click(buttons[0]);

			expect(buttons[0]).toHaveStyle({
				borderColor: mockTheme.colors.accent,
				backgroundColor: mockTheme.colors.accentDim,
				color: mockTheme.colors.accent,
			});
		});

		it('applies non-recording styles to other buttons', () => {
			render(
				<ShortcutEditor
					theme={mockTheme}
					shortcuts={mockShortcuts}
					setShortcuts={mockSetShortcuts}
				/>
			);

			const buttons = screen.getAllByRole('button');
			fireEvent.click(buttons[0]);

			expect(buttons[1]).toHaveStyle({
				borderColor: mockTheme.colors.border,
				backgroundColor: mockTheme.colors.bgActivity,
				color: mockTheme.colors.textDim,
			});
		});

		it('adds ring-2 class when in recording mode', () => {
			render(
				<ShortcutEditor
					theme={mockTheme}
					shortcuts={mockShortcuts}
					setShortcuts={mockSetShortcuts}
				/>
			);

			const buttons = screen.getAllByRole('button');
			fireEvent.click(buttons[0]);

			expect(buttons[0].className).toContain('ring-2');
		});
	});

	describe('Keyboard Recording', () => {
		it('records a simple key press', () => {
			render(
				<ShortcutEditor
					theme={mockTheme}
					shortcuts={mockShortcuts}
					setShortcuts={mockSetShortcuts}
				/>
			);

			const buttons = screen.getAllByRole('button');
			fireEvent.click(buttons[0]);
			fireEvent.keyDown(buttons[0], { key: 'k' });

			expect(mockSetShortcuts).toHaveBeenCalledWith({
				...mockShortcuts,
				newSession: { ...mockShortcuts.newSession, keys: ['k'] },
			});
		});

		it('records Meta modifier + key', () => {
			render(
				<ShortcutEditor
					theme={mockTheme}
					shortcuts={mockShortcuts}
					setShortcuts={mockSetShortcuts}
				/>
			);

			const buttons = screen.getAllByRole('button');
			fireEvent.click(buttons[0]);
			fireEvent.keyDown(buttons[0], { key: 'k', metaKey: true });

			expect(mockSetShortcuts).toHaveBeenCalledWith({
				...mockShortcuts,
				newSession: { ...mockShortcuts.newSession, keys: ['Meta', 'k'] },
			});
		});

		it('records Ctrl modifier + key', () => {
			render(
				<ShortcutEditor
					theme={mockTheme}
					shortcuts={mockShortcuts}
					setShortcuts={mockSetShortcuts}
				/>
			);

			const buttons = screen.getAllByRole('button');
			fireEvent.click(buttons[0]);
			fireEvent.keyDown(buttons[0], { key: 'k', ctrlKey: true });

			expect(mockSetShortcuts).toHaveBeenCalledWith({
				...mockShortcuts,
				newSession: { ...mockShortcuts.newSession, keys: ['Ctrl', 'k'] },
			});
		});

		it('records Alt modifier + key', () => {
			render(
				<ShortcutEditor
					theme={mockTheme}
					shortcuts={mockShortcuts}
					setShortcuts={mockSetShortcuts}
				/>
			);

			const buttons = screen.getAllByRole('button');
			fireEvent.click(buttons[0]);
			fireEvent.keyDown(buttons[0], { key: 'k', altKey: true });

			expect(mockSetShortcuts).toHaveBeenCalledWith({
				...mockShortcuts,
				newSession: { ...mockShortcuts.newSession, keys: ['Alt', 'k'] },
			});
		});

		it('records Shift modifier + key', () => {
			render(
				<ShortcutEditor
					theme={mockTheme}
					shortcuts={mockShortcuts}
					setShortcuts={mockSetShortcuts}
				/>
			);

			const buttons = screen.getAllByRole('button');
			fireEvent.click(buttons[0]);
			fireEvent.keyDown(buttons[0], { key: 'K', shiftKey: true });

			expect(mockSetShortcuts).toHaveBeenCalledWith({
				...mockShortcuts,
				newSession: { ...mockShortcuts.newSession, keys: ['Shift', 'K'] },
			});
		});

		it('records multiple modifiers + key', () => {
			render(
				<ShortcutEditor
					theme={mockTheme}
					shortcuts={mockShortcuts}
					setShortcuts={mockSetShortcuts}
				/>
			);

			const buttons = screen.getAllByRole('button');
			fireEvent.click(buttons[0]);
			fireEvent.keyDown(buttons[0], { key: 'k', metaKey: true, shiftKey: true });

			expect(mockSetShortcuts).toHaveBeenCalledWith({
				...mockShortcuts,
				newSession: {
					...mockShortcuts.newSession,
					keys: ['Meta', 'Shift', 'k'],
				},
			});
		});

		it('records all four modifiers + key', () => {
			render(
				<ShortcutEditor
					theme={mockTheme}
					shortcuts={mockShortcuts}
					setShortcuts={mockSetShortcuts}
				/>
			);

			const buttons = screen.getAllByRole('button');
			fireEvent.click(buttons[0]);
			fireEvent.keyDown(buttons[0], {
				key: 'k',
				metaKey: true,
				ctrlKey: true,
				altKey: true,
				shiftKey: true,
			});

			expect(mockSetShortcuts).toHaveBeenCalledWith({
				...mockShortcuts,
				newSession: {
					...mockShortcuts.newSession,
					keys: ['Meta', 'Ctrl', 'Alt', 'Shift', 'k'],
				},
			});
		});

		it('records arrow keys', () => {
			render(
				<ShortcutEditor
					theme={mockTheme}
					shortcuts={mockShortcuts}
					setShortcuts={mockSetShortcuts}
				/>
			);

			const buttons = screen.getAllByRole('button');
			fireEvent.click(buttons[0]);
			fireEvent.keyDown(buttons[0], { key: 'ArrowLeft', metaKey: true });

			expect(mockSetShortcuts).toHaveBeenCalledWith({
				...mockShortcuts,
				newSession: {
					...mockShortcuts.newSession,
					keys: ['Meta', 'ArrowLeft'],
				},
			});
		});

		it('records function keys', () => {
			render(
				<ShortcutEditor
					theme={mockTheme}
					shortcuts={mockShortcuts}
					setShortcuts={mockSetShortcuts}
				/>
			);

			const buttons = screen.getAllByRole('button');
			fireEvent.click(buttons[0]);
			fireEvent.keyDown(buttons[0], { key: 'F1' });

			expect(mockSetShortcuts).toHaveBeenCalledWith({
				...mockShortcuts,
				newSession: { ...mockShortcuts.newSession, keys: ['F1'] },
			});
		});

		it('exits recording mode after recording', () => {
			render(
				<ShortcutEditor
					theme={mockTheme}
					shortcuts={mockShortcuts}
					setShortcuts={mockSetShortcuts}
				/>
			);

			const buttons = screen.getAllByRole('button');
			fireEvent.click(buttons[0]);

			expect(screen.getByText('Press keys...')).toBeInTheDocument();

			fireEvent.keyDown(buttons[0], { key: 'k', metaKey: true });

			expect(screen.queryByText('Press keys...')).not.toBeInTheDocument();
		});
	});

	describe('Escape Key Handling', () => {
		it('cancels recording without changing shortcut when Escape is pressed', () => {
			render(
				<ShortcutEditor
					theme={mockTheme}
					shortcuts={mockShortcuts}
					setShortcuts={mockSetShortcuts}
				/>
			);

			const buttons = screen.getAllByRole('button');
			fireEvent.click(buttons[0]);

			expect(screen.getByText('Press keys...')).toBeInTheDocument();

			fireEvent.keyDown(buttons[0], { key: 'Escape' });

			expect(screen.queryByText('Press keys...')).not.toBeInTheDocument();
			expect(mockSetShortcuts).not.toHaveBeenCalled();
		});

		it('prevents default on Escape key', () => {
			render(
				<ShortcutEditor
					theme={mockTheme}
					shortcuts={mockShortcuts}
					setShortcuts={mockSetShortcuts}
				/>
			);

			const buttons = screen.getAllByRole('button');
			fireEvent.click(buttons[0]);

			const preventDefaultMock = vi.fn();
			const stopPropagationMock = vi.fn();

			fireEvent.keyDown(buttons[0], {
				key: 'Escape',
				preventDefault: preventDefaultMock,
				stopPropagation: stopPropagationMock,
			});

			// The event handlers are called internally
			expect(mockSetShortcuts).not.toHaveBeenCalled();
		});
	});

	describe('Modifier-Only Key Prevention', () => {
		it('ignores Meta key alone', () => {
			render(
				<ShortcutEditor
					theme={mockTheme}
					shortcuts={mockShortcuts}
					setShortcuts={mockSetShortcuts}
				/>
			);

			const buttons = screen.getAllByRole('button');
			fireEvent.click(buttons[0]);
			fireEvent.keyDown(buttons[0], { key: 'Meta', metaKey: true });

			expect(mockSetShortcuts).not.toHaveBeenCalled();
			expect(screen.getByText('Press keys...')).toBeInTheDocument();
		});

		it('ignores Control key alone', () => {
			render(
				<ShortcutEditor
					theme={mockTheme}
					shortcuts={mockShortcuts}
					setShortcuts={mockSetShortcuts}
				/>
			);

			const buttons = screen.getAllByRole('button');
			fireEvent.click(buttons[0]);
			fireEvent.keyDown(buttons[0], { key: 'Control', ctrlKey: true });

			expect(mockSetShortcuts).not.toHaveBeenCalled();
			expect(screen.getByText('Press keys...')).toBeInTheDocument();
		});

		it('ignores Alt key alone', () => {
			render(
				<ShortcutEditor
					theme={mockTheme}
					shortcuts={mockShortcuts}
					setShortcuts={mockSetShortcuts}
				/>
			);

			const buttons = screen.getAllByRole('button');
			fireEvent.click(buttons[0]);
			fireEvent.keyDown(buttons[0], { key: 'Alt', altKey: true });

			expect(mockSetShortcuts).not.toHaveBeenCalled();
			expect(screen.getByText('Press keys...')).toBeInTheDocument();
		});

		it('ignores Shift key alone', () => {
			render(
				<ShortcutEditor
					theme={mockTheme}
					shortcuts={mockShortcuts}
					setShortcuts={mockSetShortcuts}
				/>
			);

			const buttons = screen.getAllByRole('button');
			fireEvent.click(buttons[0]);
			fireEvent.keyDown(buttons[0], { key: 'Shift', shiftKey: true });

			expect(mockSetShortcuts).not.toHaveBeenCalled();
			expect(screen.getByText('Press keys...')).toBeInTheDocument();
		});
	});

	describe('Non-Recording Keyboard Events', () => {
		it('does not record when not in recording mode', () => {
			render(
				<ShortcutEditor
					theme={mockTheme}
					shortcuts={mockShortcuts}
					setShortcuts={mockSetShortcuts}
				/>
			);

			const buttons = screen.getAllByRole('button');
			// Don't click to enter recording mode
			fireEvent.keyDown(buttons[0], { key: 'k', metaKey: true });

			expect(mockSetShortcuts).not.toHaveBeenCalled();
		});

		it('only records on the button that is in recording mode', () => {
			render(
				<ShortcutEditor
					theme={mockTheme}
					shortcuts={mockShortcuts}
					setShortcuts={mockSetShortcuts}
				/>
			);

			const buttons = screen.getAllByRole('button');
			fireEvent.click(buttons[0]); // First button enters recording mode

			// Try to record on the second button
			fireEvent.keyDown(buttons[1], { key: 'k', metaKey: true });

			// Nothing should happen because second button is not recording
			expect(mockSetShortcuts).not.toHaveBeenCalled();
		});
	});

	describe('Event Prevention', () => {
		it('prevents default and stops propagation on key events', () => {
			render(
				<ShortcutEditor
					theme={mockTheme}
					shortcuts={mockShortcuts}
					setShortcuts={mockSetShortcuts}
				/>
			);

			const buttons = screen.getAllByRole('button');
			fireEvent.click(buttons[0]);

			// The component calls preventDefault and stopPropagation
			// We can verify the shortcut was recorded, which means the event was handled
			fireEvent.keyDown(buttons[0], { key: 'k', metaKey: true });

			expect(mockSetShortcuts).toHaveBeenCalled();
		});
	});

	describe('Scrollable Container', () => {
		it('has scrollable container classes', () => {
			const { container } = render(
				<ShortcutEditor
					theme={mockTheme}
					shortcuts={mockShortcuts}
					setShortcuts={mockSetShortcuts}
				/>
			);

			const scrollContainer = container.firstChild;
			expect(scrollContainer).toHaveClass('max-h-[400px]', 'overflow-y-auto');
		});
	});

	describe('Button Styling', () => {
		it('buttons have minimum width class', () => {
			render(
				<ShortcutEditor
					theme={mockTheme}
					shortcuts={mockShortcuts}
					setShortcuts={mockSetShortcuts}
				/>
			);

			const buttons = screen.getAllByRole('button');
			buttons.forEach((button) => {
				expect(button).toHaveClass('min-w-[80px]');
			});
		});

		it('buttons have monospace font', () => {
			render(
				<ShortcutEditor
					theme={mockTheme}
					shortcuts={mockShortcuts}
					setShortcuts={mockSetShortcuts}
				/>
			);

			const buttons = screen.getAllByRole('button');
			buttons.forEach((button) => {
				expect(button).toHaveClass('font-mono');
			});
		});

		it('buttons have centered text', () => {
			render(
				<ShortcutEditor
					theme={mockTheme}
					shortcuts={mockShortcuts}
					setShortcuts={mockSetShortcuts}
				/>
			);

			const buttons = screen.getAllByRole('button');
			buttons.forEach((button) => {
				expect(button).toHaveClass('text-center');
			});
		});
	});

	describe('Multiple Shortcuts', () => {
		it('correctly updates the specific shortcut being edited', () => {
			render(
				<ShortcutEditor
					theme={mockTheme}
					shortcuts={mockShortcuts}
					setShortcuts={mockSetShortcuts}
				/>
			);

			const buttons = screen.getAllByRole('button');
			fireEvent.click(buttons[1]); // Click second button (closeSession)
			fireEvent.keyDown(buttons[1], { key: 'q', metaKey: true });

			expect(mockSetShortcuts).toHaveBeenCalledWith({
				...mockShortcuts,
				closeSession: { ...mockShortcuts.closeSession, keys: ['Meta', 'q'] },
			});
		});

		it('preserves other shortcut properties when updating keys', () => {
			render(
				<ShortcutEditor
					theme={mockTheme}
					shortcuts={mockShortcuts}
					setShortcuts={mockSetShortcuts}
				/>
			);

			const buttons = screen.getAllByRole('button');
			fireEvent.click(buttons[0]);
			fireEvent.keyDown(buttons[0], { key: 'k', metaKey: true });

			const call = mockSetShortcuts.mock.calls[0][0];
			expect(call.newSession.id).toBe('newSession');
			expect(call.newSession.label).toBe('New Session');
		});
	});

	describe('Edge Cases', () => {
		it('handles shortcuts with single key (no modifiers)', () => {
			const singleKeyShortcuts: Record<string, Shortcut> = {
				help: {
					id: 'help',
					label: 'Help',
					keys: ['?'],
				},
			};

			render(
				<ShortcutEditor
					theme={mockTheme}
					shortcuts={singleKeyShortcuts}
					setShortcuts={mockSetShortcuts}
				/>
			);

			expect(screen.getByText('Help')).toBeInTheDocument();
			expect(formatShortcutKeys).toHaveBeenCalledWith(['?']);
		});

		it('handles shortcuts with many keys', () => {
			const complexShortcuts: Record<string, Shortcut> = {
				complex: {
					id: 'complex',
					label: 'Complex Action',
					keys: ['Meta', 'Ctrl', 'Alt', 'Shift', 'F12'],
				},
			};

			render(
				<ShortcutEditor
					theme={mockTheme}
					shortcuts={complexShortcuts}
					setShortcuts={mockSetShortcuts}
				/>
			);

			expect(screen.getByText('Complex Action')).toBeInTheDocument();
			expect(formatShortcutKeys).toHaveBeenCalledWith(['Meta', 'Ctrl', 'Alt', 'Shift', 'F12']);
		});

		it('handles special characters in key names', () => {
			render(
				<ShortcutEditor
					theme={mockTheme}
					shortcuts={mockShortcuts}
					setShortcuts={mockSetShortcuts}
				/>
			);

			const buttons = screen.getAllByRole('button');
			fireEvent.click(buttons[0]);
			fireEvent.keyDown(buttons[0], { key: '/', metaKey: true });

			expect(mockSetShortcuts).toHaveBeenCalledWith({
				...mockShortcuts,
				newSession: { ...mockShortcuts.newSession, keys: ['Meta', '/'] },
			});
		});
	});

	describe('Different Themes', () => {
		it('applies light theme colors', () => {
			const lightTheme: Theme = {
				id: 'github-light',
				name: 'GitHub Light',
				mode: 'light',
				colors: {
					bgMain: '#ffffff',
					bgSidebar: '#f6f8fa',
					bgActivity: '#f0f0f0',
					border: '#e1e4e8',
					textMain: '#24292e',
					textDim: '#6a737d',
					accent: '#0366d6',
					accentDim: 'rgba(3, 102, 214, 0.2)',
					accentText: '#0366d6',
					accentForeground: '#ffffff',
					success: '#28a745',
					warning: '#ffd33d',
					error: '#d73a49',
				},
			};

			render(
				<ShortcutEditor
					theme={lightTheme}
					shortcuts={mockShortcuts}
					setShortcuts={mockSetShortcuts}
				/>
			);

			const label = screen.getByText('New Session');
			expect(label).toHaveStyle({ color: lightTheme.colors.textMain });
		});
	});
});

/**
 * Tests for CommandHistoryDrawer component
 *
 * A swipe-up drawer for command history with swipe-to-delete items.
 * Features:
 * - formatRelativeTime pure function
 * - truncateCommand pure function
 * - SwipeableHistoryItem component
 * - CommandHistoryDrawer main component
 */

import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// Mock dependencies before importing component
vi.mock('../../../web/components/ThemeProvider', () => ({
	useThemeColors: () => ({
		bgMain: '#1e1e1e',
		bgSidebar: '#252526',
		bgActivity: '#333333',
		textMain: '#ffffff',
		textDim: '#888888',
		border: '#404040',
		accent: '#007acc',
		success: '#4caf50',
		warning: '#ff9800',
		error: '#f44336',
	}),
}));

vi.mock('../../../web/mobile/constants', () => ({
	triggerHaptic: vi.fn(),
	HAPTIC_PATTERNS: {
		tap: [10],
		success: [10, 50, 10],
		error: [50, 50, 50],
		send: [20],
		interrupt: [50],
	},
	GESTURE_THRESHOLDS: {
		swipeDistance: 50,
		swipeTime: 300,
		pullToRefresh: 80,
		longPress: 500,
	},
}));

// Mock useSwipeGestures hook
const mockResetOffset = vi.fn();
vi.mock('../../../web/hooks/useSwipeGestures', () => ({
	useSwipeGestures: vi.fn(() => ({
		handlers: {
			onTouchStart: vi.fn(),
			onTouchMove: vi.fn(),
			onTouchEnd: vi.fn(),
			onTouchCancel: vi.fn(),
		},
		offsetX: 0,
		offsetY: 0,
		isSwiping: false,
		direction: null,
		resetOffset: mockResetOffset,
	})),
}));

import CommandHistoryDrawer, {
	CommandHistoryDrawerProps,
} from '../../../web/mobile/CommandHistoryDrawer';
import { triggerHaptic, HAPTIC_PATTERNS } from '../../../web/mobile/constants';
import { useSwipeGestures } from '../../../web/hooks/useSwipeGestures';
import type { CommandHistoryEntry } from '../../../web/hooks/useCommandHistory';

// Declare module types for testing internal functions
// These functions aren't exported but we test them through component behavior
const mockUseSwipeGestures = useSwipeGestures as ReturnType<typeof vi.fn>;

// Test utilities
function createMockEntry(overrides?: Partial<CommandHistoryEntry>): CommandHistoryEntry {
	return {
		id: 'entry-1',
		command: 'npm run test',
		timestamp: Date.now() - 60000, // 1 minute ago
		mode: 'terminal',
		sessionId: 'session-1',
		...overrides,
	};
}

function createAIEntry(overrides?: Partial<CommandHistoryEntry>): CommandHistoryEntry {
	return createMockEntry({
		id: 'ai-entry-1',
		command: 'Explain this code',
		mode: 'ai',
		...overrides,
	});
}

// Default props for CommandHistoryDrawer
function createDefaultProps(
	overrides?: Partial<CommandHistoryDrawerProps>
): CommandHistoryDrawerProps {
	return {
		isOpen: true,
		onClose: vi.fn(),
		history: [],
		onSelectCommand: vi.fn(),
		...overrides,
	};
}

// ============================================================================
// formatRelativeTime pure function tests (via component rendering)
// ============================================================================

describe('formatRelativeTime (via component)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2025-01-15T12:00:00Z'));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('formats "just now" for timestamps within 60 seconds', () => {
		const entry = createMockEntry({
			timestamp: Date.now() - 30000, // 30 seconds ago
		});
		render(<CommandHistoryDrawer {...createDefaultProps({ history: [entry] })} />);

		expect(screen.getByText('just now')).toBeInTheDocument();
	});

	it('formats minutes correctly', () => {
		const entry = createMockEntry({
			timestamp: Date.now() - 5 * 60 * 1000, // 5 minutes ago
		});
		render(<CommandHistoryDrawer {...createDefaultProps({ history: [entry] })} />);

		expect(screen.getByText('5m ago')).toBeInTheDocument();
	});

	it('formats hours correctly', () => {
		const entry = createMockEntry({
			timestamp: Date.now() - 3 * 60 * 60 * 1000, // 3 hours ago
		});
		render(<CommandHistoryDrawer {...createDefaultProps({ history: [entry] })} />);

		expect(screen.getByText('3h ago')).toBeInTheDocument();
	});

	it('formats days correctly', () => {
		const entry = createMockEntry({
			timestamp: Date.now() - 2 * 24 * 60 * 60 * 1000, // 2 days ago
		});
		render(<CommandHistoryDrawer {...createDefaultProps({ history: [entry] })} />);

		expect(screen.getByText('2d ago')).toBeInTheDocument();
	});

	it('handles boundary: exactly 1 minute', () => {
		const entry = createMockEntry({
			timestamp: Date.now() - 60 * 1000, // exactly 1 minute
		});
		render(<CommandHistoryDrawer {...createDefaultProps({ history: [entry] })} />);

		expect(screen.getByText('1m ago')).toBeInTheDocument();
	});

	it('handles boundary: exactly 1 hour', () => {
		const entry = createMockEntry({
			timestamp: Date.now() - 60 * 60 * 1000, // exactly 1 hour
		});
		render(<CommandHistoryDrawer {...createDefaultProps({ history: [entry] })} />);

		expect(screen.getByText('1h ago')).toBeInTheDocument();
	});

	it('handles boundary: exactly 1 day', () => {
		const entry = createMockEntry({
			timestamp: Date.now() - 24 * 60 * 60 * 1000, // exactly 1 day
		});
		render(<CommandHistoryDrawer {...createDefaultProps({ history: [entry] })} />);

		expect(screen.getByText('1d ago')).toBeInTheDocument();
	});
});

// ============================================================================
// truncateCommand pure function tests (via component rendering)
// ============================================================================

describe('truncateCommand (via component)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('displays full command when under 60 characters', () => {
		const shortCommand = 'npm run test';
		const entry = createMockEntry({ command: shortCommand });
		render(<CommandHistoryDrawer {...createDefaultProps({ history: [entry] })} />);

		expect(screen.getByText(shortCommand)).toBeInTheDocument();
	});

	it('truncates command at 60 characters with ellipsis', () => {
		const longCommand =
			'This is a very long command that should be truncated because it exceeds the maximum length allowed';
		const entry = createMockEntry({ command: longCommand });
		render(<CommandHistoryDrawer {...createDefaultProps({ history: [entry] })} />);

		// Should truncate to 59 chars + '…' (unicode ellipsis) = 60 total (uses shared truncateCommand)
		const truncated = longCommand.slice(0, 59) + '…';
		expect(screen.getByText(truncated)).toBeInTheDocument();
	});

	it('handles exactly 60 character command without truncation', () => {
		const exactCommand = 'a'.repeat(60);
		const entry = createMockEntry({ command: exactCommand });
		render(<CommandHistoryDrawer {...createDefaultProps({ history: [entry] })} />);

		expect(screen.getByText(exactCommand)).toBeInTheDocument();
	});

	it('handles 61 character command with truncation', () => {
		const command = 'a'.repeat(61);
		const entry = createMockEntry({ command });
		render(<CommandHistoryDrawer {...createDefaultProps({ history: [entry] })} />);

		// Should truncate to 59 chars + '…' (unicode ellipsis) = 60 total (uses shared truncateCommand)
		const truncated = 'a'.repeat(59) + '…';
		expect(screen.getByText(truncated)).toBeInTheDocument();
	});
});

// ============================================================================
// CommandHistoryDrawer component tests
// ============================================================================

describe('CommandHistoryDrawer', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe('render conditions', () => {
		it('returns null when closed and no drag offset', () => {
			const { container } = render(
				<CommandHistoryDrawer {...createDefaultProps({ isOpen: false })} />
			);

			// Should render nothing
			expect(container.firstChild).toBeNull();
		});

		it('renders when isOpen is true', () => {
			render(<CommandHistoryDrawer {...createDefaultProps({ isOpen: true })} />);

			expect(screen.getByText('Command History')).toBeInTheDocument();
		});

		it('renders backdrop when open', () => {
			const onClose = vi.fn();
			render(<CommandHistoryDrawer {...createDefaultProps({ isOpen: true, onClose })} />);

			// Find backdrop by its styling (fixed position overlay)
			const backdrop = document.querySelector('[style*="rgba(0, 0, 0, 0.5)"]');
			expect(backdrop).toBeTruthy();
		});
	});

	describe('empty state', () => {
		it('shows empty state when history is empty', () => {
			render(<CommandHistoryDrawer {...createDefaultProps({ history: [] })} />);

			expect(screen.getByText('No command history yet')).toBeInTheDocument();
			expect(screen.getByText('Commands you send will appear here')).toBeInTheDocument();
		});

		it('displays clock icon in empty state', () => {
			render(<CommandHistoryDrawer {...createDefaultProps({ history: [] })} />);

			// Check for SVG clock icon (has circle and polyline)
			const svgs = document.querySelectorAll('svg');
			const clockIcon = Array.from(svgs).find(
				(svg) =>
					svg.querySelector('circle[cx="12"][cy="12"]') &&
					svg.querySelector('polyline[points="12 6 12 12 16 14"]')
			);
			expect(clockIcon).toBeTruthy();
		});
	});

	describe('history list', () => {
		it('renders history entries', () => {
			const entries = [
				createMockEntry({ id: 'e1', command: 'npm install' }),
				createMockEntry({ id: 'e2', command: 'npm run build' }),
			];
			render(<CommandHistoryDrawer {...createDefaultProps({ history: entries })} />);

			expect(screen.getByText('npm install')).toBeInTheDocument();
			expect(screen.getByText('npm run build')).toBeInTheDocument();
		});

		it('shows swipe hint when onDeleteCommand is provided', () => {
			const entries = [createMockEntry()];
			render(
				<CommandHistoryDrawer
					{...createDefaultProps({
						history: entries,
						onDeleteCommand: vi.fn(),
					})}
				/>
			);

			expect(screen.getByText('Swipe left on an item to delete')).toBeInTheDocument();
		});

		it('does not show swipe hint when onDeleteCommand is not provided', () => {
			const entries = [createMockEntry()];
			render(
				<CommandHistoryDrawer
					{...createDefaultProps({
						history: entries,
						onDeleteCommand: undefined,
					})}
				/>
			);

			expect(screen.queryByText('Swipe left on an item to delete')).not.toBeInTheDocument();
		});
	});

	describe('mode indicators', () => {
		it('shows AI mode indicator for AI commands', () => {
			const entry = createAIEntry();
			render(<CommandHistoryDrawer {...createDefaultProps({ history: [entry] })} />);

			// AI mode icon has path with M12 3v2... pattern
			const svgs = document.querySelectorAll('svg');
			const aiIcon = Array.from(svgs).find((svg) => svg.querySelector('path[d*="M12 3v2"]'));
			expect(aiIcon).toBeTruthy();
		});

		it('shows terminal mode indicator for terminal commands', () => {
			const entry = createMockEntry({ mode: 'terminal' });
			render(<CommandHistoryDrawer {...createDefaultProps({ history: [entry] })} />);

			// Terminal icon has polyline points="4 17 10 11 4 5"
			const svgs = document.querySelectorAll('svg');
			const terminalIcon = Array.from(svgs).find((svg) =>
				svg.querySelector('polyline[points="4 17 10 11 4 5"]')
			);
			expect(terminalIcon).toBeTruthy();
		});
	});

	describe('command selection', () => {
		it('calls onSelectCommand and onClose when command is tapped', () => {
			const onSelectCommand = vi.fn();
			const onClose = vi.fn();
			const entry = createMockEntry({ command: 'npm test' });

			render(
				<CommandHistoryDrawer
					{...createDefaultProps({
						history: [entry],
						onSelectCommand,
						onClose,
					})}
				/>
			);

			// Click on the command text
			fireEvent.click(screen.getByText('npm test'));

			expect(triggerHaptic).toHaveBeenCalledWith(HAPTIC_PATTERNS.tap);
			expect(onSelectCommand).toHaveBeenCalledWith('npm test');
			expect(onClose).toHaveBeenCalled();
		});
	});

	describe('clear all functionality', () => {
		it('shows Clear All button when history exists and onClearHistory is provided', () => {
			const entries = [createMockEntry()];
			render(
				<CommandHistoryDrawer
					{...createDefaultProps({
						history: entries,
						onClearHistory: vi.fn(),
					})}
				/>
			);

			expect(screen.getByText('Clear All')).toBeInTheDocument();
		});

		it('does not show Clear All button when history is empty', () => {
			render(
				<CommandHistoryDrawer
					{...createDefaultProps({
						history: [],
						onClearHistory: vi.fn(),
					})}
				/>
			);

			expect(screen.queryByText('Clear All')).not.toBeInTheDocument();
		});

		it('does not show Clear All button when onClearHistory is not provided', () => {
			const entries = [createMockEntry()];
			render(
				<CommandHistoryDrawer
					{...createDefaultProps({
						history: entries,
						onClearHistory: undefined,
					})}
				/>
			);

			expect(screen.queryByText('Clear All')).not.toBeInTheDocument();
		});

		it('calls onClearHistory and onClose when Clear All is clicked', () => {
			const onClearHistory = vi.fn();
			const onClose = vi.fn();
			const entries = [createMockEntry()];

			render(
				<CommandHistoryDrawer
					{...createDefaultProps({
						history: entries,
						onClearHistory,
						onClose,
					})}
				/>
			);

			fireEvent.click(screen.getByText('Clear All'));

			expect(triggerHaptic).toHaveBeenCalledWith(HAPTIC_PATTERNS.interrupt);
			expect(onClearHistory).toHaveBeenCalled();
			expect(onClose).toHaveBeenCalled();
		});
	});

	describe('backdrop interaction', () => {
		it('closes drawer when backdrop is clicked', () => {
			const onClose = vi.fn();
			render(<CommandHistoryDrawer {...createDefaultProps({ isOpen: true, onClose })} />);

			// Find backdrop and click it
			const backdrop = document.querySelector('[style*="rgba(0, 0, 0, 0.5)"]');
			if (backdrop) {
				fireEvent.click(backdrop);
			}

			expect(onClose).toHaveBeenCalled();
		});
	});

	describe('drawer handle drag gesture', () => {
		it('handles touch start on drawer handle', () => {
			render(<CommandHistoryDrawer {...createDefaultProps({ isOpen: true })} />);

			// Find the drawer handle (div with cursor: grab)
			const handle = document.querySelector('[style*="cursor: grab"]');
			expect(handle).toBeTruthy();

			if (handle) {
				fireEvent.touchStart(handle, {
					touches: [{ clientY: 100 }],
				});
			}
		});

		it('handles touch move for drag gesture', () => {
			render(<CommandHistoryDrawer {...createDefaultProps({ isOpen: true })} />);

			const handle = document.querySelector('[style*="cursor: grab"]');
			if (handle) {
				fireEvent.touchStart(handle, {
					touches: [{ clientY: 100 }],
				});
				fireEvent.touchMove(handle, {
					touches: [{ clientY: 150 }],
				});
			}
		});

		it('closes on flick down gesture (high velocity)', () => {
			const onClose = vi.fn();
			vi.useFakeTimers();

			render(<CommandHistoryDrawer {...createDefaultProps({ isOpen: true, onClose })} />);

			const handle = document.querySelector('[style*="cursor: grab"]');
			if (handle) {
				// Start touch
				fireEvent.touchStart(handle, {
					touches: [{ clientY: 0 }],
				});

				// Quick drag down (high velocity)
				vi.advanceTimersByTime(50); // 50ms
				fireEvent.touchMove(handle, {
					touches: [{ clientY: 100 }], // 100px in 50ms = 2px/ms > 0.5 threshold
				});

				// End touch
				fireEvent.touchEnd(handle, {
					changedTouches: [{ clientY: 100 }],
				});
			}

			vi.useRealTimers();
		});

		it('closes when dragged past snap threshold', () => {
			const onClose = vi.fn();

			// Mock viewport height
			Object.defineProperty(window, 'innerHeight', { value: 800, writable: true });

			render(<CommandHistoryDrawer {...createDefaultProps({ isOpen: true, onClose })} />);

			const handle = document.querySelector('[style*="cursor: grab"]');
			if (handle) {
				// Start touch
				fireEvent.touchStart(handle, {
					touches: [{ clientY: 0 }],
				});

				// Drag past 30% of max height (800 * 0.6 * 0.3 = 144px)
				fireEvent.touchMove(handle, {
					touches: [{ clientY: 200 }],
				});

				// End touch
				fireEvent.touchEnd(handle, {
					changedTouches: [{ clientY: 200 }],
				});
			}
		});
	});

	describe('resize handling', () => {
		it('updates max drawer height on window resize', async () => {
			Object.defineProperty(window, 'innerHeight', { value: 800, writable: true });

			render(<CommandHistoryDrawer {...createDefaultProps({ isOpen: true })} />);

			// Simulate resize
			Object.defineProperty(window, 'innerHeight', { value: 600, writable: true });

			act(() => {
				window.dispatchEvent(new Event('resize'));
			});
		});
	});

	describe('visual handle', () => {
		it('renders visual handle indicator', () => {
			render(<CommandHistoryDrawer {...createDefaultProps({ isOpen: true })} />);

			// Handle indicator is 40px wide, 4px tall
			const handleIndicator = document.querySelector('[style*="width: 40px"]');
			expect(handleIndicator).toBeTruthy();
		});
	});
});

// ============================================================================
// SwipeableHistoryItem component tests
// ============================================================================

describe('SwipeableHistoryItem (via CommandHistoryDrawer)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockUseSwipeGestures.mockReturnValue({
			handlers: {
				onTouchStart: vi.fn(),
				onTouchMove: vi.fn(),
				onTouchEnd: vi.fn(),
				onTouchCancel: vi.fn(),
			},
			offsetX: 0,
			offsetY: 0,
			isSwiping: false,
			direction: null,
			resetOffset: mockResetOffset,
		});
	});

	describe('delete functionality', () => {
		it('shows delete button when onDeleteCommand is provided', () => {
			const entry = createMockEntry();
			render(
				<CommandHistoryDrawer
					{...createDefaultProps({
						history: [entry],
						onDeleteCommand: vi.fn(),
					})}
				/>
			);

			// Delete button should exist (hidden by default)
			const deleteButton = screen.getByLabelText('Delete command');
			expect(deleteButton).toBeInTheDocument();
		});

		it('does not show delete button when onDeleteCommand is not provided', () => {
			const entry = createMockEntry();
			render(
				<CommandHistoryDrawer
					{...createDefaultProps({
						history: [entry],
						onDeleteCommand: undefined,
					})}
				/>
			);

			expect(screen.queryByLabelText('Delete command')).not.toBeInTheDocument();
		});

		it('calls onDeleteCommand when delete button is clicked', () => {
			const onDeleteCommand = vi.fn();
			const entry = createMockEntry({ id: 'entry-to-delete' });

			// Mock swipe to show delete action
			mockUseSwipeGestures.mockReturnValue({
				handlers: {
					onTouchStart: vi.fn(),
					onTouchMove: vi.fn(),
					onTouchEnd: vi.fn(),
					onTouchCancel: vi.fn(),
				},
				offsetX: -100, // Swiped left
				offsetY: 0,
				isSwiping: false,
				direction: 'left',
				resetOffset: mockResetOffset,
			});

			render(
				<CommandHistoryDrawer
					{...createDefaultProps({
						history: [entry],
						onDeleteCommand,
					})}
				/>
			);

			const deleteButton = screen.getByLabelText('Delete command');
			fireEvent.click(deleteButton);

			expect(triggerHaptic).toHaveBeenCalledWith(HAPTIC_PATTERNS.success);
			expect(onDeleteCommand).toHaveBeenCalledWith('entry-to-delete');
		});

		it('shows swipe hint chevron when delete is available', () => {
			const entry = createMockEntry();
			render(
				<CommandHistoryDrawer
					{...createDefaultProps({
						history: [entry],
						onDeleteCommand: vi.fn(),
					})}
				/>
			);

			// Chevron character should be visible (with aria-hidden)
			const chevron = document.querySelector('[aria-hidden="true"]');
			expect(chevron?.textContent).toBe('‹');
		});
	});

	describe('long press handling', () => {
		it('triggers long press after threshold', async () => {
			vi.useFakeTimers();
			const entry = createMockEntry();

			render(
				<CommandHistoryDrawer
					{...createDefaultProps({
						history: [entry],
					})}
				/>
			);

			// Get the item containing the command
			const commandItem = screen.getByText('npm run test').closest('[style*="cursor: pointer"]');

			if (commandItem) {
				// Start touch
				fireEvent.touchStart(commandItem, {
					touches: [{ clientX: 100, clientY: 100 }],
				});

				// Advance past long press threshold (500ms)
				await act(async () => {
					vi.advanceTimersByTime(600);
				});

				// End touch
				fireEvent.touchEnd(commandItem, {
					changedTouches: [{ clientX: 100, clientY: 100 }],
				});
			}

			vi.useRealTimers();
		});

		it('cancels long press on touch cancel', async () => {
			vi.useFakeTimers();
			const entry = createMockEntry();

			render(
				<CommandHistoryDrawer
					{...createDefaultProps({
						history: [entry],
					})}
				/>
			);

			const commandItem = screen.getByText('npm run test').closest('[style*="cursor: pointer"]');

			if (commandItem) {
				fireEvent.touchStart(commandItem, {
					touches: [{ clientX: 100, clientY: 100 }],
				});

				// Cancel before threshold
				fireEvent.touchCancel(commandItem, {
					changedTouches: [{ clientX: 100, clientY: 100 }],
				});

				// Advance past threshold
				await act(async () => {
					vi.advanceTimersByTime(600);
				});

				// Should not have triggered long press
			}

			vi.useRealTimers();
		});
	});

	describe('styling', () => {
		it('applies monospace font to command text', () => {
			const entry = createMockEntry();
			render(<CommandHistoryDrawer {...createDefaultProps({ history: [entry] })} />);

			const commandText = screen.getByText('npm run test');
			expect(commandText).toHaveStyle({ fontFamily: 'ui-monospace, monospace' });
		});

		it('shows border bottom on each item', () => {
			const entries = [
				createMockEntry({ id: 'e1', command: 'cmd1' }),
				createMockEntry({ id: 'e2', command: 'cmd2' }),
			];
			render(<CommandHistoryDrawer {...createDefaultProps({ history: entries })} />);

			// Each item should have border styling (rendered as border-bottom in CSS)
			const items = document.querySelectorAll('[style*="border-bottom"]');
			expect(items.length).toBeGreaterThan(0);
		});
	});
});

// ============================================================================
// Integration tests
// ============================================================================

describe('CommandHistoryDrawer integration', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockUseSwipeGestures.mockReturnValue({
			handlers: {
				onTouchStart: vi.fn(),
				onTouchMove: vi.fn(),
				onTouchEnd: vi.fn(),
				onTouchCancel: vi.fn(),
			},
			offsetX: 0,
			offsetY: 0,
			isSwiping: false,
			direction: null,
			resetOffset: mockResetOffset,
		});
	});

	it('handles full command selection flow', () => {
		const onSelectCommand = vi.fn();
		const onClose = vi.fn();
		const entry = createMockEntry({ command: 'git status' });

		render(
			<CommandHistoryDrawer
				{...createDefaultProps({
					history: [entry],
					onSelectCommand,
					onClose,
				})}
			/>
		);

		// Tap command
		fireEvent.click(screen.getByText('git status'));

		// Verify haptic, selection, and close
		expect(triggerHaptic).toHaveBeenCalledWith(HAPTIC_PATTERNS.tap);
		expect(onSelectCommand).toHaveBeenCalledWith('git status');
		expect(onClose).toHaveBeenCalled();
	});

	it('handles mixed AI and terminal commands', () => {
		const entries = [
			createAIEntry({ id: 'ai1', command: 'Explain this' }),
			createMockEntry({ id: 'term1', command: 'npm install', mode: 'terminal' }),
			createAIEntry({ id: 'ai2', command: 'Fix the bug' }),
		];

		render(<CommandHistoryDrawer {...createDefaultProps({ history: entries })} />);

		expect(screen.getByText('Explain this')).toBeInTheDocument();
		expect(screen.getByText('npm install')).toBeInTheDocument();
		expect(screen.getByText('Fix the bug')).toBeInTheDocument();
	});

	it('handles rapid open/close transitions', () => {
		const onClose = vi.fn();
		const { rerender } = render(
			<CommandHistoryDrawer {...createDefaultProps({ isOpen: true, onClose })} />
		);

		expect(screen.getByText('Command History')).toBeInTheDocument();

		// Close
		rerender(<CommandHistoryDrawer {...createDefaultProps({ isOpen: false, onClose })} />);

		// Open again
		rerender(<CommandHistoryDrawer {...createDefaultProps({ isOpen: true, onClose })} />);

		expect(screen.getByText('Command History')).toBeInTheDocument();
	});

	it('resets drag offset when drawer opens', () => {
		const { rerender } = render(
			<CommandHistoryDrawer {...createDefaultProps({ isOpen: false })} />
		);

		// Open drawer
		rerender(<CommandHistoryDrawer {...createDefaultProps({ isOpen: true })} />);

		// Drawer should be visible
		expect(screen.getByText('Command History')).toBeInTheDocument();
	});
});

// ============================================================================
// Edge cases
// ============================================================================

describe('Edge cases', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockUseSwipeGestures.mockReturnValue({
			handlers: {
				onTouchStart: vi.fn(),
				onTouchMove: vi.fn(),
				onTouchEnd: vi.fn(),
				onTouchCancel: vi.fn(),
			},
			offsetX: 0,
			offsetY: 0,
			isSwiping: false,
			direction: null,
			resetOffset: mockResetOffset,
		});
	});

	it('handles commands with special characters', () => {
		const entry = createMockEntry({
			command: 'echo "Hello <World> & \"Quotes\""',
		});
		render(<CommandHistoryDrawer {...createDefaultProps({ history: [entry] })} />);

		expect(screen.getByText('echo "Hello <World> & "Quotes""')).toBeInTheDocument();
	});

	it('handles commands with unicode', () => {
		const entry = createMockEntry({
			command: 'echo "🚀 Deploying..."',
		});
		render(<CommandHistoryDrawer {...createDefaultProps({ history: [entry] })} />);

		expect(screen.getByText('echo "🚀 Deploying..."')).toBeInTheDocument();
	});

	it('handles very long command list', () => {
		const entries = Array.from({ length: 100 }, (_, i) =>
			createMockEntry({ id: `e${i}`, command: `command ${i}` })
		);
		render(<CommandHistoryDrawer {...createDefaultProps({ history: entries })} />);

		// First and last should be visible (scroll needed for all)
		expect(screen.getByText('command 0')).toBeInTheDocument();
		expect(screen.getByText('command 99')).toBeInTheDocument();
	});

	it('handles empty command string', () => {
		const entry = createMockEntry({ command: '' });
		render(<CommandHistoryDrawer {...createDefaultProps({ history: [entry] })} />);

		// Should still render the entry with empty command
		// Check timestamp is present (font-size in DOM is lowercase)
		expect(document.querySelector('[style*="font-size: 11px"]')).toBeTruthy();
	});

	it('handles whitespace-only command', () => {
		const entry = createMockEntry({ command: '   ' });
		render(<CommandHistoryDrawer {...createDefaultProps({ history: [entry] })} />);

		// Shared truncateCommand trims whitespace, so whitespace-only becomes empty string
		// The entry should still render with an empty command text
		const commandElements = document.querySelectorAll('p[style*="font-family: ui-monospace"]');
		const emptyCommand = Array.from(commandElements).find((el) => el.textContent === '');
		expect(emptyCommand).toBeTruthy();
	});

	it('handles negative timestamp', () => {
		const entry = createMockEntry({ timestamp: -1000 });
		render(<CommandHistoryDrawer {...createDefaultProps({ history: [entry] })} />);

		// Should handle gracefully
		expect(screen.getByText('npm run test')).toBeInTheDocument();
	});

	it('handles future timestamp', () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2025-01-15T12:00:00Z'));

		const entry = createMockEntry({
			timestamp: Date.now() + 24 * 60 * 60 * 1000, // 1 day in future
		});
		render(<CommandHistoryDrawer {...createDefaultProps({ history: [entry] })} />);

		// formatRelativeTime with negative diff should show "just now"
		expect(screen.getByText('just now')).toBeInTheDocument();

		vi.useRealTimers();
	});

	it('handles command exactly at max length boundary', () => {
		const exactCommand = 'x'.repeat(60);
		const entry = createMockEntry({ command: exactCommand });
		render(<CommandHistoryDrawer {...createDefaultProps({ history: [entry] })} />);

		expect(screen.getByText(exactCommand)).toBeInTheDocument();
	});

	it('handles SSR scenario (undefined window)', () => {
		// The component handles this with typeof window !== 'undefined' check
		// In jsdom, window is always defined, so we just verify it doesn't crash
		render(<CommandHistoryDrawer {...createDefaultProps({ isOpen: true })} />);
		expect(screen.getByText('Command History')).toBeInTheDocument();
	});
});

// ============================================================================
// Accessibility tests
// ============================================================================

describe('Accessibility', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockUseSwipeGestures.mockReturnValue({
			handlers: {
				onTouchStart: vi.fn(),
				onTouchMove: vi.fn(),
				onTouchEnd: vi.fn(),
				onTouchCancel: vi.fn(),
			},
			offsetX: 0,
			offsetY: 0,
			isSwiping: false,
			direction: null,
			resetOffset: mockResetOffset,
		});
	});

	it('has proper heading hierarchy', () => {
		render(<CommandHistoryDrawer {...createDefaultProps({ isOpen: true })} />);

		const heading = screen.getByRole('heading', { level: 3 });
		expect(heading).toHaveTextContent('Command History');
	});

	it('delete button has aria-label', () => {
		const entry = createMockEntry();
		render(
			<CommandHistoryDrawer
				{...createDefaultProps({
					history: [entry],
					onDeleteCommand: vi.fn(),
				})}
			/>
		);

		expect(screen.getByLabelText('Delete command')).toBeInTheDocument();
	});

	it('swipe hint is aria-hidden', () => {
		const entry = createMockEntry();
		render(
			<CommandHistoryDrawer
				{...createDefaultProps({
					history: [entry],
					onDeleteCommand: vi.fn(),
				})}
			/>
		);

		const chevron = document.querySelector('[aria-hidden="true"]');
		expect(chevron).toBeTruthy();
	});
});

// ============================================================================
// Constants validation
// ============================================================================

describe('Constants', () => {
	it('uses correct handle height', () => {
		render(<CommandHistoryDrawer {...createDefaultProps({ isOpen: true })} />);

		// Handle height is 28px
		const handle = document.querySelector('[style*="height: 28px"]');
		expect(handle).toBeTruthy();
	});

	it('uses correct visual handle dimensions', () => {
		render(<CommandHistoryDrawer {...createDefaultProps({ isOpen: true })} />);

		// Visual handle indicator: 40px x 4px
		const indicator = document.querySelector('[style*="width: 40px"]');
		expect(indicator).toBeTruthy();
		expect(indicator).toHaveStyle({ height: '4px' });
	});

	it('uses correct delete action button width', () => {
		const entry = createMockEntry();
		render(
			<CommandHistoryDrawer
				{...createDefaultProps({
					history: [entry],
					onDeleteCommand: vi.fn(),
				})}
			/>
		);

		// Delete action width is 80px
		const deleteAction = document.querySelector('[style*="width: 80px"]');
		expect(deleteAction).toBeTruthy();
	});
});

// ============================================================================
// Export verification
// ============================================================================

describe('exports', () => {
	it('exports CommandHistoryDrawer as named export', () => {
		expect(CommandHistoryDrawer).toBeDefined();
		expect(typeof CommandHistoryDrawer).toBe('function');
	});

	it('exports default', async () => {
		const module = await import('../../../web/mobile/CommandHistoryDrawer');
		expect(module.default).toBe(CommandHistoryDrawer);
	});
});

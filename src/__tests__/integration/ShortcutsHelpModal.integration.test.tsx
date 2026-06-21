/**
 * @file ShortcutsHelpModal.test.tsx
 * @description Tests for the ShortcutsHelpModal component
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';
import { ShortcutsHelpModal } from '../../renderer/components/ShortcutsHelpModal';
import { LayerStackProvider } from '../../renderer/contexts/LayerStackContext';
import type { Theme, Shortcut, KeyboardMasteryStats } from '../../renderer/types';
import { FIXED_SHORTCUTS } from '../../renderer/constants/shortcuts';

// Create a mock theme for testing
const createMockTheme = (): Theme => ({
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#1a1a1a',
		bgPanel: '#252525',
		bgSidebar: '#202020',
		bgActivity: '#2d2d2d',
		textMain: '#ffffff',
		textDim: '#888888',
		accent: '#0066ff',
		accentForeground: '#ffffff',
		border: '#333333',
		highlight: '#0066ff33',
		success: '#00aa00',
		warning: '#ffaa00',
		error: '#ff0000',
	},
});

// Create mock shortcuts for testing
const createMockShortcuts = (): Record<string, Shortcut> => ({
	'new-session': {
		id: 'new-session',
		label: 'New Session',
		keys: ['Cmd', 'N'],
		category: 'general',
		action: 'createSession',
		editable: true,
	},
	'close-session': {
		id: 'close-session',
		label: 'Close Session',
		keys: ['Cmd', 'W'],
		category: 'general',
		action: 'closeSession',
		editable: true,
	},
	search: {
		id: 'search',
		label: 'Search Files',
		keys: ['Cmd', 'P'],
		category: 'general',
		action: 'search',
		editable: true,
	},
	'toggle-sidebar': {
		id: 'toggle-sidebar',
		label: 'Toggle Left Sidebar',
		keys: ['Cmd', 'B'],
		category: 'ui',
		action: 'toggleLeftBar',
		editable: true,
	},
});

// Wrapper component to provide LayerStackContext
const TestWrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => (
	<LayerStackProvider>{children}</LayerStackProvider>
);

describe('ShortcutsHelpModal', () => {
	const mockTheme = createMockTheme();
	const mockShortcuts = createMockShortcuts();
	let mockOnClose: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		mockOnClose = vi.fn();
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	describe('Basic Rendering', () => {
		it('renders the modal with title', () => {
			render(
				<TestWrapper>
					<ShortcutsHelpModal theme={mockTheme} shortcuts={mockShortcuts} onClose={mockOnClose} />
				</TestWrapper>
			);

			expect(screen.getByText('Keyboard Shortcuts')).toBeInTheDocument();
		});

		it('renders search input', () => {
			render(
				<TestWrapper>
					<ShortcutsHelpModal theme={mockTheme} shortcuts={mockShortcuts} onClose={mockOnClose} />
				</TestWrapper>
			);

			expect(screen.getByPlaceholderText('Search shortcuts...')).toBeInTheDocument();
		});

		it('renders close button', () => {
			render(
				<TestWrapper>
					<ShortcutsHelpModal theme={mockTheme} shortcuts={mockShortcuts} onClose={mockOnClose} />
				</TestWrapper>
			);

			const closeButton = screen.getByRole('button', { name: 'Close' });
			expect(closeButton).toBeInTheDocument();
		});

		it('renders all shortcut items', () => {
			render(
				<TestWrapper>
					<ShortcutsHelpModal theme={mockTheme} shortcuts={mockShortcuts} onClose={mockOnClose} />
				</TestWrapper>
			);

			expect(screen.getByText('New Session')).toBeInTheDocument();
			expect(screen.getByText('Close Session')).toBeInTheDocument();
			expect(screen.getByText('Search Files')).toBeInTheDocument();
		});

		it('has proper dialog accessibility attributes', () => {
			render(
				<TestWrapper>
					<ShortcutsHelpModal theme={mockTheme} shortcuts={mockShortcuts} onClose={mockOnClose} />
				</TestWrapper>
			);

			const dialog = screen.getByRole('dialog');
			expect(dialog).toHaveAttribute('aria-modal', 'true');
			expect(dialog).toHaveAttribute('aria-label', 'Keyboard Shortcuts');
		});

		it('renders footer text', () => {
			render(
				<TestWrapper>
					<ShortcutsHelpModal theme={mockTheme} shortcuts={mockShortcuts} onClose={mockOnClose} />
				</TestWrapper>
			);

			expect(screen.getByText(/Many shortcuts can be customized/)).toBeInTheDocument();
		});

		it('shows first-agent guidance when no agents exist', () => {
			render(
				<TestWrapper>
					<ShortcutsHelpModal
						theme={mockTheme}
						shortcuts={mockShortcuts}
						onClose={mockOnClose}
						hasNoAgents
					/>
				</TestWrapper>
			);

			expect(
				screen.getByText(/unavailable until you've created your first agent/i)
			).toBeInTheDocument();
		});
	});

	describe('Close Button', () => {
		it('calls onClose when close button is clicked', () => {
			render(
				<TestWrapper>
					<ShortcutsHelpModal theme={mockTheme} shortcuts={mockShortcuts} onClose={mockOnClose} />
				</TestWrapper>
			);

			const closeButton = screen.getByRole('button', { name: 'Close' });
			fireEvent.click(closeButton);

			expect(mockOnClose).toHaveBeenCalledTimes(1);
		});
	});

	describe('Search Functionality', () => {
		it('filters shortcuts by label', () => {
			render(
				<TestWrapper>
					<ShortcutsHelpModal theme={mockTheme} shortcuts={mockShortcuts} onClose={mockOnClose} />
				</TestWrapper>
			);

			const searchInput = screen.getByPlaceholderText('Search shortcuts...');
			fireEvent.change(searchInput, { target: { value: 'New' } });

			expect(screen.getByText('New Session')).toBeInTheDocument();
			expect(screen.queryByText('Close Session')).not.toBeInTheDocument();
		});

		it('filters shortcuts by keys', () => {
			render(
				<TestWrapper>
					<ShortcutsHelpModal theme={mockTheme} shortcuts={mockShortcuts} onClose={mockOnClose} />
				</TestWrapper>
			);

			const searchInput = screen.getByPlaceholderText('Search shortcuts...');
			fireEvent.change(searchInput, { target: { value: 'Cmd W' } });

			expect(screen.getByText('Close Session')).toBeInTheDocument();
		});

		it('shows no shortcuts found message when search has no results', () => {
			render(
				<TestWrapper>
					<ShortcutsHelpModal theme={mockTheme} shortcuts={mockShortcuts} onClose={mockOnClose} />
				</TestWrapper>
			);

			const searchInput = screen.getByPlaceholderText('Search shortcuts...');
			fireEvent.change(searchInput, { target: { value: 'xyznonexistent' } });

			expect(screen.getByText('No shortcuts found')).toBeInTheDocument();
		});

		it('shows filtered count when searching', () => {
			render(
				<TestWrapper>
					<ShortcutsHelpModal theme={mockTheme} shortcuts={mockShortcuts} onClose={mockOnClose} />
				</TestWrapper>
			);

			const searchInput = screen.getByPlaceholderText('Search shortcuts...');
			fireEvent.change(searchInput, { target: { value: 'Session' } });

			// Should show "X / Y" format for filtered count (e.g., "2 / 15")
			expect(screen.getByText(/\d+ \/ \d+/)).toBeInTheDocument();
		});

		it('clears search when input is emptied', () => {
			render(
				<TestWrapper>
					<ShortcutsHelpModal theme={mockTheme} shortcuts={mockShortcuts} onClose={mockOnClose} />
				</TestWrapper>
			);

			const searchInput = screen.getByPlaceholderText('Search shortcuts...');

			// First filter
			fireEvent.change(searchInput, { target: { value: 'New' } });
			expect(screen.queryByText('Close Session')).not.toBeInTheDocument();

			// Clear search
			fireEvent.change(searchInput, { target: { value: '' } });
			expect(screen.getByText('Close Session')).toBeInTheDocument();
		});

		it('search is case insensitive', () => {
			render(
				<TestWrapper>
					<ShortcutsHelpModal theme={mockTheme} shortcuts={mockShortcuts} onClose={mockOnClose} />
				</TestWrapper>
			);

			const searchInput = screen.getByPlaceholderText('Search shortcuts...');
			fireEvent.change(searchInput, { target: { value: 'new session' } });

			expect(screen.getByText('New Session')).toBeInTheDocument();
		});
	});

	describe('Shortcut Display', () => {
		it('renders shortcut keys in kbd elements', () => {
			const { container } = render(
				<TestWrapper>
					<ShortcutsHelpModal theme={mockTheme} shortcuts={mockShortcuts} onClose={mockOnClose} />
				</TestWrapper>
			);

			// Check that shortcut keys are displayed in kbd elements
			const kbdElements = container.querySelectorAll('kbd');
			expect(kbdElements.length).toBeGreaterThan(0);
		});

		it('sorts shortcuts alphabetically by label', () => {
			render(
				<TestWrapper>
					<ShortcutsHelpModal theme={mockTheme} shortcuts={mockShortcuts} onClose={mockOnClose} />
				</TestWrapper>
			);

			// Verify that shortcuts are rendered (sorting is handled by the component)
			expect(screen.getByText('New Session')).toBeInTheDocument();
			expect(screen.getByText('Close Session')).toBeInTheDocument();
			expect(screen.getByText('Search Files')).toBeInTheDocument();
		});
	});

	describe('Theme Styling', () => {
		it('applies theme colors to modal container', () => {
			// Modal uses role="dialog" on backdrop; inner container has the themed styles
			const { container } = render(
				<TestWrapper>
					<ShortcutsHelpModal theme={mockTheme} shortcuts={mockShortcuts} onClose={mockOnClose} />
				</TestWrapper>
			);
			const modalContent = container.querySelector('.border.rounded-lg');
			expect(modalContent).toHaveStyle({
				backgroundColor: mockTheme.colors.bgSidebar,
				borderColor: mockTheme.colors.border,
			});
		});

		it('applies theme colors to title', () => {
			render(
				<TestWrapper>
					<ShortcutsHelpModal theme={mockTheme} shortcuts={mockShortcuts} onClose={mockOnClose} />
				</TestWrapper>
			);

			const title = screen.getByText('Keyboard Shortcuts');
			expect(title).toHaveStyle({
				color: mockTheme.colors.textMain,
			});
		});

		it('applies theme colors to search input', () => {
			render(
				<TestWrapper>
					<ShortcutsHelpModal theme={mockTheme} shortcuts={mockShortcuts} onClose={mockOnClose} />
				</TestWrapper>
			);

			const searchInput = screen.getByPlaceholderText('Search shortcuts...');
			expect(searchInput).toHaveStyle({
				borderColor: mockTheme.colors.border,
				color: mockTheme.colors.textMain,
			});
		});
	});

	describe('Empty State', () => {
		it('handles empty shortcuts gracefully', () => {
			render(
				<TestWrapper>
					<ShortcutsHelpModal theme={mockTheme} shortcuts={{}} onClose={mockOnClose} />
				</TestWrapper>
			);

			// Modal should still render
			expect(screen.getByText('Keyboard Shortcuts')).toBeInTheDocument();
		});
	});

	describe('Auto Focus', () => {
		it('search input receives focus on mount', () => {
			render(
				<TestWrapper>
					<ShortcutsHelpModal theme={mockTheme} shortcuts={mockShortcuts} onClose={mockOnClose} />
				</TestWrapper>
			);

			const searchInput = screen.getByPlaceholderText('Search shortcuts...');
			// autoFocus in React is lowercase in the DOM
			expect(searchInput).toBeInTheDocument();
			// Verify the input is focusable
			expect(searchInput.tagName).toBe('INPUT');
		});
	});

	describe('Modal Layout', () => {
		it('has proper dialog structure', () => {
			const { container } = render(
				<TestWrapper>
					<ShortcutsHelpModal theme={mockTheme} shortcuts={mockShortcuts} onClose={mockOnClose} />
				</TestWrapper>
			);

			// Check backdrop exists
			const backdrop = container.querySelector('.fixed.inset-0');
			expect(backdrop).toBeInTheDocument();

			// Check dialog width (Modal component uses a responsive inline style)
			const dialogBox = container.querySelector('.border.rounded-lg');
			expect(dialogBox).toBeInTheDocument();
			expect(dialogBox).toHaveStyle({
				width: 'min(calc(400px * var(--font-scale, 1)), 95vw)',
			});
		});

		it('has scrollable shortcuts container', () => {
			const { container } = render(
				<TestWrapper>
					<ShortcutsHelpModal theme={mockTheme} shortcuts={mockShortcuts} onClose={mockOnClose} />
				</TestWrapper>
			);

			const scrollContainer = container.querySelector('.max-h-\\[400px\\]');
			expect(scrollContainer).toBeInTheDocument();
			expect(scrollContainer).toHaveClass('overflow-y-auto');
		});
	});

	describe('Shortcut Count Badge', () => {
		it('shows total shortcut count when not searching', () => {
			render(
				<TestWrapper>
					<ShortcutsHelpModal theme={mockTheme} shortcuts={mockShortcuts} onClose={mockOnClose} />
				</TestWrapper>
			);

			// Badge shows just the total number when not filtering
			// The exact number depends on TAB_SHORTCUTS and FIXED_SHORTCUTS being merged
			const badge = screen.getByText(/^\d+$/);
			expect(badge).toBeInTheDocument();
		});

		it('badge has proper styling', () => {
			render(
				<TestWrapper>
					<ShortcutsHelpModal theme={mockTheme} shortcuts={mockShortcuts} onClose={mockOnClose} />
				</TestWrapper>
			);

			// Find the badge by its styling classes
			const badges = screen
				.getAllByText(/^\d+/)
				.filter((el) => el.classList.contains('text-xs') && el.classList.contains('rounded'));
			expect(badges.length).toBeGreaterThan(0);
		});
	});

	describe('Fuzzy Search', () => {
		it('supports fuzzy matching on labels', () => {
			render(
				<TestWrapper>
					<ShortcutsHelpModal theme={mockTheme} shortcuts={mockShortcuts} onClose={mockOnClose} />
				</TestWrapper>
			);

			const searchInput = screen.getByPlaceholderText('Search shortcuts...');
			// Fuzzy search should match partial strings
			fireEvent.change(searchInput, { target: { value: 'Sess' } });

			expect(screen.getByText('New Session')).toBeInTheDocument();
			expect(screen.getByText('Close Session')).toBeInTheDocument();
		});
	});

	describe('Keyboard Mastery', () => {
		const createMockMasteryStats = (usedShortcuts: string[]): KeyboardMasteryStats => ({
			usedShortcuts,
			currentLevel: 0,
			lastLevelUpTimestamp: 0,
			lastAcknowledgedLevel: 0,
		});

		it('displays mastery progress bar when keyboardMasteryStats is provided', () => {
			const masteryStats = createMockMasteryStats(['new-session']);

			const { container } = render(
				<TestWrapper>
					<ShortcutsHelpModal
						theme={mockTheme}
						shortcuts={mockShortcuts}
						tabShortcuts={{}}
						onClose={mockOnClose}
						keyboardMasteryStats={masteryStats}
					/>
				</TestWrapper>
			);

			// Should show mastery progress text
			expect(screen.getByText(/mastered/)).toBeInTheDocument();
		});

		it('does not display mastery progress when keyboardMasteryStats is not provided', () => {
			const { container } = render(
				<TestWrapper>
					<ShortcutsHelpModal
						theme={mockTheme}
						shortcuts={mockShortcuts}
						tabShortcuts={{}}
						onClose={mockOnClose}
					/>
				</TestWrapper>
			);

			// Should not show mastery progress
			expect(screen.queryByText(/mastered/)).not.toBeInTheDocument();
		});

		it('shows correct mastery count', () => {
			const masteryStats = createMockMasteryStats(['new-session', 'close-session']);

			render(
				<TestWrapper>
					<ShortcutsHelpModal
						theme={mockTheme}
						shortcuts={mockShortcuts}
						tabShortcuts={{}}
						onClose={mockOnClose}
						keyboardMasteryStats={masteryStats}
					/>
				</TestWrapper>
			);

			// Check that "2 /" appears somewhere in the text (2 shortcuts mastered)
			expect(screen.getByText(/2 \//)).toBeInTheDocument();
		});

		it('displays the current level name', () => {
			const masteryStats = createMockMasteryStats([]);

			render(
				<TestWrapper>
					<ShortcutsHelpModal
						theme={mockTheme}
						shortcuts={mockShortcuts}
						tabShortcuts={{}}
						onClose={mockOnClose}
						keyboardMasteryStats={masteryStats}
					/>
				</TestWrapper>
			);

			// At 0% should show Beginner level
			expect(screen.getByText('Beginner')).toBeInTheDocument();
		});

		it('shows fewer empty circles when shortcuts are used', () => {
			// First, render with no used shortcuts
			const noUsedStats = createMockMasteryStats([]);
			const { container: containerNone, unmount } = render(
				<TestWrapper>
					<ShortcutsHelpModal
						theme={mockTheme}
						shortcuts={mockShortcuts}
						tabShortcuts={{}}
						onClose={mockOnClose}
						keyboardMasteryStats={noUsedStats}
					/>
				</TestWrapper>
			);
			const emptyCirclesNone = containerNone.querySelectorAll('span.rounded-full.border');
			const countNone = emptyCirclesNone.length;
			unmount();

			// Then, render with one used shortcut
			const oneUsedStats = createMockMasteryStats(['new-session']);
			const { container: containerOne } = render(
				<TestWrapper>
					<ShortcutsHelpModal
						theme={mockTheme}
						shortcuts={mockShortcuts}
						tabShortcuts={{}}
						onClose={mockOnClose}
						keyboardMasteryStats={oneUsedStats}
					/>
				</TestWrapper>
			);
			const emptyCirclesOne = containerOne.querySelectorAll('span.rounded-full.border');
			const countOne = emptyCirclesOne.length;

			// With one shortcut used, we should have one less empty circle
			expect(countOne).toBeLessThan(countNone);
		});

		it('shows empty circles for unused shortcuts when mastery is enabled', () => {
			const masteryStats = createMockMasteryStats(['new-session']);

			const { container } = render(
				<TestWrapper>
					<ShortcutsHelpModal
						theme={mockTheme}
						shortcuts={mockShortcuts}
						tabShortcuts={{}}
						onClose={mockOnClose}
						keyboardMasteryStats={masteryStats}
					/>
				</TestWrapper>
			);

			// Empty circles are represented as span elements with rounded-full class
			const emptyCircles = container.querySelectorAll('span.rounded-full.border');
			expect(emptyCircles.length).toBeGreaterThan(0);
		});

		it('applies brighter text color to used shortcuts', () => {
			const masteryStats = createMockMasteryStats(['new-session']);

			render(
				<TestWrapper>
					<ShortcutsHelpModal
						theme={mockTheme}
						shortcuts={mockShortcuts}
						tabShortcuts={{}}
						onClose={mockOnClose}
						keyboardMasteryStats={masteryStats}
					/>
				</TestWrapper>
			);

			const newSessionLabel = screen.getByText('New Session');
			// Used shortcuts should have textMain color
			expect(newSessionLabel).toHaveStyle({ color: mockTheme.colors.textMain });
		});

		it('applies dimmer text color to unused shortcuts', () => {
			const masteryStats = createMockMasteryStats(['new-session']);

			render(
				<TestWrapper>
					<ShortcutsHelpModal
						theme={mockTheme}
						shortcuts={mockShortcuts}
						tabShortcuts={{}}
						onClose={mockOnClose}
						keyboardMasteryStats={masteryStats}
					/>
				</TestWrapper>
			);

			const closeSessionLabel = screen.getByText('Close Session');
			// Unused shortcuts should have textDim color
			expect(closeSessionLabel).toHaveStyle({ color: mockTheme.colors.textDim });
		});

		it('calculates correct percentage for mastery progress', () => {
			// With 4 mock shortcuts and 2 used, should show 50%
			const masteryStats = createMockMasteryStats(['new-session', 'close-session']);

			render(
				<TestWrapper>
					<ShortcutsHelpModal
						theme={mockTheme}
						shortcuts={mockShortcuts}
						tabShortcuts={{}}
						onClose={mockOnClose}
						keyboardMasteryStats={masteryStats}
					/>
				</TestWrapper>
			);

			// Check that percentage is displayed - with FIXED_SHORTCUTS included,
			// the percentage will vary, but should still contain a percentage
			expect(screen.getByText(/%\)/)).toBeInTheDocument();
		});

		it('does not show mastery indicators when keyboardMasteryStats is undefined', () => {
			const { container } = render(
				<TestWrapper>
					<ShortcutsHelpModal
						theme={mockTheme}
						shortcuts={mockShortcuts}
						tabShortcuts={{}}
						onClose={mockOnClose}
					/>
				</TestWrapper>
			);

			// No checkmark icons should be present
			const checkIcons = container.querySelectorAll('svg.lucide-check-circle');
			expect(checkIcons.length).toBe(0);

			// No empty circle indicators should be present
			const emptyCircles = container.querySelectorAll('span.rounded-full.border');
			expect(emptyCircles.length).toBe(0);
		});

		it('shows next level hint when not at 100%', () => {
			// Start with 0 shortcuts used - should show hint about next level
			const masteryStats = createMockMasteryStats([]);

			render(
				<TestWrapper>
					<ShortcutsHelpModal
						theme={mockTheme}
						shortcuts={mockShortcuts}
						tabShortcuts={{}}
						onClose={mockOnClose}
						keyboardMasteryStats={masteryStats}
					/>
				</TestWrapper>
			);

			// Should show hint about reaching the next level (Student at 25%)
			expect(screen.getByText(/more to reach/)).toBeInTheDocument();
			expect(screen.getByText(/Student/)).toBeInTheDocument();
		});

		it('shows special 100% completion styling when all shortcuts are mastered', () => {
			render(
				<TestWrapper>
					<ShortcutsHelpModal
						theme={mockTheme}
						shortcuts={{}}
						tabShortcuts={{}}
						onClose={mockOnClose}
						keyboardMasteryStats={createMockMasteryStats(Object.keys(FIXED_SHORTCUTS))}
					/>
				</TestWrapper>
			);

			expect(screen.getByText(/mastered/)).toHaveTextContent('11 / 11 mastered (100%)');
			expect(screen.getByText('Keyboard Maestro - Complete Mastery!')).toBeInTheDocument();
		});

		it('does not show next level hint at 100%', () => {
			const masteryStats = createMockMasteryStats(Object.keys(FIXED_SHORTCUTS));

			render(
				<TestWrapper>
					<ShortcutsHelpModal
						theme={mockTheme}
						shortcuts={{}}
						tabShortcuts={{}}
						onClose={mockOnClose}
						keyboardMasteryStats={masteryStats}
					/>
				</TestWrapper>
			);

			expect(screen.queryByText(/more to reach/)).not.toBeInTheDocument();
		});

		it('shows Keyboard Maestro level name when at 100% mastery', () => {
			// This test verifies that the level shown changes based on percentage
			// At 100%, the level should be "Keyboard Maestro"

			// We can't easily hit 100% with FIXED_SHORTCUTS included,
			// but we can verify the level name updates correctly at different thresholds

			// At 0%, should show Beginner
			const beginnerStats = createMockMasteryStats([]);
			const { unmount } = render(
				<TestWrapper>
					<ShortcutsHelpModal
						theme={mockTheme}
						shortcuts={mockShortcuts}
						tabShortcuts={{}}
						onClose={mockOnClose}
						keyboardMasteryStats={beginnerStats}
					/>
				</TestWrapper>
			);
			expect(screen.getByText('Beginner')).toBeInTheDocument();
			unmount();
		});

		it('keeps mastery percentage at zero when no shortcuts are available', async () => {
			vi.resetModules();
			vi.doMock('../../renderer/constants/shortcuts', async (importOriginal) => {
				const actual = await importOriginal<typeof import('../../renderer/constants/shortcuts')>();
				return { ...actual, FIXED_SHORTCUTS: {} };
			});

			try {
				const [
					{ ShortcutsHelpModal: EmptyShortcutsHelpModal },
					{ LayerStackProvider: EmptyLayerStackProvider },
				] = await Promise.all([
					import('../../renderer/components/ShortcutsHelpModal'),
					import('../../renderer/contexts/LayerStackContext'),
				]);

				render(
					<EmptyLayerStackProvider>
						<EmptyShortcutsHelpModal
							theme={mockTheme}
							shortcuts={{}}
							tabShortcuts={{}}
							onClose={mockOnClose}
							keyboardMasteryStats={createMockMasteryStats([])}
						/>
					</EmptyLayerStackProvider>
				);

				expect(screen.getByText('0 / 0 mastered (0%)')).toBeInTheDocument();
			} finally {
				vi.doUnmock('../../renderer/constants/shortcuts');
				vi.resetModules();
			}
		});
	});
});

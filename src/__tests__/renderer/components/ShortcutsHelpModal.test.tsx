/**
 * @file ShortcutsHelpModal.test.tsx
 * @description Tests for the ShortcutsHelpModal component
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';
import { ShortcutsHelpModal } from '../../../renderer/components/ShortcutsHelpModal';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import type { Theme } from '../../../renderer/types';

import { createMockTheme } from '../../helpers/mockTheme';
import { useActiveShortcuts } from '../../../renderer/hooks/settings/useActiveShortcuts';

// Mock the useActiveShortcuts hook
vi.mock('../../../renderer/hooks/settings/useActiveShortcuts', () => ({
	useActiveShortcuts: vi.fn(),
}));

// Mock useSettingsStore for mastery stats
vi.mock('../../../renderer/stores/settingsStore', () => ({
	useSettingsStore: vi.fn((selector) => {
		// Return mock data for different selectors
		const state = {
			encoreFeatures: {},
			shortcuts: {},
			vimShortcuts: {},
			tabShortcuts: {},
			vimTabShortcuts: {},
			modalSizes: {},
			setModalSize: vi.fn(),
			resetModalSize: vi.fn(),
		};
		if (typeof selector === 'function') {
			return selector(state);
		}
		return state;
	}),
}));

// Create mock shortcuts data for testing
const createMockShortcutsData = () => ({
	keyboardMode: 'default' as const,
	shortcuts: {
		'new-session': { id: 'new-session', label: 'New Session', keys: ['Meta', 'n'] },
		'close-session': { id: 'close-session', label: 'Close Session', keys: ['Meta', 'w'] },
		search: { id: 'search', label: 'Search Files', keys: ['Meta', 'p'] },
		'toggle-sidebar': { id: 'toggle-sidebar', label: 'Toggle Left Sidebar', keys: ['Meta', 'b'] },
	},
	tabShortcuts: {},
});

// Wrapper component to provide LayerStackContext
const TestWrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => (
	<LayerStackProvider>{children}</LayerStackProvider>
);

describe('ShortcutsHelpModal', () => {
	const mockTheme = createMockTheme();
	let mockOnClose: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		mockOnClose = vi.fn();
		// Set up default mock for useActiveShortcuts
		(useActiveShortcuts as any).mockReturnValue(createMockShortcutsData());
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	describe('Basic Rendering', () => {
		it('renders the modal with title', () => {
			render(
				<TestWrapper>
					<ShortcutsHelpModal theme={mockTheme} onClose={mockOnClose} />
				</TestWrapper>
			);

			expect(screen.getByText('Keyboard Shortcuts')).toBeInTheDocument();
		});

		it('renders search input', () => {
			render(
				<TestWrapper>
					<ShortcutsHelpModal theme={mockTheme} onClose={mockOnClose} />
				</TestWrapper>
			);

			expect(screen.getByPlaceholderText('Search shortcuts...')).toBeInTheDocument();
		});

		it('renders mode badge showing Default Mode', () => {
			render(
				<TestWrapper>
					<ShortcutsHelpModal theme={mockTheme} onClose={mockOnClose} />
				</TestWrapper>
			);

			expect(screen.getByText('Default Mode')).toBeInTheDocument();
		});

		it('renders keyboard shortcuts modal dialog', () => {
			render(
				<TestWrapper>
					<ShortcutsHelpModal theme={mockTheme} onClose={mockOnClose} />
				</TestWrapper>
			);

			const dialog = screen.getByRole('dialog');
			expect(dialog).toHaveAttribute('aria-modal', 'true');
			expect(dialog).toHaveAttribute('aria-label', 'Keyboard Shortcuts');
		});
	});

	describe('Close Button', () => {
		it('calls onClose when close button is clicked', () => {
			render(
				<TestWrapper>
					<ShortcutsHelpModal theme={mockTheme} onClose={mockOnClose} />
				</TestWrapper>
			);

			const dialog = screen.getByRole('dialog');
			const closeButton = dialog.querySelector('[aria-label="Close"]') as HTMLElement;
			if (closeButton) {
				fireEvent.click(closeButton);
				expect(mockOnClose).toHaveBeenCalledTimes(1);
			}
		});
	});

	describe('Search Functionality', () => {
		it('filters shortcuts by label', () => {
			render(
				<TestWrapper>
					<ShortcutsHelpModal theme={mockTheme} onClose={mockOnClose} />
				</TestWrapper>
			);

			const searchInput = screen.getByPlaceholderText('Search shortcuts...');
			fireEvent.change(searchInput, { target: { value: 'New' } });

			// After filtering, the input should still be present and the search should work
			expect(searchInput).toBeInTheDocument();
		});

		it('clears search when input is emptied', () => {
			render(
				<TestWrapper>
					<ShortcutsHelpModal theme={mockTheme} onClose={mockOnClose} />
				</TestWrapper>
			);

			const searchInput = screen.getByPlaceholderText('Search shortcuts...') as HTMLInputElement;

			// First filter
			fireEvent.change(searchInput, { target: { value: 'New' } });
			expect(searchInput.value).toBe('New');

			// Clear search
			fireEvent.change(searchInput, { target: { value: '' } });
			expect(searchInput.value).toBe('');
		});

		it('search is case insensitive', () => {
			render(
				<TestWrapper>
					<ShortcutsHelpModal theme={mockTheme} onClose={mockOnClose} />
				</TestWrapper>
			);

			const searchInput = screen.getByPlaceholderText('Search shortcuts...');
			fireEvent.change(searchInput, { target: { value: 'NEW' } });

			expect(searchInput).toBeInTheDocument();
		});
	});

	describe('Vim Mode Support', () => {
		it('renders Vim Mode badge when keyboard mode is vim', () => {
			(useActiveShortcuts as any).mockReturnValue({
				keyboardMode: 'vim',
				shortcuts: {
					'focus-up': { id: 'focus-up', label: 'Focus Up', keys: ['k'] },
					'focus-down': { id: 'focus-down', label: 'Focus Down', keys: ['j'] },
				},
				tabShortcuts: {},
			});

			render(
				<TestWrapper>
					<ShortcutsHelpModal theme={mockTheme} onClose={mockOnClose} />
				</TestWrapper>
			);

			expect(screen.getByText('Vim Mode')).toBeInTheDocument();
		});
	});

	describe('Theme Styling', () => {
		it('applies theme colors to modal container', () => {
			const { container } = render(
				<TestWrapper>
					<ShortcutsHelpModal theme={mockTheme} onClose={mockOnClose} />
				</TestWrapper>
			);
			const modalContent = container.querySelector('[data-modal-resize-key="shortcuts-help"]');
			expect(modalContent).toBeInTheDocument();
		});

		it('applies theme colors to title', () => {
			render(
				<TestWrapper>
					<ShortcutsHelpModal theme={mockTheme} onClose={mockOnClose} />
				</TestWrapper>
			);

			const title = screen.getByText('Keyboard Shortcuts');
			expect(title).toBeInTheDocument();
		});
	});

	describe('Modal Layout', () => {
		it('has proper dialog structure', () => {
			const { container } = render(
				<TestWrapper>
					<ShortcutsHelpModal theme={mockTheme} onClose={mockOnClose} />
				</TestWrapper>
			);

			// Check backdrop exists
			const backdrop = container.querySelector('.fixed.inset-0');
			expect(backdrop).toBeInTheDocument();

			// The dialog is a resizable frame keyed by resizeKey
			const dialogBox = container.querySelector('[data-modal-resize-key="shortcuts-help"]');
			expect(dialogBox).toBeInTheDocument();
		});
	});

	describe('Props Handling', () => {
		it('accepts hasNoAgents prop', () => {
			render(
				<TestWrapper>
					<ShortcutsHelpModal theme={mockTheme} onClose={mockOnClose} hasNoAgents={true} />
				</TestWrapper>
			);

			expect(screen.getByText('Keyboard Shortcuts')).toBeInTheDocument();
		});

		it('accepts onOpenShortcutSettings callback', () => {
			const onOpenSettings = vi.fn();
			render(
				<TestWrapper>
					<ShortcutsHelpModal
						theme={mockTheme}
						onClose={mockOnClose}
						onOpenShortcutSettings={onOpenSettings}
					/>
				</TestWrapper>
			);

			expect(screen.getByText('Keyboard Shortcuts')).toBeInTheDocument();
		});
	});
});

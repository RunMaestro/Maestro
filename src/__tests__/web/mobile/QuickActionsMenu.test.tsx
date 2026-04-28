/**
 * Tests for QuickActionsMenu component
 *
 * QuickActionsMenu is a full-screen command palette providing quick access
 * to all app actions with search, keyboard navigation, and recent actions.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

// Mock useThemeColors
vi.mock('../../../web/components/ThemeProvider', () => ({
	useThemeColors: () => ({
		bgSidebar: '#1e1e2e',
		bgMain: '#181825',
		border: '#45475a',
		textMain: '#cdd6f4',
		textDim: '#a6adc8',
		accent: '#89b4fa',
	}),
}));

// Mock localStorage for the test environment
const localStorageMock = (() => {
	let store: Record<string, string> = {};
	return {
		getItem: vi.fn((key: string) => store[key] ?? null),
		setItem: vi.fn((key: string, value: string) => {
			store[key] = value;
		}),
		removeItem: vi.fn((key: string) => {
			delete store[key];
		}),
		clear: vi.fn(() => {
			store = {};
		}),
		length: 0,
		key: vi.fn(),
	};
})();
Object.defineProperty(window, 'localStorage', { value: localStorageMock, writable: true });

import {
	QuickActionsMenu,
	QuickActionsMenuProps,
	CommandPaletteAction,
} from '../../../web/mobile/QuickActionsMenu';

/** Helper to build a minimal CommandPaletteAction */
function makeAction(overrides: Partial<CommandPaletteAction> = {}): CommandPaletteAction {
	return {
		id: 'test-action',
		label: 'Test Action',
		category: 'Navigation',
		icon: <span>icon</span>,
		action: vi.fn(),
		...overrides,
	};
}

describe('QuickActionsMenu', () => {
	const defaultActions: CommandPaletteAction[] = [
		makeAction({ id: 'action-1', label: 'Go to Home', category: 'Navigation' }),
		makeAction({ id: 'action-2', label: 'Start Agent', category: 'Agent' }),
	];

	const defaultProps: QuickActionsMenuProps = {
		isOpen: true,
		onClose: vi.fn(),
		actions: defaultActions,
	};

	beforeEach(() => {
		vi.clearAllMocks();
		localStorageMock.clear();
	});

	afterEach(() => {
		cleanup();
	});

	describe('Render conditions', () => {
		it('returns null when isOpen is false', () => {
			const { container } = render(<QuickActionsMenu {...defaultProps} isOpen={false} />);
			expect(container.firstChild).toBeNull();
		});

		it('renders when isOpen is true', () => {
			render(<QuickActionsMenu {...defaultProps} />);
			expect(screen.getByRole('dialog')).toBeInTheDocument();
		});

		it('renders backdrop overlay', () => {
			render(<QuickActionsMenu {...defaultProps} />);
			const backdrop = document.querySelector('[role="presentation"]');
			expect(backdrop).toBeInTheDocument();
			// ResponsiveModal applies Tailwind `.fixed` to the backdrop wrapper;
			// in jsdom the inline `position` is empty, so we assert the class instead.
			expect(backdrop).toHaveClass('fixed');
		});

		it('renders with empty actions array', () => {
			render(<QuickActionsMenu {...defaultProps} actions={[]} />);
			expect(screen.getByRole('dialog')).toBeInTheDocument();
		});
	});

	describe('Search input', () => {
		it('renders search input with placeholder', () => {
			render(<QuickActionsMenu {...defaultProps} />);
			expect(screen.getByPlaceholderText('Search actions...')).toBeInTheDocument();
		});

		it('has aria-label on search input', () => {
			render(<QuickActionsMenu {...defaultProps} />);
			expect(screen.getByLabelText('Search actions')).toBeInTheDocument();
		});

		it('filters actions by search query', () => {
			render(<QuickActionsMenu {...defaultProps} />);
			const input = screen.getByPlaceholderText('Search actions...');

			fireEvent.change(input, { target: { value: 'Home' } });

			expect(screen.getByText('Go to Home')).toBeInTheDocument();
			expect(screen.queryByText('Start Agent')).not.toBeInTheDocument();
		});

		it('filters actions by category', () => {
			render(<QuickActionsMenu {...defaultProps} />);
			const input = screen.getByPlaceholderText('Search actions...');

			fireEvent.change(input, { target: { value: 'Agent' } });

			expect(screen.getByText('Start Agent')).toBeInTheDocument();
			expect(screen.queryByText('Go to Home')).not.toBeInTheDocument();
		});

		it('shows "No matching actions" when nothing matches', () => {
			render(<QuickActionsMenu {...defaultProps} />);
			const input = screen.getByPlaceholderText('Search actions...');

			fireEvent.change(input, { target: { value: 'zzznomatch' } });

			expect(screen.getByText('No matching actions')).toBeInTheDocument();
		});

		it('shows clear button when search has text', () => {
			render(<QuickActionsMenu {...defaultProps} />);
			const input = screen.getByPlaceholderText('Search actions...');

			fireEvent.change(input, { target: { value: 'test' } });

			expect(screen.getByLabelText('Clear search')).toBeInTheDocument();
		});

		it('clears search when clear button is clicked', () => {
			render(<QuickActionsMenu {...defaultProps} />);
			const input = screen.getByPlaceholderText('Search actions...');

			fireEvent.change(input, { target: { value: 'test' } });
			fireEvent.click(screen.getByLabelText('Clear search'));

			expect((input as HTMLInputElement).value).toBe('');
		});
	});

	describe('Action list rendering', () => {
		it('renders all available actions', () => {
			render(<QuickActionsMenu {...defaultProps} />);
			expect(screen.getByText('Go to Home')).toBeInTheDocument();
			expect(screen.getByText('Start Agent')).toBeInTheDocument();
		});

		it('renders category headers', () => {
			render(<QuickActionsMenu {...defaultProps} />);
			expect(screen.getByText('Navigation')).toBeInTheDocument();
			expect(screen.getByText('Agent')).toBeInTheDocument();
		});

		it('renders action buttons with role="option"', () => {
			render(<QuickActionsMenu {...defaultProps} />);
			const options = screen.getAllByRole('option');
			expect(options).toHaveLength(2);
		});

		it('renders listbox with role="listbox"', () => {
			render(<QuickActionsMenu {...defaultProps} />);
			expect(screen.getByRole('listbox')).toBeInTheDocument();
		});

		it('skips actions where available() returns false', () => {
			const actions: CommandPaletteAction[] = [
				makeAction({ id: 'visible', label: 'Visible Action', available: () => true }),
				makeAction({ id: 'hidden', label: 'Hidden Action', available: () => false }),
			];
			render(<QuickActionsMenu {...defaultProps} actions={actions} />);
			expect(screen.getByText('Visible Action')).toBeInTheDocument();
			expect(screen.queryByText('Hidden Action')).not.toBeInTheDocument();
		});

		it('shows action when available() is undefined (defaults to visible)', () => {
			const actions: CommandPaletteAction[] = [
				makeAction({ id: 'no-guard', label: 'No Guard Action', available: undefined }),
			];
			render(<QuickActionsMenu {...defaultProps} actions={actions} />);
			expect(screen.getByText('No Guard Action')).toBeInTheDocument();
		});

		it('renders action shortcuts when provided', () => {
			const actions: CommandPaletteAction[] = [
				makeAction({ id: 'with-shortcut', label: 'Shortcut Action', shortcut: 'Cmd+K' }),
			];
			render(<QuickActionsMenu {...defaultProps} actions={actions} />);
			expect(screen.getByText('Cmd+K')).toBeInTheDocument();
		});
	});

	describe('Action execution', () => {
		it('calls action.action() when an item is clicked', () => {
			const actionFn = vi.fn();
			const actions = [makeAction({ id: 'clickable', label: 'Clickable', action: actionFn })];
			render(<QuickActionsMenu {...defaultProps} actions={actions} />);

			fireEvent.click(screen.getByText('Clickable'));
			expect(actionFn).toHaveBeenCalled();
		});

		it('calls onClose when an item is clicked', () => {
			const onClose = vi.fn();
			const actions = [makeAction({ id: 'clickable', label: 'Clickable' })];
			render(<QuickActionsMenu {...defaultProps} actions={actions} onClose={onClose} />);

			fireEvent.click(screen.getByText('Clickable'));
			expect(onClose).toHaveBeenCalled();
		});
	});

	describe('Recent actions', () => {
		it('shows Recent section header after an action is used', () => {
			const actionFn = vi.fn();
			const actions = [makeAction({ id: 'recent-test', label: 'Recent Test', action: actionFn })];

			// Simulate a prior usage by pre-populating localStorage
			localStorage.setItem('maestro-command-palette-recent', JSON.stringify(['recent-test']));

			render(<QuickActionsMenu {...defaultProps} actions={actions} />);
			expect(screen.getByText('Recent')).toBeInTheDocument();
		});

		it('does not show Recent section when localStorage is empty', () => {
			render(<QuickActionsMenu {...defaultProps} />);
			expect(screen.queryByText('Recent')).not.toBeInTheDocument();
		});
	});

	describe('Escape key handling', () => {
		it('closes menu when Escape key is pressed', () => {
			const onClose = vi.fn();
			render(<QuickActionsMenu {...defaultProps} onClose={onClose} />);
			fireEvent.keyDown(document, { key: 'Escape' });
			expect(onClose).toHaveBeenCalled();
		});

		it('does not close menu on other keys', () => {
			const onClose = vi.fn();
			render(<QuickActionsMenu {...defaultProps} onClose={onClose} />);
			fireEvent.keyDown(document, { key: 'Tab' });
			fireEvent.keyDown(document, { key: 'a' });
			expect(onClose).not.toHaveBeenCalled();
		});

		it('removes keydown listener when menu closes', () => {
			const onClose = vi.fn();
			const removeEventListenerSpy = vi.spyOn(document, 'removeEventListener');

			const { rerender } = render(<QuickActionsMenu {...defaultProps} onClose={onClose} />);
			rerender(<QuickActionsMenu {...defaultProps} isOpen={false} onClose={onClose} />);

			expect(removeEventListenerSpy).toHaveBeenCalledWith('keydown', expect.any(Function));
			removeEventListenerSpy.mockRestore();
		});
	});

	describe('Keyboard navigation', () => {
		it('moves selection down with ArrowDown', () => {
			render(<QuickActionsMenu {...defaultProps} />);
			const options = screen.getAllByRole('option');

			// First item should be selected initially
			expect(options[0]).toHaveAttribute('aria-selected', 'true');

			fireEvent.keyDown(document, { key: 'ArrowDown' });
			expect(options[1]).toHaveAttribute('aria-selected', 'true');
		});

		it('moves selection up with ArrowUp', () => {
			render(<QuickActionsMenu {...defaultProps} />);
			const options = screen.getAllByRole('option');

			// Move down first
			fireEvent.keyDown(document, { key: 'ArrowDown' });
			expect(options[1]).toHaveAttribute('aria-selected', 'true');

			// Then up
			fireEvent.keyDown(document, { key: 'ArrowUp' });
			expect(options[0]).toHaveAttribute('aria-selected', 'true');
		});

		it('executes selected action with Enter key', () => {
			const actionFn = vi.fn();
			const actions = [makeAction({ id: 'enter-test', label: 'Enter Test', action: actionFn })];
			render(<QuickActionsMenu {...defaultProps} actions={actions} />);

			fireEvent.keyDown(document, { key: 'Enter' });
			expect(actionFn).toHaveBeenCalled();
		});

		it('resets selection to 0 when search query changes', () => {
			render(<QuickActionsMenu {...defaultProps} />);
			const options = screen.getAllByRole('option');

			// Move selection down
			fireEvent.keyDown(document, { key: 'ArrowDown' });
			expect(options[1]).toHaveAttribute('aria-selected', 'true');

			// Change search — selection should reset
			const input = screen.getByPlaceholderText('Search actions...');
			fireEvent.change(input, { target: { value: 'Go' } });

			// Only one option now, and it should be selected
			const newOptions = screen.getAllByRole('option');
			expect(newOptions[0]).toHaveAttribute('aria-selected', 'true');
		});
	});

	describe('Backdrop interaction', () => {
		it('closes menu when backdrop is clicked', () => {
			const onClose = vi.fn();
			render(<QuickActionsMenu {...defaultProps} onClose={onClose} />);
			const backdrop = document.querySelector('[role="presentation"]') as HTMLElement;
			fireEvent.click(backdrop);
			expect(onClose).toHaveBeenCalled();
		});

		it('backdrop covers full viewport', () => {
			render(<QuickActionsMenu {...defaultProps} />);
			const backdrop = document.querySelector('[role="presentation"]') as HTMLElement;
			// ResponsiveModal uses Tailwind `.fixed inset-0` for the backdrop;
			// assert those classes since jsdom doesn't resolve Tailwind's generated CSS.
			expect(backdrop).toHaveClass('fixed');
			expect(backdrop).toHaveClass('inset-0');
		});

		it('backdrop has semi-transparent background', () => {
			render(<QuickActionsMenu {...defaultProps} />);
			const backdrop = document.querySelector('[role="presentation"]') as HTMLElement;
			// Tailwind class `bg-black/50` supplies the dim overlay. Inline style is empty in jsdom.
			expect(backdrop).toHaveClass('bg-black/50');
		});
	});

	describe('Accessibility', () => {
		it('has role="dialog" on container', () => {
			render(<QuickActionsMenu {...defaultProps} />);
			expect(screen.getByRole('dialog')).toBeInTheDocument();
		});

		it('has aria-label on dialog container', () => {
			render(<QuickActionsMenu {...defaultProps} />);
			const dialog = screen.getByRole('dialog');
			expect(dialog).toHaveAttribute('aria-label', 'Command Palette');
		});

		it('has aria-modal on dialog container', () => {
			render(<QuickActionsMenu {...defaultProps} />);
			const dialog = screen.getByRole('dialog');
			expect(dialog).toHaveAttribute('aria-modal', 'true');
		});

		it('has role="option" on action buttons', () => {
			render(<QuickActionsMenu {...defaultProps} />);
			const options = screen.getAllByRole('option');
			expect(options.length).toBeGreaterThan(0);
		});

		it('backdrop has role="presentation"', () => {
			render(<QuickActionsMenu {...defaultProps} />);
			const backdrop = document.querySelector('[role="presentation"]');
			expect(backdrop).toBeInTheDocument();
		});
	});

	describe('Menu styling', () => {
		it('applies correct z-index on backdrop wrapper', () => {
			render(<QuickActionsMenu {...defaultProps} />);
			// ResponsiveModal puts the zIndex inline on the backdrop/presentation
			// wrapper, not on the dialog itself.
			const backdrop = document.querySelector('[role="presentation"]') as HTMLElement;
			expect(backdrop).toHaveStyle({ zIndex: '300' });
		});

		it('has modal animation class', () => {
			render(<QuickActionsMenu {...defaultProps} />);
			const dialog = screen.getByRole('dialog');
			// Tailwind `animate-slideUp` (phone) or `animate-modalIn` (tablet+) —
			// both come from `src/web/index.css`. jsdom defaults viewport to 1024px
			// so at render time we're in the tablet+ branch.
			expect(dialog.className).toMatch(/animate-(modalIn|slideUp)/);
		});

		it('has rounded corners', () => {
			render(<QuickActionsMenu {...defaultProps} />);
			const dialog = screen.getByRole('dialog');
			// Tailwind `rounded-lg` (tablet+) or `rounded-t-2xl` (phone) provides
			// the corner radius instead of an inline `borderRadius`.
			expect(dialog.className).toMatch(/rounded-(lg|t-2xl)/);
		});
	});

	describe('Footer hint', () => {
		it('renders keyboard navigation hints', () => {
			render(<QuickActionsMenu {...defaultProps} />);
			expect(screen.getByText('navigate')).toBeInTheDocument();
			expect(screen.getByText('select')).toBeInTheDocument();
			expect(screen.getByText('close')).toBeInTheDocument();
		});
	});

	describe('Touch feedback', () => {
		it('applies highlight color on touch start', () => {
			const actions = [makeAction({ id: 'touch-test', label: 'Touch Test' })];
			render(<QuickActionsMenu {...defaultProps} actions={actions} />);
			const option = screen.getByRole('option');

			fireEvent.touchStart(option);
			expect(option.style.backgroundColor).toContain('rgba(137, 180, 250');
		});

		it('resets background on touch end', () => {
			const actions = [makeAction({ id: 'touch-test', label: 'Touch Test' })];
			render(<QuickActionsMenu {...defaultProps} actions={actions} />);
			const option = screen.getByRole('option');

			fireEvent.touchStart(option);
			fireEvent.touchEnd(option);
			// After touch end, reverts to either selected highlight or transparent
			expect(option.style.backgroundColor).toBeTruthy();
		});
	});

	describe('Type exports', () => {
		it('CommandPaletteAction type is properly defined', () => {
			const action: CommandPaletteAction = makeAction();
			expect(action.id).toBeDefined();
			expect(action.label).toBeDefined();
			expect(action.category).toBeDefined();
		});
	});

	describe('Edge cases', () => {
		it('handles rapid open/close transitions', () => {
			const { rerender } = render(<QuickActionsMenu {...defaultProps} />);

			for (let i = 0; i < 10; i++) {
				rerender(<QuickActionsMenu {...defaultProps} isOpen={false} />);
				rerender(<QuickActionsMenu {...defaultProps} isOpen={true} />);
			}

			expect(screen.getByRole('dialog')).toBeInTheDocument();
		});

		it('handles actions list updating while open', () => {
			const { rerender } = render(<QuickActionsMenu {...defaultProps} />);
			expect(screen.getByText('Go to Home')).toBeInTheDocument();

			const newActions = [
				makeAction({ id: 'new-action', label: 'New Action', category: 'Navigation' }),
			];
			rerender(<QuickActionsMenu {...defaultProps} actions={newActions} />);
			expect(screen.getByText('New Action')).toBeInTheDocument();
			expect(screen.queryByText('Go to Home')).not.toBeInTheDocument();
		});

		it('handles a large number of actions', () => {
			const manyActions: CommandPaletteAction[] = Array.from({ length: 50 }, (_, i) =>
				makeAction({ id: `action-${i}`, label: `Action ${i}`, category: 'Navigation' })
			);
			render(<QuickActionsMenu {...defaultProps} actions={manyActions} />);
			const options = screen.getAllByRole('option');
			expect(options).toHaveLength(50);
		});
	});

	describe('Default export', () => {
		it('default export matches named export', async () => {
			const namedModule = await import('../../../web/mobile/QuickActionsMenu');
			expect(namedModule.default).toBe(namedModule.QuickActionsMenu);
		});
	});
});

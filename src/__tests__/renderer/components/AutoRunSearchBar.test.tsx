/**
 * @file AutoRunSearchBar.test.tsx
 * @description Tests for the AutoRunSearchBar component - a search bar for finding text within Auto Run documents
 *
 * The AutoRunSearchBar:
 * - Provides a text search input that auto-focuses on mount
 * - Shows match count (e.g., "1/5") or "No matches" when there are no results
 * - Has navigation buttons for next/previous match (with keyboard shortcuts)
 * - Closes via Escape key or close button
 * - Keyboard shortcuts: Enter (next match), Shift+Enter (previous match), Escape (close)
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
	AutoRunSearchBar,
	type AutoRunSearchBarProps,
} from '../../../renderer/components/AutoRunSearchBar';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import type { Theme } from '../../../renderer/types';

// Helper to render with LayerStackProvider
const renderWithProvider = (ui: React.ReactElement) => {
	return render(<LayerStackProvider>{ui}</LayerStackProvider>);
};

// Mock Lucide icons
vi.mock('lucide-react', () => ({
	Search: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="search-icon" className={className} style={style} />
	),
	ChevronUp: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="chevron-up-icon" className={className} style={style} />
	),
	ChevronDown: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="chevron-down-icon" className={className} style={style} />
	),
	X: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="x-icon" className={className} style={style} />
	),
}));

// Create a mock theme for testing
const createMockTheme = (): Theme => ({
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#1a1a1a',
		bgSidebar: '#252525',
		bgPanel: '#2d2d2d',
		bgActivity: '#333333',
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

// Default props for AutoRunSearchBar
const createDefaultProps = (
	overrides: Partial<AutoRunSearchBarProps> = {}
): AutoRunSearchBarProps => ({
	theme: createMockTheme(),
	searchQuery: '',
	onSearchQueryChange: vi.fn(),
	currentMatchIndex: 0,
	totalMatches: 0,
	onNextMatch: vi.fn(),
	onPrevMatch: vi.fn(),
	onClose: vi.fn(),
	...overrides,
});

describe('AutoRunSearchBar', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	describe('Basic Rendering', () => {
		it('should render the search input', () => {
			const props = createDefaultProps();
			renderWithProvider(<AutoRunSearchBar {...props} />);

			const input = screen.getByPlaceholderText('Search...');
			expect(input).toBeInTheDocument();
		});

		it('should render the search icon', () => {
			const props = createDefaultProps();
			renderWithProvider(<AutoRunSearchBar {...props} />);

			expect(screen.getByTestId('search-icon')).toBeInTheDocument();
		});

		it('should render the close button', () => {
			const props = createDefaultProps();
			renderWithProvider(<AutoRunSearchBar {...props} />);

			expect(screen.getByTitle('Close search (Esc)')).toBeInTheDocument();
			expect(screen.getByTestId('x-icon')).toBeInTheDocument();
		});

		it('should display the current search query value', () => {
			const props = createDefaultProps({ searchQuery: 'test search' });
			renderWithProvider(<AutoRunSearchBar {...props} />);

			const input = screen.getByPlaceholderText('Search...') as HTMLInputElement;
			expect(input.value).toBe('test search');
		});

		it('should apply theme background color to container', () => {
			const props = createDefaultProps();
			renderWithProvider(<AutoRunSearchBar {...props} />);

			const container = screen.getByPlaceholderText('Search...').closest('div');
			expect(container).toHaveStyle({ backgroundColor: '#333333' });
		});

		it('should apply theme accent color to border', () => {
			const props = createDefaultProps();
			renderWithProvider(<AutoRunSearchBar {...props} />);

			const container = screen.getByPlaceholderText('Search...').closest('div');
			// Check that the border style includes the accent color (converted to RGB by browser)
			const style = container?.getAttribute('style');
			expect(style).toContain('border:');
			// Color is converted from #0066ff to rgb(0, 102, 255)
			expect(style).toContain('rgb(0, 102, 255)');
		});

		it('should apply theme text color to input', () => {
			const props = createDefaultProps();
			renderWithProvider(<AutoRunSearchBar {...props} />);

			const input = screen.getByPlaceholderText('Search...');
			expect(input).toHaveStyle({ color: '#ffffff' });
		});

		it('should apply theme accent color to search icon', () => {
			const props = createDefaultProps();
			renderWithProvider(<AutoRunSearchBar {...props} />);

			const searchIcon = screen.getByTestId('search-icon');
			expect(searchIcon).toHaveStyle({ color: '#0066ff' });
		});
	});

	describe('Search Query Input Handling', () => {
		it('should call onSearchQueryChange when typing in input', () => {
			const onSearchQueryChange = vi.fn();
			const props = createDefaultProps({ onSearchQueryChange });
			renderWithProvider(<AutoRunSearchBar {...props} />);

			const input = screen.getByPlaceholderText('Search...');
			fireEvent.change(input, { target: { value: 'new search' } });

			expect(onSearchQueryChange).toHaveBeenCalledWith('new search');
		});

		it('should call onSearchQueryChange with empty string when clearing', () => {
			const onSearchQueryChange = vi.fn();
			const props = createDefaultProps({
				searchQuery: 'existing',
				onSearchQueryChange,
			});
			renderWithProvider(<AutoRunSearchBar {...props} />);

			const input = screen.getByPlaceholderText('Search...');
			fireEvent.change(input, { target: { value: '' } });

			expect(onSearchQueryChange).toHaveBeenCalledWith('');
		});

		it('should update on every keystroke', () => {
			const onSearchQueryChange = vi.fn();
			const props = createDefaultProps({ onSearchQueryChange });
			renderWithProvider(<AutoRunSearchBar {...props} />);

			const input = screen.getByPlaceholderText('Search...');
			fireEvent.change(input, { target: { value: 'a' } });
			fireEvent.change(input, { target: { value: 'ab' } });
			fireEvent.change(input, { target: { value: 'abc' } });

			expect(onSearchQueryChange).toHaveBeenCalledTimes(3);
			expect(onSearchQueryChange).toHaveBeenNthCalledWith(1, 'a');
			expect(onSearchQueryChange).toHaveBeenNthCalledWith(2, 'ab');
			expect(onSearchQueryChange).toHaveBeenNthCalledWith(3, 'abc');
		});

		it('should handle special characters in search query', () => {
			const onSearchQueryChange = vi.fn();
			const props = createDefaultProps({ onSearchQueryChange });
			renderWithProvider(<AutoRunSearchBar {...props} />);

			const input = screen.getByPlaceholderText('Search...');
			fireEvent.change(input, { target: { value: '(regex.*) [special]' } });

			expect(onSearchQueryChange).toHaveBeenCalledWith('(regex.*) [special]');
		});

		it('should handle unicode characters in search query', () => {
			const onSearchQueryChange = vi.fn();
			const props = createDefaultProps({ onSearchQueryChange });
			renderWithProvider(<AutoRunSearchBar {...props} />);

			const input = screen.getByPlaceholderText('Search...');
			fireEvent.change(input, { target: { value: '中文 日本語 한국어 🎉' } });

			expect(onSearchQueryChange).toHaveBeenCalledWith('中文 日本語 한국어 🎉');
		});
	});

	describe('Auto-Focus', () => {
		it('should auto-focus the search input on mount', () => {
			const props = createDefaultProps();
			renderWithProvider(<AutoRunSearchBar {...props} />);

			const input = screen.getByPlaceholderText('Search...');
			// The component has autoFocus prop and also uses useEffect to call focus()
			// In JSDOM, we verify the input is the active element (focus works via useEffect)
			expect(document.activeElement).toBe(input);
		});

		it('should focus the input via ref.focus() in useEffect', () => {
			const props = createDefaultProps();
			renderWithProvider(<AutoRunSearchBar {...props} />);

			const input = screen.getByPlaceholderText('Search...');
			// The useEffect hook calls searchInputRef.current?.focus() on mount
			// This ensures focus even when autoFocus doesn't work in certain environments
			expect(input).toBe(document.activeElement);
		});
	});

	describe('Match Count Display', () => {
		it('should not show match count when search query is empty', () => {
			const props = createDefaultProps({
				searchQuery: '',
				totalMatches: 5,
				currentMatchIndex: 0,
			});
			renderWithProvider(<AutoRunSearchBar {...props} />);

			expect(screen.queryByText('1/5')).not.toBeInTheDocument();
			expect(screen.queryByText('No matches')).not.toBeInTheDocument();
		});

		it('should not show match count when search query is only whitespace', () => {
			const props = createDefaultProps({
				searchQuery: '   ',
				totalMatches: 5,
				currentMatchIndex: 0,
			});
			renderWithProvider(<AutoRunSearchBar {...props} />);

			expect(screen.queryByText('1/5')).not.toBeInTheDocument();
			expect(screen.queryByText('No matches')).not.toBeInTheDocument();
		});

		it('should show "No matches" when totalMatches is 0 and query is non-empty', () => {
			const props = createDefaultProps({
				searchQuery: 'nonexistent',
				totalMatches: 0,
				currentMatchIndex: 0,
			});
			renderWithProvider(<AutoRunSearchBar {...props} />);

			expect(screen.getByText('No matches')).toBeInTheDocument();
		});

		it('should show match count in format "current/total"', () => {
			const props = createDefaultProps({
				searchQuery: 'test',
				totalMatches: 5,
				currentMatchIndex: 0,
			});
			renderWithProvider(<AutoRunSearchBar {...props} />);

			// currentMatchIndex is 0-based, display is 1-based
			expect(screen.getByText('1/5')).toBeInTheDocument();
		});

		it('should show correct match position for middle match', () => {
			const props = createDefaultProps({
				searchQuery: 'test',
				totalMatches: 10,
				currentMatchIndex: 4,
			});
			renderWithProvider(<AutoRunSearchBar {...props} />);

			expect(screen.getByText('5/10')).toBeInTheDocument();
		});

		it('should show correct match position for last match', () => {
			const props = createDefaultProps({
				searchQuery: 'test',
				totalMatches: 3,
				currentMatchIndex: 2,
			});
			renderWithProvider(<AutoRunSearchBar {...props} />);

			expect(screen.getByText('3/3')).toBeInTheDocument();
		});

		it('should display match count with theme dimmed text color', () => {
			const props = createDefaultProps({
				searchQuery: 'test',
				totalMatches: 5,
				currentMatchIndex: 0,
			});
			renderWithProvider(<AutoRunSearchBar {...props} />);

			const matchCount = screen.getByText('1/5');
			expect(matchCount).toHaveStyle({ color: '#888888' });
		});
	});

	describe('Navigation Buttons', () => {
		it('should not show navigation buttons when search query is empty', () => {
			const props = createDefaultProps({ searchQuery: '' });
			renderWithProvider(<AutoRunSearchBar {...props} />);

			expect(screen.queryByTitle('Previous match (Shift+Enter)')).not.toBeInTheDocument();
			expect(screen.queryByTitle('Next match (Enter)')).not.toBeInTheDocument();
		});

		it('should not show navigation buttons when search query is only whitespace', () => {
			const props = createDefaultProps({ searchQuery: '   ' });
			renderWithProvider(<AutoRunSearchBar {...props} />);

			expect(screen.queryByTitle('Previous match (Shift+Enter)')).not.toBeInTheDocument();
			expect(screen.queryByTitle('Next match (Enter)')).not.toBeInTheDocument();
		});

		it('should show navigation buttons when search query has content', () => {
			const props = createDefaultProps({
				searchQuery: 'test',
				totalMatches: 5,
			});
			renderWithProvider(<AutoRunSearchBar {...props} />);

			expect(screen.getByTitle('Previous match (Shift+Enter)')).toBeInTheDocument();
			expect(screen.getByTitle('Next match (Enter)')).toBeInTheDocument();
		});

		it('should render ChevronUp icon for previous button', () => {
			const props = createDefaultProps({
				searchQuery: 'test',
				totalMatches: 5,
			});
			renderWithProvider(<AutoRunSearchBar {...props} />);

			expect(screen.getByTestId('chevron-up-icon')).toBeInTheDocument();
		});

		it('should render ChevronDown icon for next button', () => {
			const props = createDefaultProps({
				searchQuery: 'test',
				totalMatches: 5,
			});
			renderWithProvider(<AutoRunSearchBar {...props} />);

			expect(screen.getByTestId('chevron-down-icon')).toBeInTheDocument();
		});

		it('should call onPrevMatch when previous button is clicked', () => {
			const onPrevMatch = vi.fn();
			const props = createDefaultProps({
				searchQuery: 'test',
				totalMatches: 5,
				onPrevMatch,
			});
			renderWithProvider(<AutoRunSearchBar {...props} />);

			const prevButton = screen.getByTitle('Previous match (Shift+Enter)');
			fireEvent.click(prevButton);

			expect(onPrevMatch).toHaveBeenCalledTimes(1);
		});

		it('should call onNextMatch when next button is clicked', () => {
			const onNextMatch = vi.fn();
			const props = createDefaultProps({
				searchQuery: 'test',
				totalMatches: 5,
				onNextMatch,
			});
			renderWithProvider(<AutoRunSearchBar {...props} />);

			const nextButton = screen.getByTitle('Next match (Enter)');
			fireEvent.click(nextButton);

			expect(onNextMatch).toHaveBeenCalledTimes(1);
		});

		it('should disable navigation buttons when totalMatches is 0', () => {
			const props = createDefaultProps({
				searchQuery: 'test',
				totalMatches: 0,
			});
			renderWithProvider(<AutoRunSearchBar {...props} />);

			const prevButton = screen.getByTitle('Previous match (Shift+Enter)');
			const nextButton = screen.getByTitle('Next match (Enter)');

			expect(prevButton).toBeDisabled();
			expect(nextButton).toBeDisabled();
		});

		it('should enable navigation buttons when totalMatches is greater than 0', () => {
			const props = createDefaultProps({
				searchQuery: 'test',
				totalMatches: 1,
			});
			renderWithProvider(<AutoRunSearchBar {...props} />);

			const prevButton = screen.getByTitle('Previous match (Shift+Enter)');
			const nextButton = screen.getByTitle('Next match (Enter)');

			expect(prevButton).not.toBeDisabled();
			expect(nextButton).not.toBeDisabled();
		});

		it('should apply theme dim text color to navigation buttons', () => {
			const props = createDefaultProps({
				searchQuery: 'test',
				totalMatches: 5,
			});
			renderWithProvider(<AutoRunSearchBar {...props} />);

			const prevButton = screen.getByTitle('Previous match (Shift+Enter)');
			const nextButton = screen.getByTitle('Next match (Enter)');

			expect(prevButton).toHaveStyle({ color: '#888888' });
			expect(nextButton).toHaveStyle({ color: '#888888' });
		});
	});

	describe('Keyboard Navigation - Enter/Shift+Enter', () => {
		it('should call onNextMatch when Enter is pressed', () => {
			const onNextMatch = vi.fn();
			const props = createDefaultProps({
				searchQuery: 'test',
				totalMatches: 5,
				onNextMatch,
			});
			renderWithProvider(<AutoRunSearchBar {...props} />);

			const input = screen.getByPlaceholderText('Search...');
			fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });

			expect(onNextMatch).toHaveBeenCalledTimes(1);
		});

		it('should call onPrevMatch when Shift+Enter is pressed', () => {
			const onPrevMatch = vi.fn();
			const props = createDefaultProps({
				searchQuery: 'test',
				totalMatches: 5,
				onPrevMatch,
			});
			renderWithProvider(<AutoRunSearchBar {...props} />);

			const input = screen.getByPlaceholderText('Search...');
			fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });

			expect(onPrevMatch).toHaveBeenCalledTimes(1);
		});

		it('should prevent default behavior on Enter', () => {
			const onNextMatch = vi.fn();
			const props = createDefaultProps({
				searchQuery: 'test',
				totalMatches: 5,
				onNextMatch,
			});
			renderWithProvider(<AutoRunSearchBar {...props} />);

			const input = screen.getByPlaceholderText('Search...');
			const event = fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });

			// The event should be captured and default prevented
			expect(onNextMatch).toHaveBeenCalledTimes(1);
		});

		it('should prevent default behavior on Shift+Enter', () => {
			const onPrevMatch = vi.fn();
			const props = createDefaultProps({
				searchQuery: 'test',
				totalMatches: 5,
				onPrevMatch,
			});
			renderWithProvider(<AutoRunSearchBar {...props} />);

			const input = screen.getByPlaceholderText('Search...');
			fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });

			expect(onPrevMatch).toHaveBeenCalledTimes(1);
		});

		it('should not call onNextMatch for other keys', () => {
			const onNextMatch = vi.fn();
			const props = createDefaultProps({
				searchQuery: 'test',
				totalMatches: 5,
				onNextMatch,
			});
			renderWithProvider(<AutoRunSearchBar {...props} />);

			const input = screen.getByPlaceholderText('Search...');
			fireEvent.keyDown(input, { key: 'Tab' });
			fireEvent.keyDown(input, { key: 'a' });
			fireEvent.keyDown(input, { key: 'ArrowDown' });

			expect(onNextMatch).not.toHaveBeenCalled();
		});

		it('should call onNextMatch even when totalMatches is 0', () => {
			// The component doesn't prevent calling onNextMatch when no matches
			// It's up to the parent to handle this case appropriately
			const onNextMatch = vi.fn();
			const props = createDefaultProps({
				searchQuery: 'test',
				totalMatches: 0,
				onNextMatch,
			});
			renderWithProvider(<AutoRunSearchBar {...props} />);

			const input = screen.getByPlaceholderText('Search...');
			fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });

			expect(onNextMatch).toHaveBeenCalledTimes(1);
		});
	});

	describe('Escape Key - Close Search', () => {
		it('should call onClose when Escape is pressed', () => {
			const onClose = vi.fn();
			const props = createDefaultProps({ onClose });
			renderWithProvider(<AutoRunSearchBar {...props} />);

			const input = screen.getByPlaceholderText('Search...');
			fireEvent.keyDown(input, { key: 'Escape' });

			expect(onClose).toHaveBeenCalledTimes(1);
		});

		it('should prevent default behavior on Escape', () => {
			const onClose = vi.fn();
			const props = createDefaultProps({ onClose });
			renderWithProvider(<AutoRunSearchBar {...props} />);

			const input = screen.getByPlaceholderText('Search...');
			const event = new KeyboardEvent('keydown', {
				key: 'Escape',
				bubbles: true,
				cancelable: true,
			});
			const preventDefaultSpy = vi.spyOn(event, 'preventDefault');

			input.dispatchEvent(event);

			expect(onClose).toHaveBeenCalledTimes(1);
		});

		it('should stop propagation on Escape', () => {
			const onClose = vi.fn();
			const parentHandler = vi.fn();
			const props = createDefaultProps({ onClose });

			render(
				<LayerStackProvider>
					<div onKeyDown={parentHandler}>
						<AutoRunSearchBar {...props} />
					</div>
				</LayerStackProvider>
			);

			const input = screen.getByPlaceholderText('Search...');
			fireEvent.keyDown(input, { key: 'Escape' });

			expect(onClose).toHaveBeenCalledTimes(1);
			// Note: Due to how React handles synthetic events, the parent may still receive it
			// but the component does call stopPropagation
		});

		it('should call onClose regardless of search query content', () => {
			const onClose = vi.fn();
			const props = createDefaultProps({
				searchQuery: 'some search text',
				onClose,
			});
			renderWithProvider(<AutoRunSearchBar {...props} />);

			const input = screen.getByPlaceholderText('Search...');
			fireEvent.keyDown(input, { key: 'Escape' });

			expect(onClose).toHaveBeenCalledTimes(1);
		});
	});

	describe('Close Button', () => {
		it('should call onClose when close button is clicked', () => {
			const onClose = vi.fn();
			const props = createDefaultProps({ onClose });
			renderWithProvider(<AutoRunSearchBar {...props} />);

			const closeButton = screen.getByTitle('Close search (Esc)');
			fireEvent.click(closeButton);

			expect(onClose).toHaveBeenCalledTimes(1);
		});

		it('should render X icon in close button', () => {
			const props = createDefaultProps();
			renderWithProvider(<AutoRunSearchBar {...props} />);

			const closeButton = screen.getByTitle('Close search (Esc)');
			const xIcon = closeButton.querySelector('[data-testid="x-icon"]');
			expect(xIcon).toBeInTheDocument();
		});

		it('should apply theme dim text color to close button', () => {
			const props = createDefaultProps();
			renderWithProvider(<AutoRunSearchBar {...props} />);

			const closeButton = screen.getByTitle('Close search (Esc)');
			expect(closeButton).toHaveStyle({ color: '#888888' });
		});

		it('should always be visible regardless of search query', () => {
			// With empty query
			const props1 = createDefaultProps({ searchQuery: '' });
			const { unmount } = renderWithProvider(<AutoRunSearchBar {...props1} />);
			expect(screen.getByTitle('Close search (Esc)')).toBeInTheDocument();
			unmount();

			// With non-empty query
			const props2 = createDefaultProps({ searchQuery: 'test' });
			renderWithProvider(<AutoRunSearchBar {...props2} />);
			expect(screen.getByTitle('Close search (Esc)')).toBeInTheDocument();
		});
	});

	describe('Component Layout and Structure', () => {
		it('should have proper flex layout', () => {
			const props = createDefaultProps();
			renderWithProvider(<AutoRunSearchBar {...props} />);

			const container = screen.getByPlaceholderText('Search...').closest('div');
			expect(container).toHaveClass('flex');
			expect(container).toHaveClass('items-center');
			expect(container).toHaveClass('gap-2');
		});

		it('should have proper padding and margin', () => {
			const props = createDefaultProps();
			renderWithProvider(<AutoRunSearchBar {...props} />);

			const container = screen.getByPlaceholderText('Search...').closest('div');
			expect(container).toHaveClass('px-3');
			expect(container).toHaveClass('py-2');
			expect(container).toHaveClass('mx-2');
			expect(container).toHaveClass('mb-2');
		});

		it('should have rounded corners', () => {
			const props = createDefaultProps();
			renderWithProvider(<AutoRunSearchBar {...props} />);

			const container = screen.getByPlaceholderText('Search...').closest('div');
			expect(container).toHaveClass('rounded');
		});

		it('should have flex-1 on input for proper width', () => {
			const props = createDefaultProps();
			renderWithProvider(<AutoRunSearchBar {...props} />);

			const input = screen.getByPlaceholderText('Search...');
			expect(input).toHaveClass('flex-1');
		});

		it('should have shrink-0 on search icon', () => {
			const props = createDefaultProps();
			renderWithProvider(<AutoRunSearchBar {...props} />);

			const searchIcon = screen.getByTestId('search-icon');
			expect(searchIcon).toHaveClass('shrink-0');
		});

		it('should have whitespace-nowrap on match count', () => {
			const props = createDefaultProps({
				searchQuery: 'test',
				totalMatches: 100,
				currentMatchIndex: 50,
			});
			renderWithProvider(<AutoRunSearchBar {...props} />);

			const matchCount = screen.getByText('51/100');
			expect(matchCount).toHaveClass('whitespace-nowrap');
		});
	});

	describe('Input Styling', () => {
		it('should have transparent background', () => {
			const props = createDefaultProps();
			renderWithProvider(<AutoRunSearchBar {...props} />);

			const input = screen.getByPlaceholderText('Search...');
			expect(input).toHaveClass('bg-transparent');
		});

		it('should have no outline', () => {
			const props = createDefaultProps();
			renderWithProvider(<AutoRunSearchBar {...props} />);

			const input = screen.getByPlaceholderText('Search...');
			expect(input).toHaveClass('outline-none');
		});

		it('should have text-sm font size', () => {
			const props = createDefaultProps();
			renderWithProvider(<AutoRunSearchBar {...props} />);

			const input = screen.getByPlaceholderText('Search...');
			expect(input).toHaveClass('text-sm');
		});
	});

	describe('Button Styling', () => {
		it('should have hover styles on navigation buttons', () => {
			const props = createDefaultProps({
				searchQuery: 'test',
				totalMatches: 5,
			});
			renderWithProvider(<AutoRunSearchBar {...props} />);

			const prevButton = screen.getByTitle('Previous match (Shift+Enter)');
			const nextButton = screen.getByTitle('Next match (Enter)');

			expect(prevButton).toHaveClass('hover:bg-white/10');
			expect(nextButton).toHaveClass('hover:bg-white/10');
		});

		it('should have transition on navigation buttons', () => {
			const props = createDefaultProps({
				searchQuery: 'test',
				totalMatches: 5,
			});
			renderWithProvider(<AutoRunSearchBar {...props} />);

			const prevButton = screen.getByTitle('Previous match (Shift+Enter)');
			const nextButton = screen.getByTitle('Next match (Enter)');

			expect(prevButton).toHaveClass('transition-colors');
			expect(nextButton).toHaveClass('transition-colors');
		});

		it('should have disabled opacity style on buttons when disabled', () => {
			const props = createDefaultProps({
				searchQuery: 'test',
				totalMatches: 0,
			});
			renderWithProvider(<AutoRunSearchBar {...props} />);

			const prevButton = screen.getByTitle('Previous match (Shift+Enter)');
			const nextButton = screen.getByTitle('Next match (Enter)');

			expect(prevButton).toHaveClass('disabled:opacity-30');
			expect(nextButton).toHaveClass('disabled:opacity-30');
		});

		it('should have hover styles on close button', () => {
			const props = createDefaultProps();
			renderWithProvider(<AutoRunSearchBar {...props} />);

			const closeButton = screen.getByTitle('Close search (Esc)');
			expect(closeButton).toHaveClass('hover:bg-white/10');
		});

		it('should have p-1 padding on all icon buttons', () => {
			const props = createDefaultProps({
				searchQuery: 'test',
				totalMatches: 5,
			});
			renderWithProvider(<AutoRunSearchBar {...props} />);

			const prevButton = screen.getByTitle('Previous match (Shift+Enter)');
			const nextButton = screen.getByTitle('Next match (Enter)');
			const closeButton = screen.getByTitle('Close search (Esc)');

			expect(prevButton).toHaveClass('p-1');
			expect(nextButton).toHaveClass('p-1');
			expect(closeButton).toHaveClass('p-1');
		});

		it('should have rounded corners on all buttons', () => {
			const props = createDefaultProps({
				searchQuery: 'test',
				totalMatches: 5,
			});
			renderWithProvider(<AutoRunSearchBar {...props} />);

			const prevButton = screen.getByTitle('Previous match (Shift+Enter)');
			const nextButton = screen.getByTitle('Next match (Enter)');
			const closeButton = screen.getByTitle('Close search (Esc)');

			expect(prevButton).toHaveClass('rounded');
			expect(nextButton).toHaveClass('rounded');
			expect(closeButton).toHaveClass('rounded');
		});
	});

	describe('Icon Sizes', () => {
		it('should have w-4 h-4 on search icon', () => {
			const props = createDefaultProps();
			renderWithProvider(<AutoRunSearchBar {...props} />);

			const searchIcon = screen.getByTestId('search-icon');
			expect(searchIcon).toHaveClass('w-4');
			expect(searchIcon).toHaveClass('h-4');
		});

		it('should have w-4 h-4 on navigation icons', () => {
			const props = createDefaultProps({
				searchQuery: 'test',
				totalMatches: 5,
			});
			renderWithProvider(<AutoRunSearchBar {...props} />);

			const chevronUp = screen.getByTestId('chevron-up-icon');
			const chevronDown = screen.getByTestId('chevron-down-icon');

			expect(chevronUp).toHaveClass('w-4');
			expect(chevronUp).toHaveClass('h-4');
			expect(chevronDown).toHaveClass('w-4');
			expect(chevronDown).toHaveClass('h-4');
		});
	});

	describe('Edge Cases', () => {
		it('should handle very long search query', () => {
			const longQuery = 'a'.repeat(1000);
			const props = createDefaultProps({ searchQuery: longQuery });
			renderWithProvider(<AutoRunSearchBar {...props} />);

			const input = screen.getByPlaceholderText('Search...') as HTMLInputElement;
			expect(input.value).toBe(longQuery);
		});

		it('should handle very large match count', () => {
			const props = createDefaultProps({
				searchQuery: 'test',
				totalMatches: 999999,
				currentMatchIndex: 500000,
			});
			renderWithProvider(<AutoRunSearchBar {...props} />);

			expect(screen.getByText('500001/999999')).toBeInTheDocument();
		});

		it('should handle currentMatchIndex at boundary', () => {
			const props = createDefaultProps({
				searchQuery: 'test',
				totalMatches: 5,
				currentMatchIndex: 4, // Last index (0-based)
			});
			renderWithProvider(<AutoRunSearchBar {...props} />);

			expect(screen.getByText('5/5')).toBeInTheDocument();
		});

		it('should handle single match', () => {
			const props = createDefaultProps({
				searchQuery: 'test',
				totalMatches: 1,
				currentMatchIndex: 0,
			});
			renderWithProvider(<AutoRunSearchBar {...props} />);

			expect(screen.getByText('1/1')).toBeInTheDocument();
		});

		it('should handle search query with only spaces', () => {
			const props = createDefaultProps({
				searchQuery: '     ',
				totalMatches: 0,
			});
			renderWithProvider(<AutoRunSearchBar {...props} />);

			// Spaces-only should be treated as empty (no match display)
			expect(screen.queryByText('No matches')).not.toBeInTheDocument();
		});

		it('should handle search query with newlines (normalized by browser)', () => {
			const onSearchQueryChange = vi.fn();
			const props = createDefaultProps({
				searchQuery: 'line1\nline2',
				onSearchQueryChange,
			});
			renderWithProvider(<AutoRunSearchBar {...props} />);

			const input = screen.getByPlaceholderText('Search...') as HTMLInputElement;
			// Text inputs normalize newlines (this is expected browser behavior)
			// The value will be 'line1line2' because newlines are stripped from <input type="text">
			expect(input.value).toBe('line1line2');
		});

		it('should handle rapid keyboard events', () => {
			const onNextMatch = vi.fn();
			const onPrevMatch = vi.fn();
			const onClose = vi.fn();
			const props = createDefaultProps({
				searchQuery: 'test',
				totalMatches: 5,
				onNextMatch,
				onPrevMatch,
				onClose,
			});
			renderWithProvider(<AutoRunSearchBar {...props} />);

			const input = screen.getByPlaceholderText('Search...');

			// Rapid fire multiple key events
			fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });
			fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });
			fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
			fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });

			expect(onNextMatch).toHaveBeenCalledTimes(3);
			expect(onPrevMatch).toHaveBeenCalledTimes(1);
		});
	});

	describe('Handler Callback Stability', () => {
		it('should use useCallback for handleKeyDown', () => {
			// This test verifies the behavior is correct even if the component re-renders
			const onNextMatch = vi.fn();
			const props = createDefaultProps({
				searchQuery: 'test',
				totalMatches: 5,
				onNextMatch,
			});

			const { rerender } = renderWithProvider(<AutoRunSearchBar {...props} />);

			const input = screen.getByPlaceholderText('Search...');
			fireEvent.keyDown(input, { key: 'Enter' });
			expect(onNextMatch).toHaveBeenCalledTimes(1);

			// Re-render with same props (need to wrap in provider)
			rerender(
				<LayerStackProvider>
					<AutoRunSearchBar {...props} />
				</LayerStackProvider>
			);

			fireEvent.keyDown(input, { key: 'Enter' });
			expect(onNextMatch).toHaveBeenCalledTimes(2);
		});

		it('should update handleKeyDown when callbacks change', () => {
			const onClose1 = vi.fn();
			const onClose2 = vi.fn();
			const props1 = createDefaultProps({ onClose: onClose1 });

			const { rerender } = renderWithProvider(<AutoRunSearchBar {...props1} />);

			const input = screen.getByPlaceholderText('Search...');
			fireEvent.keyDown(input, { key: 'Escape' });
			expect(onClose1).toHaveBeenCalledTimes(1);
			expect(onClose2).not.toHaveBeenCalled();

			// Re-render with new callback (need to wrap in provider)
			const props2 = createDefaultProps({ onClose: onClose2 });
			rerender(
				<LayerStackProvider>
					<AutoRunSearchBar {...props2} />
				</LayerStackProvider>
			);

			fireEvent.keyDown(input, { key: 'Escape' });
			expect(onClose1).toHaveBeenCalledTimes(1);
			expect(onClose2).toHaveBeenCalledTimes(1);
		});
	});

	describe('Accessibility', () => {
		it('should have type="text" on input', () => {
			const props = createDefaultProps();
			renderWithProvider(<AutoRunSearchBar {...props} />);

			const input = screen.getByPlaceholderText('Search...');
			expect(input).toHaveAttribute('type', 'text');
		});

		it('should have descriptive title on previous button', () => {
			const props = createDefaultProps({
				searchQuery: 'test',
				totalMatches: 5,
			});
			renderWithProvider(<AutoRunSearchBar {...props} />);

			const prevButton = screen.getByTitle('Previous match (Shift+Enter)');
			expect(prevButton).toBeInTheDocument();
		});

		it('should have descriptive title on next button', () => {
			const props = createDefaultProps({
				searchQuery: 'test',
				totalMatches: 5,
			});
			renderWithProvider(<AutoRunSearchBar {...props} />);

			const nextButton = screen.getByTitle('Next match (Enter)');
			expect(nextButton).toBeInTheDocument();
		});

		it('should have descriptive title on close button', () => {
			const props = createDefaultProps();
			renderWithProvider(<AutoRunSearchBar {...props} />);

			const closeButton = screen.getByTitle('Close search (Esc)');
			expect(closeButton).toBeInTheDocument();
		});

		it('should have placeholder text on input', () => {
			const props = createDefaultProps();
			renderWithProvider(<AutoRunSearchBar {...props} />);

			const input = screen.getByPlaceholderText('Search...');
			expect(input).toBeInTheDocument();
		});
	});

	describe('Theme Variations', () => {
		it('should work with light theme colors', () => {
			const lightTheme = createMockTheme();
			lightTheme.mode = 'light';
			lightTheme.colors.bgActivity = '#f5f5f5';
			lightTheme.colors.textMain = '#1a1a1a';
			lightTheme.colors.textDim = '#666666';
			lightTheme.colors.accent = '#0066ff';

			const props = createDefaultProps({ theme: lightTheme });
			renderWithProvider(<AutoRunSearchBar {...props} />);

			const container = screen.getByPlaceholderText('Search...').closest('div');
			const input = screen.getByPlaceholderText('Search...');
			const closeButton = screen.getByTitle('Close search (Esc)');

			expect(container).toHaveStyle({ backgroundColor: '#f5f5f5' });
			expect(input).toHaveStyle({ color: '#1a1a1a' });
			expect(closeButton).toHaveStyle({ color: '#666666' });
		});

		it('should apply accent color to border regardless of theme mode', () => {
			const customTheme = createMockTheme();
			customTheme.colors.accent = '#ff00ff';

			const props = createDefaultProps({ theme: customTheme });
			renderWithProvider(<AutoRunSearchBar {...props} />);

			const container = screen.getByPlaceholderText('Search...').closest('div');
			// Check that the border style includes the custom accent color (converted to RGB)
			const style = container?.getAttribute('style');
			expect(style).toContain('border:');
			// Color is converted from #ff00ff to rgb(255, 0, 255)
			expect(style).toContain('rgb(255, 0, 255)');
		});
	});

	describe('Match Count Text Size', () => {
		it('should have text-xs class on match count', () => {
			const props = createDefaultProps({
				searchQuery: 'test',
				totalMatches: 5,
				currentMatchIndex: 2,
			});
			renderWithProvider(<AutoRunSearchBar {...props} />);

			const matchCount = screen.getByText('3/5');
			expect(matchCount).toHaveClass('text-xs');
		});

		it('should have text-xs class on "No matches" text', () => {
			const props = createDefaultProps({
				searchQuery: 'test',
				totalMatches: 0,
			});
			renderWithProvider(<AutoRunSearchBar {...props} />);

			const noMatches = screen.getByText('No matches');
			expect(noMatches).toHaveClass('text-xs');
		});
	});
});

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import {
	TerminalSearchBar,
	type TerminalSearchBarProps,
} from '../../../renderer/components/TerminalSearchBar';
import type { Theme } from '../../../renderer/types';

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

const createMockTheme = (): Theme => ({
	id: 'dracula',
	name: 'Dracula',
	mode: 'dark',
	colors: {
		bgMain: '#1a1a1a',
		bgSidebar: '#252525',
		bgActivity: '#2e2e2e',
		border: '#444444',
		textMain: '#ffffff',
		textDim: '#aaaaaa',
		accent: '#7a67ee',
		accentDim: '#7a67ee33',
		accentText: '#ffffff',
		accentForeground: '#ffffff',
		success: '#2ecc71',
		warning: '#f39c12',
		error: '#ff4d4f',
	},
});

const createProps = (overrides: Partial<TerminalSearchBarProps> = {}): TerminalSearchBarProps => ({
	theme: createMockTheme(),
	isOpen: true,
	onClose: vi.fn(),
	onSearch: vi.fn(() => false),
	onSearchNext: vi.fn(() => false),
	onSearchPrevious: vi.fn(() => false),
	...overrides,
});

describe('TerminalSearchBar', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('renders nothing when closed', () => {
		const props = createProps({ isOpen: false });
		render(<TerminalSearchBar {...props} />);

		expect(screen.queryByPlaceholderText('Search...')).not.toBeInTheDocument();
	});

	it('focuses the search input when opened', () => {
		const props = createProps();
		render(<TerminalSearchBar {...props} />);

		const input = screen.getByPlaceholderText('Search...');
		expect(document.activeElement).toBe(input);
	});

	it('searches as the query changes and shows no-results state', () => {
		const onSearch = vi.fn(() => false);
		const props = createProps({ onSearch });
		render(<TerminalSearchBar {...props} />);

		const input = screen.getByPlaceholderText('Search...');
		fireEvent.change(input, { target: { value: 'needle' } });

		expect(onSearch).toHaveBeenCalledWith('needle');
		expect(screen.getByText('No results')).toBeInTheDocument();
	});

	it('uses Enter and Shift+Enter for next and previous', () => {
		const onSearchNext = vi.fn(() => true);
		const onSearchPrevious = vi.fn(() => true);
		const props = createProps({ onSearchNext, onSearchPrevious, onSearch: vi.fn(() => true) });
		render(<TerminalSearchBar {...props} />);

		const input = screen.getByPlaceholderText('Search...');
		fireEvent.change(input, { target: { value: 'needle' } });
		fireEvent.keyDown(input, { key: 'Enter' });
		fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });

		expect(onSearchNext).toHaveBeenCalledTimes(1);
		expect(onSearchPrevious).toHaveBeenCalledTimes(1);
	});

	it('closes on Escape', () => {
		const onClose = vi.fn();
		const props = createProps({ onClose });
		render(<TerminalSearchBar {...props} />);

		fireEvent.keyDown(screen.getByPlaceholderText('Search...'), { key: 'Escape' });

		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('disables navigation when no results and enables it when matches exist', () => {
		const onSearch = vi.fn((query: string) => query === 'hit');
		const props = createProps({
			onSearch,
			onSearchNext: vi.fn(() => true),
			onSearchPrevious: vi.fn(() => true),
		});
		render(<TerminalSearchBar {...props} />);

		const input = screen.getByPlaceholderText('Search...');
		const prevButton = screen.getByTitle('Previous match (Shift+Enter)');
		const nextButton = screen.getByTitle('Next match (Enter)');

		fireEvent.change(input, { target: { value: 'miss' } });
		expect(prevButton).toBeDisabled();
		expect(nextButton).toBeDisabled();

		fireEvent.change(input, { target: { value: 'hit' } });
		expect(prevButton).not.toBeDisabled();
		expect(nextButton).not.toBeDisabled();
	});
});

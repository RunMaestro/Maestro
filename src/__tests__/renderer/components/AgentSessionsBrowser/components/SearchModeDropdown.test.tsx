import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SearchModeDropdown } from '../../../../../renderer/components/AgentSessionsBrowser/components/SearchModeDropdown';
import type { SearchMode } from '../../../../../renderer/components/AgentSessionsBrowser/types';

const theme = {
	colors: {
		textDim: '#888',
		textMain: '#fff',
		accent: '#7C3AED',
		bgSidebar: '#1a1a1a',
		border: '#333',
	},
} as any;

function defaultProps(overrides: any = {}) {
	return {
		searchMode: 'all' as SearchMode,
		isOpen: false,
		dropdownRef: { current: null } as any,
		onToggle: vi.fn(),
		onSelect: vi.fn(),
		theme,
		...overrides,
	};
}

describe('SearchModeDropdown', () => {
	it('hides options when isOpen is false', () => {
		render(<SearchModeDropdown {...defaultProps({ isOpen: false })} />);
		expect(screen.queryByText('Title Only')).toBeNull();
	});

	it('renders 4 options when open', () => {
		render(<SearchModeDropdown {...defaultProps({ isOpen: true })} />);
		expect(screen.getByText('Title Only')).toBeTruthy();
		expect(screen.getByText('My Messages')).toBeTruthy();
		expect(screen.getByText('AI Responses')).toBeTruthy();
		expect(screen.getByText('All Content')).toBeTruthy();
	});

	it('calls onSelect with mode when option is clicked', () => {
		const onSelect = vi.fn();
		render(<SearchModeDropdown {...defaultProps({ isOpen: true, onSelect })} />);
		fireEvent.click(screen.getByText('Title Only'));
		expect(onSelect).toHaveBeenCalledWith('title');
	});

	it('calls onToggle when trigger button is clicked', () => {
		const onToggle = vi.fn();
		render(<SearchModeDropdown {...defaultProps({ onToggle })} />);
		const trigger = screen.getAllByRole('button')[0];
		fireEvent.click(trigger);
		expect(onToggle).toHaveBeenCalled();
	});

	it('shows bg-white/10 class on active mode option', () => {
		const { container } = render(
			<SearchModeDropdown {...defaultProps({ isOpen: true, searchMode: 'user' as SearchMode })} />
		);
		expect(container.innerHTML).toContain('bg-white/10');
	});

	it('trigger shows "All" label for all mode', () => {
		const { container } = render(
			<SearchModeDropdown {...defaultProps({ searchMode: 'all' as SearchMode })} />
		);
		const trigger = screen.getAllByRole('button')[0];
		expect(trigger.textContent).toContain('All');
	});

	it('trigger shows "title" label for title mode', () => {
		render(<SearchModeDropdown {...defaultProps({ searchMode: 'title' as SearchMode })} />);
		const trigger = screen.getAllByRole('button')[0];
		expect(trigger.textContent?.toLowerCase()).toContain('title');
	});
});

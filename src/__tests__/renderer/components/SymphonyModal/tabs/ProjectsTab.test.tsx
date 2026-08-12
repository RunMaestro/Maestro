/**
 * Tests for SymphonyModal/tabs/ProjectsTab - search, categories, grid render,
 * loading / error / empty states.
 */
import { describe, it, expect, vi } from 'vitest';
import { createRef } from 'react';
import { render, fireEvent } from '@testing-library/react';

vi.mock('../../../../../renderer/utils/shortcutFormatter', () => ({
	formatShortcutKeys: (keys: string[]) => keys.join('+'),
}));

vi.mock('lucide-react', () => {
	const icon = (name: string) => {
		const C = ({ className }: { className?: string }) => (
			<svg data-testid={`icon-${name}`} className={className} />
		);
		C.displayName = name;
		return C;
	};
	return {
		Search: icon('Search'),
		Loader2: icon('Loader2'),
		AlertCircle: icon('AlertCircle'),
		Music: icon('Music'),
		Hash: icon('Hash'),
		Star: icon('Star'),
	};
});

import { ProjectsTab } from '../../../../../renderer/components/SymphonyModal/tabs/ProjectsTab';
import { mockTheme, makeRepo } from '../_fixtures';

const baseProps = (overrides: Partial<React.ComponentProps<typeof ProjectsTab>> = {}) => ({
	theme: mockTheme,
	isLoading: false,
	error: null,
	filteredRepositories: [makeRepo({ slug: 'a', name: 'a' }), makeRepo({ slug: 'b', name: 'b' })],
	categories: ['developer-tools', 'web-framework'],
	selectedCategory: 'all',
	onCategoryChange: vi.fn(),
	searchQuery: '',
	onSearchChange: vi.fn(),
	selectedTileIndex: 0,
	onSelectRepo: vi.fn(),
	issueCounts: {},
	isLoadingIssueCounts: false,
	onRetry: vi.fn(),
	searchInputRef: createRef<HTMLInputElement>(),
	tileGridRef: createRef<HTMLDivElement>(),
	...overrides,
});

describe('ProjectsTab', () => {
	it('renders 6 skeleton tiles while loading', () => {
		const { container } = render(<ProjectsTab {...baseProps({ isLoading: true })} />);
		expect(container.querySelectorAll('.animate-pulse').length).toBe(6);
	});

	it('renders the error state with Retry button', () => {
		const onRetry = vi.fn();
		const { getByText } = render(
			<ProjectsTab {...baseProps({ error: 'oops', onRetry, filteredRepositories: [] })} />
		);
		expect(getByText('oops')).toBeTruthy();
		fireEvent.click(getByText('Retry'));
		expect(onRetry).toHaveBeenCalledTimes(1);
	});

	it('renders an empty-state message with search hint', () => {
		const { getByText, rerender } = render(
			<ProjectsTab {...baseProps({ filteredRepositories: [], searchQuery: 'foo' })} />
		);
		expect(getByText('No repositories match your search')).toBeTruthy();
		rerender(<ProjectsTab {...baseProps({ filteredRepositories: [], searchQuery: '' })} />);
		expect(getByText('No repositories available')).toBeTruthy();
	});

	it('renders one tile per filtered repository', () => {
		const { getByText } = render(
			<ProjectsTab
				{...baseProps({
					filteredRepositories: [
						makeRepo({ slug: 'x', name: 'X' }),
						makeRepo({ slug: 'y', name: 'Y' }),
					],
				})}
			/>
		);
		expect(getByText('X')).toBeTruthy();
		expect(getByText('Y')).toBeTruthy();
	});

	it('fires onCategoryChange when "All" is clicked', () => {
		const onCategoryChange = vi.fn();
		const { getByText } = render(<ProjectsTab {...baseProps({ onCategoryChange })} />);
		fireEvent.click(getByText('All'));
		expect(onCategoryChange).toHaveBeenCalledWith('all');
	});

	it('fires onCategoryChange when a category button is clicked', () => {
		const onCategoryChange = vi.fn();
		const { getAllByText } = render(<ProjectsTab {...baseProps({ onCategoryChange })} />);
		const matches = getAllByText('Developer Tools');
		// The category-bar entry is a <button>; the tile-card entry is a <span>.
		const button = matches.find(
			(el) => el.closest('button')?.tagName === 'BUTTON' && el.parentElement?.tagName === 'BUTTON'
		);
		expect(button).toBeTruthy();
		fireEvent.click(button!);
		expect(onCategoryChange).toHaveBeenCalledWith('developer-tools');
	});

	it('fires onSearchChange when the search input is typed in', () => {
		const onSearchChange = vi.fn();
		const { container } = render(<ProjectsTab {...baseProps({ onSearchChange })} />);
		const input = container.querySelector('input')!;
		fireEvent.change(input, { target: { value: 'maestro' } });
		expect(onSearchChange).toHaveBeenCalledWith('maestro');
	});

	it('fires onSelectRepo when a tile is clicked', () => {
		const onSelectRepo = vi.fn();
		const { getByText } = render(
			<ProjectsTab
				{...baseProps({
					onSelectRepo,
					filteredRepositories: [makeRepo({ slug: 'pickme', name: 'pickme' })],
				})}
			/>
		);
		fireEvent.click(getByText('pickme'));
		expect(onSelectRepo).toHaveBeenCalledTimes(1);
		expect(onSelectRepo.mock.calls[0][0].slug).toBe('pickme');
	});

	it('shows the footer counter and loading spinner while issue counts load', () => {
		const { getByText, getByTestId } = render(
			<ProjectsTab {...baseProps({ isLoadingIssueCounts: true })} />
		);
		expect(getByText(/2 repositories/)).toBeTruthy();
		expect(getByTestId('icon-Loader2')).toBeTruthy();
	});

	it('renders the shortcut hint in the footer', () => {
		const { getByText } = render(<ProjectsTab {...baseProps()} />);
		expect(getByText(/Meta\+Shift\[\] tabs/)).toBeTruthy();
	});
});

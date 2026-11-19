import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { MarketplaceBrowseTab } from '../../../../../renderer/components/MarketplaceModal/components';
import { makeManifest, makePlaybook, mockTheme } from '../_fixtures';

const baseProps = (overrides: Partial<React.ComponentProps<typeof MarketplaceBrowseTab>> = {}) => {
	const compatible = makePlaybook({ id: 'compatible', title: 'Compatible' });
	const incompatible = makePlaybook({
		id: 'incompatible',
		title: 'Incompatible',
		minMaestroVersion: '99.0.0',
	});
	const filteredPlaybooks = [compatible, incompatible];

	return {
		theme: mockTheme,
		manifest: makeManifest(filteredPlaybooks),
		categories: ['All', 'Development', 'Security'],
		selectedCategory: 'All',
		onCategoryChange: vi.fn(),
		searchQuery: '',
		onSearchChange: vi.fn(),
		filteredPlaybooks,
		compatiblePlaybooks: [compatible],
		incompatiblePlaybooks: [incompatible],
		selectedTileIndex: 0,
		isLoading: false,
		error: null,
		runningVersion: '1.0.0',
		health: {},
		mostPopularIds: new Set<string>(),
		sort: 'default' as const,
		onSortChange: vi.fn(),
		onRefresh: vi.fn(),
		onSelectPlaybook: vi.fn(),
		searchInputRef: createRef<HTMLInputElement>(),
		gridContainerRef: createRef<HTMLDivElement>(),
		...overrides,
	};
};

describe('MarketplaceBrowseTab', () => {
	it('renders loading skeletons', () => {
		const { container } = render(<MarketplaceBrowseTab {...baseProps({ isLoading: true })} />);
		expect(container.querySelectorAll('.animate-pulse')).toHaveLength(6);
	});

	it('renders error state and retries', () => {
		const onRefresh = vi.fn();
		const { getByText } = render(
			<MarketplaceBrowseTab {...baseProps({ error: 'Network down', onRefresh })} />
		);

		expect(getByText('Failed to load marketplace')).toBeTruthy();
		expect(getByText('Network down')).toBeTruthy();
		fireEvent.click(getByText('Try Again'));
		expect(onRefresh).toHaveBeenCalledTimes(1);
	});

	it('renders search and no-playbooks empty states', () => {
		const { getByText, rerender } = render(
			<MarketplaceBrowseTab
				{...baseProps({
					filteredPlaybooks: [],
					compatiblePlaybooks: [],
					incompatiblePlaybooks: [],
					searchQuery: 'missing',
				})}
			/>
		);
		expect(getByText('No results found')).toBeTruthy();

		rerender(
			<MarketplaceBrowseTab
				{...baseProps({
					filteredPlaybooks: [],
					compatiblePlaybooks: [],
					incompatiblePlaybooks: [],
					searchQuery: '',
				})}
			/>
		);
		expect(getByText('No playbooks available')).toBeTruthy();
	});

	it('fires category, search, Escape focus, and tile selection callbacks', () => {
		const onCategoryChange = vi.fn();
		const onSearchChange = vi.fn();
		const onSelectPlaybook = vi.fn();
		const gridRef = createRef<HTMLDivElement>();
		const { getByText, getByPlaceholderText } = render(
			<MarketplaceBrowseTab
				{...baseProps({
					onCategoryChange,
					onSearchChange,
					onSelectPlaybook,
					gridContainerRef: gridRef,
				})}
			/>
		);

		fireEvent.click(getByText('Security').closest('button')!);
		expect(onCategoryChange).toHaveBeenCalledWith('Security');

		const input = getByPlaceholderText('Search playbooks...');
		fireEvent.change(input, { target: { value: 'audit' } });
		expect(onSearchChange).toHaveBeenCalledWith('audit');

		fireEvent.keyDown(input, { key: 'Escape' });
		expect(document.activeElement).toBe(gridRef.current);

		fireEvent.click(getByText('Compatible'));
		expect(onSelectPlaybook).toHaveBeenCalledTimes(1);
		expect(onSelectPlaybook.mock.calls[0][0].id).toBe('compatible');
	});

	it('renders category counts, compatible section, incompatible divider, and footer hints', () => {
		const { getByRole, getByText } = render(<MarketplaceBrowseTab {...baseProps()} />);

		expect(getByRole('button', { name: /All\s*\(2\)/ })).toBeTruthy();
		expect(getByText('Compatible')).toBeTruthy();
		expect(getByText('Incompatible')).toBeTruthy();
		expect(getByText('Requires a newer Maestro')).toBeTruthy();
		expect(getByText('Use arrow keys to navigate, Enter to select')).toBeTruthy();
		expect(getByText('search')).toBeTruthy();
	});

	describe('health figures', () => {
		const figures = {
			compatible: {
				installs_30d: 90,
				runs_30d: 300,
				success_rate_30d: 0.4,
				recent_failures: 6,
			},
		};

		it('hides the sort control and the badges when the server has no figures', () => {
			const { queryByTestId } = render(<MarketplaceBrowseTab {...baseProps()} />);
			expect(queryByTestId('marketplace-sort')).toBeNull();
			expect(queryByTestId('playbook-tile-popular-badge')).toBeNull();
			expect(queryByTestId('playbook-tile-broken-badge')).toBeNull();
		});

		it('shows the sort control and passes the figures to the tiles', () => {
			const onSortChange = vi.fn();
			const { getByTestId } = render(
				<MarketplaceBrowseTab
					{...baseProps({
						health: figures,
						mostPopularIds: new Set(['compatible']),
						onSortChange,
					})}
				/>
			);

			expect(getByTestId('marketplace-sort')).toBeTruthy();
			expect(getByTestId('playbook-tile-popular-badge').textContent).toBe('Most popular');
			expect(getByTestId('playbook-tile-broken-badge').textContent).toBe('Recently broken');

			fireEvent.click(getByTestId('marketplace-sort-popular'));
			expect(onSortChange).toHaveBeenCalledWith('popular');
		});
	});
});

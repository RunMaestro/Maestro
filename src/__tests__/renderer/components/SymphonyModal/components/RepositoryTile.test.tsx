/**
 * Tests for SymphonyModal/components/RepositoryTile - tile display, selection
 * highlight, scrollIntoView reaction, issue-count badge variants, skeleton.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';

vi.mock('lucide-react', () => {
	const icon = (name: string) => {
		const C = ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
			<svg data-testid={`icon-${name}`} className={className} style={style} />
		);
		C.displayName = name;
		return C;
	};
	return { Hash: icon('Hash'), Star: icon('Star') };
});

import {
	RepositoryTile,
	RepositoryTileSkeleton,
} from '../../../../../renderer/components/SymphonyModal/components/RepositoryTile';
import { mockTheme, makeRepo } from '../_fixtures';

const scrollIntoView = vi.fn();

beforeEach(() => {
	scrollIntoView.mockReset();
	Element.prototype.scrollIntoView = scrollIntoView;
});

describe('RepositoryTileSkeleton', () => {
	it('renders a card-shaped skeleton', () => {
		const { container } = render(<RepositoryTileSkeleton theme={mockTheme} />);
		expect(container.querySelector('.animate-pulse')).toBeTruthy();
	});
});

describe('RepositoryTile', () => {
	it('renders repo name, description, stars, and maintainer', () => {
		const { getByText, getByTestId } = render(
			<RepositoryTile
				repo={makeRepo({ stars: 1500, description: 'A great tool', maintainer: { name: 'alice' } })}
				theme={mockTheme}
				isSelected={false}
				onSelect={() => {}}
				issueCount={null}
			/>
		);
		expect(getByText('example')).toBeTruthy();
		expect(getByText('A great tool')).toBeTruthy();
		expect(getByText('alice')).toBeTruthy();
		expect(getByText('1.5K')).toBeTruthy();
		expect(getByTestId('icon-Star')).toBeTruthy();
	});

	it('shows "View Issues" when issueCount is null (not yet loaded)', () => {
		const { getByText } = render(
			<RepositoryTile
				repo={makeRepo()}
				theme={mockTheme}
				isSelected={false}
				onSelect={() => {}}
				issueCount={null}
			/>
		);
		expect(getByText('View Issues')).toBeTruthy();
	});

	it('renders singular "View 1 Issue" and plural "View N Issues"', () => {
		const { getByText, rerender } = render(
			<RepositoryTile
				repo={makeRepo()}
				theme={mockTheme}
				isSelected={false}
				onSelect={() => {}}
				issueCount={1}
			/>
		);
		expect(getByText(/View 1 Issue/)).toBeTruthy();

		rerender(
			<RepositoryTile
				repo={makeRepo()}
				theme={mockTheme}
				isSelected={false}
				onSelect={() => {}}
				issueCount={3}
			/>
		);
		expect(getByText(/View 3 Issues/)).toBeTruthy();
	});

	it('renders "No Issues" dim badge when issueCount === 0', () => {
		const { getByText } = render(
			<RepositoryTile
				repo={makeRepo()}
				theme={mockTheme}
				isSelected={false}
				onSelect={() => {}}
				issueCount={0}
			/>
		);
		expect(getByText('No Issues')).toBeTruthy();
	});

	it('applies the ring class when isSelected is true', () => {
		const { container } = render(
			<RepositoryTile
				repo={makeRepo()}
				theme={mockTheme}
				isSelected={true}
				onSelect={() => {}}
				issueCount={null}
			/>
		);
		expect(container.querySelector('button.ring-2')).toBeTruthy();
	});

	it('calls scrollIntoView when isSelected flips to true', () => {
		const { rerender } = render(
			<RepositoryTile
				repo={makeRepo()}
				theme={mockTheme}
				isSelected={false}
				onSelect={() => {}}
				issueCount={null}
			/>
		);
		expect(scrollIntoView).not.toHaveBeenCalled();
		rerender(
			<RepositoryTile
				repo={makeRepo()}
				theme={mockTheme}
				isSelected={true}
				onSelect={() => {}}
				issueCount={null}
			/>
		);
		expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', behavior: 'smooth' });
	});

	it('fires onSelect when the tile is clicked', () => {
		const onSelect = vi.fn();
		const { container } = render(
			<RepositoryTile
				repo={makeRepo()}
				theme={mockTheme}
				isSelected={false}
				onSelect={onSelect}
				issueCount={null}
			/>
		);
		fireEvent.click(container.querySelector('button')!);
		expect(onSelect).toHaveBeenCalledTimes(1);
	});

	it('omits the stars badge when repo.stars is nullish', () => {
		const { queryByTestId } = render(
			<RepositoryTile
				repo={makeRepo({ stars: undefined })}
				theme={mockTheme}
				isSelected={false}
				onSelect={() => {}}
				issueCount={null}
			/>
		);
		expect(queryByTestId('icon-Star')).toBeNull();
	});
});

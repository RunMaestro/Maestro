/**
 * Tests for EntityTile - the shared tile behind the Usage Dashboard's card grids.
 *
 * The agent grid and the tab grid both render this, so a regression here breaks
 * two surfaces at once. The border states are the subtle part: selected beats
 * hovered beats dashed beats default, and getting that precedence wrong makes a
 * worktree agent look unselected while it is the active drill-down.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { EntityTile } from '../../../../renderer/components/UsageDashboard/EntityTile';
import { mockTheme } from '../../../helpers/mockTheme';

vi.mock('lucide-react', () => ({}));

const baseProps = {
	theme: mockTheme,
	testId: 'tile',
	title: 'Alpha',
	stats: [{ label: 'Queries', value: '7', testId: 'tile-queries' }],
	animationIndex: 0,
	ariaLabel: 'Alpha, 7 queries',
};

describe('EntityTile', () => {
	it('renders the title, stats, and accessible label', () => {
		render(<EntityTile {...baseProps} />);

		const tile = screen.getByTestId('tile');
		expect(tile).toHaveAttribute('aria-label', 'Alpha, 7 queries');
		expect(screen.getByText('Alpha')).toBeInTheDocument();
		expect(screen.getByTestId('tile-queries')).toHaveTextContent('7');
		expect(screen.getByText('Queries')).toBeInTheDocument();
	});

	it('stays a plain group until a click handler is supplied', () => {
		render(<EntityTile {...baseProps} />);

		const tile = screen.getByTestId('tile');
		expect(tile).toHaveAttribute('role', 'group');
		expect(tile).not.toHaveAttribute('tabindex');
		expect(tile.dataset.clickable).toBeUndefined();
	});

	it('becomes a focusable button and fires on click, Enter, and Space', () => {
		const onClick = vi.fn();
		render(<EntityTile {...baseProps} onClick={onClick} />);

		const tile = screen.getByTestId('tile');
		expect(tile).toHaveAttribute('role', 'button');
		expect(tile).toHaveAttribute('tabindex', '0');

		fireEvent.click(tile);
		fireEvent.keyDown(tile, { key: 'Enter' });
		fireEvent.keyDown(tile, { key: ' ' });
		expect(onClick).toHaveBeenCalledTimes(3);

		// A key the tile does not own must not activate it.
		fireEvent.keyDown(tile, { key: 'a' });
		expect(onClick).toHaveBeenCalledTimes(3);
	});

	describe('border states', () => {
		it('uses a plain border by default and dashes when asked', () => {
			const { rerender } = render(<EntityTile {...baseProps} />);
			expect(screen.getByTestId('tile').style.border).toContain('solid');

			rerender(<EntityTile {...baseProps} isDashed />);
			expect(screen.getByTestId('tile').style.border).toContain('dashed');
		});

		it('promotes to a thick accent border when selected, overriding the dash', () => {
			render(<EntityTile {...baseProps} isDashed isSelected />);

			const tile = screen.getByTestId('tile');
			expect(tile.style.border).toContain('2px');
			expect(tile.style.border).not.toContain('dashed');
			expect(tile.dataset.selected).toBe('true');
		});

		it('promotes on hover only while clickable, and never outranks selection', () => {
			const { rerender } = render(<EntityTile {...baseProps} isDashed onClick={vi.fn()} />);
			const tile = screen.getByTestId('tile');

			fireEvent.mouseEnter(tile);
			expect(tile.style.border).toContain('1px');
			expect(tile.style.border).not.toContain('dashed');

			fireEvent.mouseLeave(tile);
			expect(tile.style.border).toContain('dashed');

			rerender(<EntityTile {...baseProps} isDashed isSelected onClick={vi.fn()} />);
			fireEvent.mouseEnter(screen.getByTestId('tile'));
			expect(screen.getByTestId('tile').style.border).toContain('2px');
		});
	});

	describe('status dot', () => {
		it('is omitted when no color is given', () => {
			render(<EntityTile {...baseProps} />);
			expect(screen.queryByTestId('tile-status-dot')).toBeNull();
		});

		it('animates only when explicitly pulsing', () => {
			const { rerender } = render(<EntityTile {...baseProps} statusColor="#00ff00" />);
			expect(screen.getByTestId('tile-status-dot').style.animation).toBe('');

			rerender(<EntityTile {...baseProps} statusColor="#00ff00" statusPulsing />);
			expect(screen.getByTestId('tile-status-dot').style.animation).toContain('status-pulse');
		});
	});

	it('renders badges and the corner age, highlighting the age on request', () => {
		const { rerender } = render(
			<EntityTile
				{...baseProps}
				badges={[{ label: 'WT', testId: 'tile-wt' }]}
				age="3mo"
				ageTitle="Created yesterday"
			/>
		);

		expect(screen.getByTestId('tile-wt')).toHaveTextContent('WT');
		expect(screen.getByTestId('tile-age')).toHaveTextContent('3mo');
		expect(screen.getByTestId('tile-age')).toHaveAttribute('title', 'Created yesterday');
		expect(screen.getByTestId('tile-age').dataset.highlighted).toBeUndefined();

		rerender(<EntityTile {...baseProps} age="3mo" ageHighlighted />);
		expect(screen.getByTestId('tile-age').dataset.highlighted).toBe('true');
	});

	it('renders the subtitle only when provided', () => {
		const { rerender } = render(<EntityTile {...baseProps} subtitleTestId="tile-branch" />);
		expect(screen.queryByTestId('tile-branch')).toBeNull();

		rerender(<EntityTile {...baseProps} subtitle="feat/thing" subtitleTestId="tile-branch" />);
		expect(screen.getByTestId('tile-branch')).toHaveTextContent('feat/thing');
	});

	it('flags the highlighted stat so the sort key is visible on every tile', () => {
		render(
			<EntityTile
				{...baseProps}
				stats={[
					{ label: 'Queries', value: '7', testId: 'tile-queries', highlighted: true },
					{ label: 'Tabs', value: '2', testId: 'tile-tabs' },
					{ label: 'Auto %', value: '—', testId: 'tile-auto', muted: true },
				]}
			/>
		);

		expect(screen.getByTestId('tile-queries').dataset.highlighted).toBe('true');
		expect(screen.getByTestId('tile-tabs').dataset.highlighted).toBeUndefined();
		// A muted stat renders dim rather than in the main text color, so an
		// absent value never reads as a real zero.
		expect(screen.getByTestId('tile-auto').style.color).toBe(hexToRgb(mockTheme.colors.textDim));
		expect(screen.getByTestId('tile-tabs').style.color).toBe(hexToRgb(mockTheme.colors.textMain));
	});

	// A highlighted-but-muted stat must stay dim: accenting an absent value
	// would advertise it as the sort key's winner.
	it('keeps a muted stat dim even when it is the highlighted one', () => {
		render(
			<EntityTile
				{...baseProps}
				stats={[
					{ label: 'Auto %', value: '—', testId: 'tile-auto', highlighted: true, muted: true },
				]}
			/>
		);

		expect(screen.getByTestId('tile-auto').style.color).toBe(hexToRgb(mockTheme.colors.textDim));
	});

	it('staggers the enter animation by 60ms per tile', () => {
		render(<EntityTile {...baseProps} animationIndex={3} />);

		const tile = screen.getByTestId('tile');
		expect(tile.style.animationDelay).toBe('180ms');
		expect(tile.className).toContain('card-enter');
	});

	// Both grids can render far more tiles than the stagger was designed for.
	// Uncapped, the 100th agent card would sit blank for six seconds and a
	// full tab list for far longer, so the ramp plateaus instead.
	it('caps the stagger so a large grid does not leave late tiles blank', () => {
		const { rerender } = render(<EntityTile {...baseProps} animationIndex={12} />);
		expect(screen.getByTestId('tile').style.animationDelay).toBe('720ms');

		rerender(<EntityTile {...baseProps} animationIndex={375} />);
		expect(screen.getByTestId('tile').style.animationDelay).toBe('720ms');
	});

	describe('size variants', () => {
		const LONG_STATS = [
			{ label: 'Queries', value: '848' },
			{ label: 'Time', value: '142h 5m' },
			{ label: 'Tokens', value: '220.7M' },
			{ label: 'Cost', value: '$187.18' },
		];
		const renderLarge = () => render(<EntityTile {...baseProps} size="lg" stats={LONG_STATS} />);

		it('defaults to the standard size', () => {
			render(<EntityTile {...baseProps} />);

			expect(screen.getByTestId('tile')).toHaveAttribute('data-size', 'default');
		});

		it('marks a large tile so the group grid is distinguishable', () => {
			render(<EntityTile {...baseProps} size="lg" />);

			expect(screen.getByTestId('tile')).toHaveAttribute('data-size', 'lg');
		});

		it("lays a large tile's stats out as a grid rather than one flex row", () => {
			// Four stats in a single flex row is what ran a group's tokens and cost
			// together as "79.5M$65.99". The grid wraps instead of overlapping.
			render(
				<EntityTile
					{...baseProps}
					size="lg"
					stats={[
						{ label: 'Queries', value: '848' },
						{ label: 'Time', value: '96h 57m' },
						{ label: 'Tokens', value: '79.5M' },
						{ label: 'Cost', value: '$65.99' },
					]}
				/>
			);

			const statRow = screen.getByText('Queries').parentElement!.parentElement!;
			expect(statRow.className).toContain('grid');
			expect(statRow.className).not.toContain('flex items-end gap-3');
		});

		it('gives large stat columns enough floor width to not clip a value', () => {
			// The column, not the card, is what a stat value has to fit into: a
			// narrower floor clipped "142h 5m" to "142h 5…" inside a roomy tile.
			renderLarge();

			const statRow = screen.getByText('Queries').parentElement!.parentElement!;
			expect(statRow.className).toContain('minmax(104px,1fr)');
		});

		it('keeps the default tile on the compact flex stat row', () => {
			render(
				<EntityTile
					{...baseProps}
					stats={[
						{ label: 'Queries', value: '5' },
						{ label: 'Tabs', value: '2' },
					]}
				/>
			);

			const statRow = screen.getByText('Queries').parentElement!.parentElement!;
			expect(statRow.className).toContain('flex');
		});
	});
});

/** jsdom reports colors as `rgb(r, g, b)`; convert a theme hex for comparison. */
function hexToRgb(hex: string): string {
	const v = hex.replace('#', '');
	const [r, g, b] = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16));
	return `rgb(${r}, ${g}, ${b})`;
}

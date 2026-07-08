import { render, screen, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	SessionActivityGraph,
	type ActivityEntry,
} from '../../renderer/components/SessionActivityGraph';
import type { Theme } from '../../renderer/types';

const testTheme: Theme = {
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#1e1e1e',
		bgSidebar: '#252526',
		bgActivity: '#333333',
		textMain: '#d4d4d4',
		textDim: '#808080',
		accent: '#007acc',
		accentForeground: '#ffffff',
		border: '#404040',
		error: '#f14c4c',
		warning: '#cca700',
		success: '#89d185',
		info: '#3794ff',
		textInverse: '#000000',
	},
};

const now = new Date('2026-05-13T16:00:00.000Z').getTime();

const createEntry = (hoursAgo: number): ActivityEntry => ({
	timestamp: now - hoursAgo * 60 * 60 * 1000,
});

const renderGraph = (
	overrides: Partial<React.ComponentProps<typeof SessionActivityGraph>> = {}
) => {
	const onLookbackChange = vi.fn();
	const onBarClick = vi.fn();
	const result = render(
		<SessionActivityGraph
			entries={[createEntry(0.5), createEntry(3.5)]}
			theme={testTheme}
			lookbackHours={24}
			onLookbackChange={onLookbackChange}
			onBarClick={onBarClick}
			{...overrides}
		/>
	);

	const root = result.container.firstElementChild as HTMLElement;
	const getBars = () =>
		Array.from(result.container.querySelectorAll('.cursor-pointer')) as HTMLElement[];

	return {
		...result,
		root,
		getBars,
		onLookbackChange,
		onBarClick,
	};
};

describe('SessionActivityGraph', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(now);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('renders the lookback summary title and hourly axis labels', () => {
		const { root, getBars } = renderGraph({ className: 'activity-test' });

		expect(root).toHaveClass('activity-test');
		expect(root).toHaveAttribute('title', '24 hours: 2 sessions (right-click to change)');
		expect(getBars()).toHaveLength(24);
		expect(screen.getByText('24h')).toBeInTheDocument();
		expect(screen.getByText('16h')).toBeInTheDocument();
		expect(screen.getByText('8h')).toBeInTheDocument();
		expect(screen.getByText('0h')).toBeInTheDocument();
	});

	it('uses a singular session label when exactly one entry is visible', () => {
		const { root } = renderGraph({ entries: [createEntry(1)] });

		expect(root).toHaveAttribute('title', '24 hours: 1 session (right-click to change)');
	});

	it('ignores entries outside the selected lookback window', () => {
		const { root } = renderGraph({ entries: [createEntry(1), createEntry(30)] });

		expect(root).toHaveAttribute('title', '24 hours: 1 session (right-click to change)');
	});

	it('shows a hover tooltip and calls onBarClick for non-empty buckets', () => {
		const { container, getBars, onBarClick } = renderGraph();
		const bars = getBars();

		fireEvent.mouseEnter(bars[23]);

		expect(screen.getByText('Sessions')).toBeInTheDocument();
		expect(screen.getByText('1')).toBeInTheDocument();
		expect(bars[23]).toHaveStyle({ transform: 'scaleX(1.5)' });
		expect(container.querySelector('.pointer-events-none')).toHaveStyle({
			transform: 'translateX(-100%)',
		});

		fireEvent.click(bars[23]);

		expect(onBarClick).toHaveBeenCalledTimes(1);
		expect(onBarClick.mock.calls[0][0]).toBeLessThan(onBarClick.mock.calls[0][1]);

		fireEvent.mouseLeave(bars[23]);

		expect(screen.queryByText('Sessions')).not.toBeInTheDocument();
	});

	it('positions hover tooltips on the left, middle, and right of the graph', () => {
		const { container, getBars } = renderGraph();
		const bars = getBars();
		const getTooltip = () => container.querySelector('.pointer-events-none') as HTMLElement;

		fireEvent.mouseEnter(bars[0]);
		expect(getTooltip()).toHaveStyle({ transform: 'translateX(0)' });

		fireEvent.mouseEnter(bars[12]);
		expect(getTooltip()).toHaveStyle({ transform: 'translateX(-50%)' });

		fireEvent.mouseEnter(bars[23]);
		expect(getTooltip()).toHaveStyle({ transform: 'translateX(-100%)' });
	});

	it('does not call onBarClick for empty buckets or when no handler is provided', () => {
		const { getBars, onBarClick } = renderGraph();

		fireEvent.click(getBars()[0]);

		expect(onBarClick).not.toHaveBeenCalled();

		const withoutHandler = renderGraph({ onBarClick: undefined });
		fireEvent.click(withoutHandler.getBars()[23]);

		expect(withoutHandler.onBarClick).not.toHaveBeenCalled();
	});

	it('opens the lookback context menu and selects a new period', async () => {
		const { root, onLookbackChange } = renderGraph();

		fireEvent.contextMenu(root, { clientX: 100, clientY: 120 });

		expect(screen.getByText('Lookback Period')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: '24 hours' })).toHaveStyle({
			color: testTheme.colors.accent,
		});

		fireEvent.click(screen.getByRole('button', { name: '1 week' }));

		expect(onLookbackChange).toHaveBeenCalledWith(168);
		expect(screen.queryByText('Lookback Period')).not.toBeInTheDocument();
	});

	it('closes the lookback context menu on document click', () => {
		const { root } = renderGraph();

		fireEvent.contextMenu(root, { clientX: 100, clientY: 120 });
		expect(screen.getByText('Lookback Period')).toBeInTheDocument();

		fireEvent.click(document);

		expect(screen.queryByText('Lookback Period')).not.toBeInTheDocument();
	});

	it('renders day-based labels for week lookbacks', () => {
		const { getBars } = renderGraph({
			lookbackHours: 168,
			entries: [createEntry(12), createEntry(48)],
		});

		expect(screen.getByText('7d')).toBeInTheDocument();
		expect(screen.getByText('3d')).toBeInTheDocument();
		expect(screen.getByText('Now')).toBeInTheDocument();

		fireEvent.mouseEnter(getBars()[26]);
		expect(screen.getByText('May 13')).toBeInTheDocument();
	});

	it('renders long-period labels for monthly lookbacks', () => {
		const { getBars } = renderGraph({
			lookbackHours: 720,
			entries: [createEntry(24), createEntry(200)],
		});

		expect(screen.getByText('Now')).toBeInTheDocument();
		expect(screen.getAllByText(/Apr|May/).length).toBeGreaterThan(0);

		fireEvent.mouseEnter(getBars()[0]);
		expect(screen.getByText(/Apr 13 - Apr 14/)).toBeInTheDocument();
	});

	it('renders all-time labels from the earliest entry and falls back when empty', () => {
		const allTime = renderGraph({
			lookbackHours: null,
			entries: [
				{ timestamp: new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString() },
				createEntry(1),
			],
		});

		expect(allTime.root).toHaveAttribute('title', 'All time: 2 sessions (right-click to change)');
		expect(screen.getByText('Now')).toBeInTheDocument();
		expect(screen.getAllByText(/May/).length).toBeGreaterThan(0);

		allTime.rerender(
			<SessionActivityGraph
				entries={[]}
				theme={testTheme}
				lookbackHours={null}
				onLookbackChange={allTime.onLookbackChange}
			/>
		);

		expect(allTime.root).toHaveAttribute('title', 'All time: 0 sessions (right-click to change)');
	});

	it('falls back to the all-time configuration for unknown lookback values', () => {
		const { root } = renderGraph({ lookbackHours: 999 });

		expect(root).toHaveAttribute('title', 'All time: 2 sessions (right-click to change)');
	});
});

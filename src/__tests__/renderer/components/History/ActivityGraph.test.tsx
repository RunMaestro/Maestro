import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { ActivityGraph } from '../../../../renderer/components/History';
import type { Theme, HistoryEntry, HistoryEntryType } from '../../../../renderer/types';

// Create mock theme
const mockTheme: Theme = {
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#1e1e1e',
		bgSidebar: '#252526',
		bgActivity: '#333333',
		textMain: '#ffffff',
		textDim: '#808080',
		accent: '#007acc',
		border: '#404040',
		success: '#4ec9b0',
		warning: '#dcdcaa',
		error: '#f14c4c',
		scrollbar: '#404040',
		scrollbarHover: '#808080',
	},
};

// Create mock history entry factory
const createMockEntry = (overrides: Partial<HistoryEntry> = {}): HistoryEntry => ({
	id: `entry-${Math.random().toString(36).substring(7)}`,
	type: 'AUTO' as HistoryEntryType,
	timestamp: Date.now(),
	summary: 'Test summary',
	projectPath: '/test/project',
	...overrides,
});

describe('ActivityGraph', () => {
	const NOW = new Date('2025-06-15T12:00:00Z').getTime();

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('renders with empty entries', () => {
		const { container } = render(
			<ActivityGraph
				entries={[]}
				theme={mockTheme}
				lookbackHours={168}
				onLookbackChange={vi.fn()}
			/>
		);
		// Should render the graph container
		expect(container.querySelector('.flex-1')).toBeInTheDocument();
	});

	it('renders bars for entries in the lookback window', () => {
		const entries = [
			createMockEntry({ timestamp: NOW - 1 * 60 * 60 * 1000 }), // 1 hour ago
			createMockEntry({ timestamp: NOW - 2 * 60 * 60 * 1000 }), // 2 hours ago
			createMockEntry({ type: 'USER', timestamp: NOW - 3 * 60 * 60 * 1000 }), // 3 hours ago
		];

		const { container } = render(
			<ActivityGraph
				entries={entries}
				theme={mockTheme}
				lookbackHours={168}
				onLookbackChange={vi.fn()}
			/>
		);

		// Should render bucket bars (28 buckets for 1 week lookback)
		const bars = container.querySelectorAll('.flex-1.min-w-0.flex.flex-col.justify-end');
		expect(bars.length).toBe(28);
	});

	it('shows tooltip on mouse enter over a bar', () => {
		const entries = [
			createMockEntry({ timestamp: NOW - 1 * 60 * 60 * 1000, type: 'AUTO' }),
		];

		const { container } = render(
			<ActivityGraph
				entries={entries}
				theme={mockTheme}
				lookbackHours={24}
				onLookbackChange={vi.fn()}
			/>
		);

		// Find bars and hover over the last one (where the entry should be)
		const bars = container.querySelectorAll('.flex-1.min-w-0.flex.flex-col.justify-end');
		expect(bars.length).toBeGreaterThan(0);

		// Hover over the last bar (most recent bucket)
		const lastBar = bars[bars.length - 2]; // second to last for 1 hour ago in 24h lookback
		fireEvent.mouseEnter(lastBar);

		// Tooltip should appear with Auto/User labels
		expect(screen.getByText('Auto')).toBeInTheDocument();
		expect(screen.getByText('User')).toBeInTheDocument();
	});

	it('hides tooltip on mouse leave', () => {
		const entries = [
			createMockEntry({ timestamp: NOW - 1 * 60 * 60 * 1000 }),
		];

		const { container } = render(
			<ActivityGraph
				entries={entries}
				theme={mockTheme}
				lookbackHours={24}
				onLookbackChange={vi.fn()}
			/>
		);

		const bars = container.querySelectorAll('.flex-1.min-w-0.flex.flex-col.justify-end');
		const lastBar = bars[bars.length - 1];

		fireEvent.mouseEnter(lastBar);
		expect(screen.getByText('Auto')).toBeInTheDocument();

		fireEvent.mouseLeave(lastBar);
		expect(screen.queryByText('Auto')).not.toBeInTheDocument();
	});

	it('calls onBarClick when a bar with entries is clicked', () => {
		const onBarClick = vi.fn();
		const entries = [
			createMockEntry({ timestamp: NOW - 30 * 60 * 1000 }), // 30 minutes ago
		];

		const { container } = render(
			<ActivityGraph
				entries={entries}
				theme={mockTheme}
				lookbackHours={24}
				onLookbackChange={onBarClick}
				onBarClick={onBarClick}
			/>
		);

		// Find the bar that contains the entry (last bucket for most recent)
		const bars = container.querySelectorAll('.flex-1.min-w-0.flex.flex-col.justify-end');
		const lastBar = bars[bars.length - 1];
		fireEvent.click(lastBar);

		// onBarClick should be called with bucket time range
		expect(onBarClick).toHaveBeenCalledWith(
			expect.any(Number),
			expect.any(Number)
		);
	});

	it('does not call onBarClick for empty bars', () => {
		const onBarClick = vi.fn();

		const { container } = render(
			<ActivityGraph
				entries={[]}
				theme={mockTheme}
				lookbackHours={24}
				onLookbackChange={vi.fn()}
				onBarClick={onBarClick}
			/>
		);

		// Click on the first bar (should be empty)
		const bars = container.querySelectorAll('.flex-1.min-w-0.flex.flex-col.justify-end');
		fireEvent.click(bars[0]);

		expect(onBarClick).not.toHaveBeenCalled();
	});

	it('shows context menu on right-click', () => {
		render(
			<ActivityGraph
				entries={[]}
				theme={mockTheme}
				lookbackHours={168}
				onLookbackChange={vi.fn()}
			/>
		);

		const graphContainer = screen.getByTitle(/right-click to change/i);
		fireEvent.contextMenu(graphContainer);

		// Context menu should show lookback options
		expect(screen.getByText('Lookback Period')).toBeInTheDocument();
		expect(screen.getByText('24 hours')).toBeInTheDocument();
		expect(screen.getByText('1 week')).toBeInTheDocument();
		expect(screen.getByText('All time')).toBeInTheDocument();
	});

	it('calls onLookbackChange when a context menu option is selected', () => {
		const onLookbackChange = vi.fn();

		render(
			<ActivityGraph
				entries={[]}
				theme={mockTheme}
				lookbackHours={168}
				onLookbackChange={onLookbackChange}
			/>
		);

		const graphContainer = screen.getByTitle(/right-click to change/i);
		fireEvent.contextMenu(graphContainer);

		// Click "24 hours" option
		fireEvent.click(screen.getByText('24 hours'));

		expect(onLookbackChange).toHaveBeenCalledWith(24);
	});

	it('highlights the current lookback option in context menu', () => {
		render(
			<ActivityGraph
				entries={[]}
				theme={mockTheme}
				lookbackHours={168}
				onLookbackChange={vi.fn()}
			/>
		);

		const graphContainer = screen.getByTitle(/right-click to change/i);
		fireEvent.contextMenu(graphContainer);

		// The "1 week" option (168 hours) should be accented
		const weekOption = screen.getByText('1 week');
		expect(weekOption).toHaveStyle({ color: mockTheme.colors.accent });
	});

	it('groups AUTO and USER entries into separate counts per bucket', () => {
		const entries = [
			createMockEntry({ type: 'AUTO', timestamp: NOW - 30 * 60 * 1000 }),
			createMockEntry({ type: 'AUTO', timestamp: NOW - 45 * 60 * 1000 }),
			createMockEntry({ type: 'USER', timestamp: NOW - 35 * 60 * 1000 }),
		];

		const { container } = render(
			<ActivityGraph
				entries={entries}
				theme={mockTheme}
				lookbackHours={24}
				onLookbackChange={vi.fn()}
			/>
		);

		// Hover over the last bucket to see tooltip counts
		const bars = container.querySelectorAll('.flex-1.min-w-0.flex.flex-col.justify-end');
		const lastBar = bars[bars.length - 1];
		fireEvent.mouseEnter(lastBar);

		// Should show auto: 2 and user: 1 in the tooltip
		const autoCount = screen.getByText('2');
		const userCount = screen.getByText('1');
		expect(autoCount).toBeInTheDocument();
		expect(userCount).toBeInTheDocument();
	});

	it('renders axis labels for 24-hour lookback', () => {
		render(
			<ActivityGraph
				entries={[]}
				theme={mockTheme}
				lookbackHours={24}
				onLookbackChange={vi.fn()}
			/>
		);

		expect(screen.getByText('24h')).toBeInTheDocument();
		expect(screen.getByText('0h')).toBeInTheDocument();
	});

	it('renders axis labels for week lookback', () => {
		render(
			<ActivityGraph
				entries={[]}
				theme={mockTheme}
				lookbackHours={168}
				onLookbackChange={vi.fn()}
			/>
		);

		expect(screen.getByText('7d')).toBeInTheDocument();
		expect(screen.getByText('Now')).toBeInTheDocument();
	});

	it('handles all-time lookback (null hours)', () => {
		const entries = [
			createMockEntry({ timestamp: NOW - 30 * 24 * 60 * 60 * 1000 }), // 30 days ago
			createMockEntry({ timestamp: NOW - 1 * 60 * 60 * 1000 }), // 1 hour ago
		];

		const { container } = render(
			<ActivityGraph
				entries={entries}
				theme={mockTheme}
				lookbackHours={null}
				onLookbackChange={vi.fn()}
			/>
		);

		// Should render 24 buckets (all-time default)
		const bars = container.querySelectorAll('.flex-1.min-w-0.flex.flex-col.justify-end');
		expect(bars.length).toBe(24);

		// Should show "Now" axis label
		expect(screen.getByText('Now')).toBeInTheDocument();
	});

	it('displays title attribute with summary info', () => {
		const entries = [
			createMockEntry({ type: 'AUTO', timestamp: NOW - 1 * 60 * 60 * 1000 }),
			createMockEntry({ type: 'USER', timestamp: NOW - 2 * 60 * 60 * 1000 }),
		];

		render(
			<ActivityGraph
				entries={entries}
				theme={mockTheme}
				lookbackHours={168}
				onLookbackChange={vi.fn()}
			/>
		);

		// Title should summarize: "1 week: 1 auto, 1 user (right-click to change)"
		const graphContainer = screen.getByTitle(/1 auto, 1 user/);
		expect(graphContainer).toBeInTheDocument();
	});
});

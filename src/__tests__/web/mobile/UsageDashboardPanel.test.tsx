/**
 * Tests for UsageDashboardPanel component.
 *
 * Focused on the Phase 3 Task 3.2 tiered-grid responsiveness change:
 * Summary Cards stack 1-column on phone, 2 on tablet (>=600px), 3 on
 * desktop (>=960px). Also covers the load/error/empty gates so future
 * edits to the data flow don't silently regress the render tree.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { UsageDashboardPanel } from '../../../web/mobile/UsageDashboardPanel';

const mockColors = {
	accent: '#8b5cf6',
	textMain: '#f8f8f2',
	textDim: '#6272a4',
	bgMain: '#282a36',
	bgSidebar: '#21222c',
	border: '#44475a',
	success: '#50fa7b',
	warning: '#ffb86c',
	error: '#ff5555',
};

vi.mock('../../../web/components/ThemeProvider', () => ({
	useThemeColors: () => mockColors,
	useTheme: () => ({ isDark: true }),
}));

interface UsageDashboardData {
	totalTokensIn: number;
	totalTokensOut: number;
	totalCost: number;
	sessionBreakdown: Array<{
		sessionId: string;
		sessionName: string;
		tokensIn: number;
		tokensOut: number;
		cost: number;
	}>;
	dailyUsage: Array<{
		date: string;
		tokensIn: number;
		tokensOut: number;
		cost: number;
	}>;
}

function makeData(overrides: Partial<UsageDashboardData> = {}): UsageDashboardData {
	return {
		totalTokensIn: 12_500,
		totalTokensOut: 4_300,
		totalCost: 1.23,
		sessionBreakdown: [
			{
				sessionId: 'sess-1',
				sessionName: 'Test Session',
				tokensIn: 10_000,
				tokensOut: 3_000,
				cost: 0.9,
			},
		],
		dailyUsage: [{ date: '2026-04-20', tokensIn: 10_000, tokensOut: 3_000, cost: 0.9 }],
		...overrides,
	};
}

function makeSendRequest(data: UsageDashboardData | Error) {
	return vi.fn(async () => {
		if (data instanceof Error) throw data;
		return { data };
	});
}

describe('UsageDashboardPanel', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	// The panel routes data through sendRequest and flips between
	// loading / error / empty / populated states. These guardrails keep the
	// render contract stable while we focus on the Task 3.2 grid behaviour.
	describe('data flow gates', () => {
		it('shows loading state on initial mount', async () => {
			const sendRequest = makeSendRequest(makeData());
			render(<UsageDashboardPanel onClose={vi.fn()} sendRequest={sendRequest} />);

			expect(screen.getByText('Loading usage data...')).toBeInTheDocument();

			// Flush the pending fetch so we don't leak an act() warning.
			await waitFor(() => expect(sendRequest).toHaveBeenCalled());
		});

		it('shows error state when sendRequest rejects', async () => {
			const sendRequest = makeSendRequest(new Error('boom'));
			render(<UsageDashboardPanel onClose={vi.fn()} sendRequest={sendRequest} />);

			await waitFor(() => {
				expect(screen.getByText('Failed to load usage data')).toBeInTheDocument();
			});
		});

		it('shows empty state when totals are all zero', async () => {
			const sendRequest = makeSendRequest(
				makeData({
					totalTokensIn: 0,
					totalTokensOut: 0,
					totalCost: 0,
					dailyUsage: [],
					sessionBreakdown: [],
				})
			);
			render(<UsageDashboardPanel onClose={vi.fn()} sendRequest={sendRequest} />);

			await waitFor(() => {
				expect(screen.getByText('No usage data available')).toBeInTheDocument();
			});
		});

		it('renders summary-card values once data loads', async () => {
			const sendRequest = makeSendRequest(makeData());
			render(<UsageDashboardPanel onClose={vi.fn()} sendRequest={sendRequest} />);

			await waitFor(() => {
				expect(screen.getByText('Tokens In')).toBeInTheDocument();
				expect(screen.getByText('Tokens Out')).toBeInTheDocument();
				expect(screen.getByText('Cost')).toBeInTheDocument();
				expect(screen.getByText('$1.23')).toBeInTheDocument();
			});
		});
	});

	// Task 3.2 shipped the Summary Cards as a Tailwind tiered grid keyed off
	// min-[600px] (tablet) and min-[960px] (desktop), matching BREAKPOINTS in
	// `web/mobile/constants.ts`. jsdom can't evaluate media queries, so we
	// assert the utility strings land on the container — the browser applies
	// them per viewport. A swap back to flex or to Tailwind's default sm/md/lg
	// would surface here.
	describe('summary-card tiered grid (Task 3.2)', () => {
		it('container carries phone / tablet / desktop grid utilities', async () => {
			const sendRequest = makeSendRequest(makeData());
			render(<UsageDashboardPanel onClose={vi.fn()} sendRequest={sendRequest} />);

			const cardLabel = await screen.findByText('Tokens In');
			// Summary card wrapper → grid cell → grid container.
			const gridContainer = cardLabel.parentElement?.parentElement as HTMLElement;

			expect(gridContainer).toBeTruthy();
			expect(gridContainer).toHaveClass(
				'grid',
				'grid-cols-1',
				'min-[600px]:grid-cols-2',
				'min-[960px]:grid-cols-3',
				'gap-[10px]',
				'mb-[20px]'
			);
		});

		it('does not fall back to horizontal-scroll flex layout', async () => {
			const sendRequest = makeSendRequest(makeData());
			render(<UsageDashboardPanel onClose={vi.fn()} sendRequest={sendRequest} />);

			const cardLabel = await screen.findByText('Tokens In');
			const gridContainer = cardLabel.parentElement?.parentElement as HTMLElement;

			// Pre-3.2 layout used inline flex + overflow-x scroll + scroll-snap.
			// Those styles must NOT come back with the grid in place.
			expect(gridContainer.style.display).not.toBe('flex');
			expect(gridContainer.style.overflowX).toBe('');
			expect(gridContainer.style.scrollSnapType).toBe('');
		});

		it('renders exactly three summary cards as grid children', async () => {
			const sendRequest = makeSendRequest(makeData());
			render(<UsageDashboardPanel onClose={vi.fn()} sendRequest={sendRequest} />);

			const cardLabel = await screen.findByText('Tokens In');
			const gridContainer = cardLabel.parentElement?.parentElement as HTMLElement;

			expect(gridContainer.children).toHaveLength(3);
		});
	});

	describe('close control', () => {
		it('invokes onClose when close button is clicked', async () => {
			const onClose = vi.fn();
			const sendRequest = makeSendRequest(makeData());
			render(<UsageDashboardPanel onClose={onClose} sendRequest={sendRequest} />);

			// Wait for load so we don't race with initial render.
			await screen.findByText('Tokens In');

			const closeBtn = screen.getByRole('button', { name: 'Close' });
			await act(async () => {
				closeBtn.click();
			});

			expect(onClose).toHaveBeenCalledTimes(1);
		});
	});
});

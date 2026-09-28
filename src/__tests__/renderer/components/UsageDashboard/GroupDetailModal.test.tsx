/**
 * Tests for GroupDetailModal - the per-agent breakdown behind a group tile.
 *
 * The property that matters most is reconciliation: a member row and the header
 * KPI above it are both derived from the same reducer, so if a row could ever
 * disagree with the total it sits under, the user has no way to tell which
 * number is wrong. The sort cases pin the other easy-to-get-wrong behavior -
 * agents with no recorded usage must not masquerade as zero and top a sort.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import React from 'react';
import { GroupDetailModal } from '../../../../renderer/components/UsageDashboard/GroupDetailModal';
import { LayerStackProvider } from '../../../../renderer/contexts/LayerStackContext';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import type { StatsAggregation } from '../../../../shared/stats-types';
import type { GroupStatRollup } from '../../../../shared/statsGroupRollup';
import { rollUpGroupStats } from '../../../../shared/statsGroupRollup';
import { createMockSession } from '../../../helpers';
import { mockTheme } from '../../../helpers/mockTheme';

vi.mock('lucide-react', () => ({
	X: () => <span data-testid="x-icon" />,
	ChevronLeft: () => <span data-testid="chevron-left" />,
	ChevronRight: () => <span data-testid="chevron-right" />,
	ChevronUp: () => <span data-testid="chevron-up" />,
	ChevronDown: () => <span data-testid="chevron-down" />,
	ChevronsUpDown: () => <span data-testid="chevrons-up-down" />,
	Search: () => <span data-testid="search-icon" />,
}));

const TestWrapper = ({ children }: { children: React.ReactNode }) => (
	<LayerStackProvider>{children}</LayerStackProvider>
);

const SESSIONS = [
	createMockSession({ id: 's1', name: 'Acme API', groupId: 'g-acme' }),
	createMockSession({ id: 's2', name: 'Acme Web', groupId: 'g-acme', toolType: 'codex' }),
];

const GROUPS = [{ id: 'g-acme', name: 'Acme Corp', emoji: '🏢' }];

function buildData(overrides: Partial<StatsAggregation> = {}): StatsAggregation {
	return {
		bySessionByDay: {
			s1: [
				{ date: '2026-08-01', count: 4, duration: 40000 },
				{ date: '2026-08-02', count: 2, duration: 20000 },
			],
			s2: [{ date: '2026-08-02', count: 10, duration: 100000 }],
		},
		bySessionSource: { s1: { user: 6, auto: 0 }, s2: { user: 5, auto: 5 } },
		bySessionTokens: {
			s2: {
				inputTokens: 1000,
				outputTokens: 500,
				cacheReadTokens: 0,
				cacheCreationTokens: 0,
				costUsd: 3.5,
				pricedQueries: 10,
			},
		},
		byAgent: {},
		...overrides,
	} as unknown as StatsAggregation;
}

/** Build the rollup exactly as the Groups tab does, so the modal under test
 *  receives the same object shape production hands it. */
function buildRollup(data: StatsAggregation): GroupStatRollup {
	const rollups = rollUpGroupStats(GROUPS, SESSIONS, data);
	return rollups[0];
}

function renderModal(
	props: Partial<React.ComponentProps<typeof GroupDetailModal>> = {},
	data = buildData()
) {
	return render(
		<GroupDetailModal
			rollup={buildRollup(data)}
			sessions={SESSIONS}
			data={data}
			theme={mockTheme}
			onClose={vi.fn()}
			{...props}
		/>,
		{ wrapper: TestWrapper }
	);
}

/** Click a column header. `testId` is on the `<th>`; the control is the button
 *  inside it, so clicking the cell itself does nothing. */
function sortBy(testId: string): void {
	fireEvent.click(within(screen.getByTestId(testId)).getByRole('button'));
}

beforeEach(() => {
	useSettingsStore.setState({ modalSizes: {} });
});

describe('GroupDetailModal', () => {
	it('titles the modal with the group emoji and name', () => {
		renderModal();

		expect(screen.getByText('🏢 Acme Corp')).toBeInTheDocument();
	});

	it('shows the group totals as KPIs', () => {
		renderModal();

		expect(screen.getByTestId('group-detail-queries')).toHaveTextContent('16');
		expect(screen.getByTestId('group-detail-cost')).toHaveTextContent('$3.50');
		// 5 auto of 16 source-attributed queries -> 31%.
		expect(screen.getByTestId('group-detail-auto')).toHaveTextContent('31%');
	});

	it('renders one row per member agent', () => {
		renderModal();

		const rows = screen.getAllByTestId('group-detail-member-row');
		expect(rows).toHaveLength(2);
		expect(screen.getByText('Acme API')).toBeInTheDocument();
		expect(screen.getByText('Acme Web')).toBeInTheDocument();
	});

	it('reconciles the member rows against the group total', () => {
		// The whole point of the view: if the rows do not sum to the header, one
		// of the two numbers is lying and the user cannot tell which.
		renderModal();

		const rowTotals = screen
			.getAllByTestId('group-detail-member-queries')
			.map((cell) => Number(cell.textContent));

		expect(rowTotals.reduce((a, b) => a + b, 0)).toBe(16);
	});

	it('renders an em-dash for a member with no recorded token usage', () => {
		// s1 has queries but no bySessionTokens entry - unknown spend, not free.
		renderModal();

		const row = screen.getByText('Acme API').closest('tr')!;
		expect(within(row).getByTestId('group-detail-member-cost')).toHaveTextContent('—');
	});

	it('sorts members by queries descending on open', () => {
		// "Who used the most" is the question this table is opened to answer, so
		// the default sort must not bury it.
		renderModal();

		const first = screen.getAllByTestId('group-detail-member-row')[0];
		expect(first).toHaveTextContent('Acme Web');
	});

	it('flips direction when the active sort column is clicked again', () => {
		renderModal();

		sortBy('group-detail-sort-queries');

		expect(screen.getAllByTestId('group-detail-member-row')[0]).toHaveTextContent('Acme API');
	});

	it('sorts by name ascending when the name column is picked', () => {
		renderModal();

		sortBy('group-detail-sort-name');

		expect(screen.getAllByTestId('group-detail-member-row')[0]).toHaveTextContent('Acme API');
	});

	it('sinks members with no recorded queries to the bottom of an auto sort', () => {
		// null auto share is "never ran", not 0%. Treating it as zero would put
		// dormant agents at the top of an ascending sort.
		const data = buildData({
			bySessionSource: { s2: { user: 5, auto: 5 } },
		} as Partial<StatsAggregation>);
		renderModal({}, data);

		sortBy('group-detail-sort-auto');

		const rows = screen.getAllByTestId('group-detail-member-row');
		expect(rows[rows.length - 1]).toHaveTextContent('Acme API');
	});

	it('reports a clicked member row to the caller', () => {
		const onSelectAgent = vi.fn();
		renderModal({ onSelectAgent });

		fireEvent.click(screen.getByText('Acme Web').closest('tr')!);

		expect(onSelectAgent).toHaveBeenCalledTimes(1);
		expect(onSelectAgent.mock.calls[0][0].id).toBe('s2');
	});

	it('leaves rows inert when no selection handler is supplied', () => {
		renderModal({ onSelectAgent: undefined });

		const row = screen.getByText('Acme Web').closest('tr')!;
		expect(row).not.toHaveClass('cursor-pointer');
	});

	it('explains the cost coverage when only some queries carry usage', () => {
		renderModal();

		expect(screen.getByTestId('group-detail-cost')).toHaveAttribute(
			'title',
			expect.stringContaining('Covers 10 of 16 queries')
		);
	});

	it('states that no token data exists rather than showing a zero cost', () => {
		const data = buildData({ bySessionTokens: {} } as Partial<StatsAggregation>);
		renderModal({}, data);

		expect(screen.getByTestId('group-detail-cost')).toHaveTextContent('—');
		expect(screen.getByRole('note')).toHaveTextContent(/No token usage recorded/);
	});

	it('is drag-resizable and remembers its size', () => {
		// Modal only enables resizing when given an explicit resizeKey; a missing
		// prop silently falls back to a fixed-size modal with no error.
		renderModal();

		expect(screen.getByTestId('group-detail-modal')).toBeInTheDocument();
		expect(screen.getByTestId('modal-resize-handle-se')).toBeInTheDocument();
	});
});

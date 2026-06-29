/**
 * Tests for the shared output-widget library (src/renderer/components/widgets).
 *
 * Verifies the presentational widgets render their prop data deterministically:
 * - StatCard: label, formatted value, displayValue override, caption, sparkline
 * - StatCardGrid: lays out one card per datum, nothing when empty
 * - SectionCard: title, icon, action slot, body children
 * - ActivityTimeline: stacked bars per bucket, empty state, legend
 * - TypeBreakdown: center total, per-slice counts + percentages, zero-total
 * - AgentActivityBars: sort desc, top-N cap, overflow row, empty state
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Activity } from 'lucide-react';
import {
	StatCard,
	StatCardGrid,
	SectionCard,
	ActivityTimeline,
	TypeBreakdown,
	AgentActivityBars,
	SuccessFailureWidget,
} from '../../../../renderer/components/widgets';
import type { TimelineBucket, DonutSlice, BarDatum } from '../../../../renderer/components/widgets';
import { mockTheme } from '../../../helpers/mockTheme';

describe('StatCard', () => {
	it('renders label and a formatted value', () => {
		render(<StatCard theme={mockTheme} label="Total Entries" value={1500} />);
		expect(screen.getByText('Total Entries')).toBeInTheDocument();
		// formatNumber(1500) => "1.5K"
		expect(screen.getByText('1.5K')).toBeInTheDocument();
	});

	it('prefers displayValue over the numeric value when provided', () => {
		render(
			<StatCard theme={mockTheme} label="Generation Time" value={5000} displayValue="5.00s" />
		);
		expect(screen.getByText('5.00s')).toBeInTheDocument();
		expect(screen.queryByText('5K')).not.toBeInTheDocument();
	});

	it('renders an optional caption', () => {
		render(
			<StatCard theme={mockTheme} label="Auto vs User" value={10} caption="60% auto · 40% user" />
		);
		expect(screen.getByText('60% auto · 40% user')).toBeInTheDocument();
	});

	it('renders a sparkline when a non-empty trend is supplied', () => {
		render(<StatCard theme={mockTheme} label="Trend" value={3} trend={[1, 2, 3]} />);
		expect(screen.getByTestId('sparkline')).toBeInTheDocument();
	});

	it('omits the sparkline when no trend is supplied', () => {
		render(<StatCard theme={mockTheme} label="No Trend" value={3} />);
		expect(screen.queryByTestId('sparkline')).not.toBeInTheDocument();
		expect(screen.queryByTestId('sparkline-empty')).not.toBeInTheDocument();
	});
});

describe('StatCardGrid', () => {
	it('renders one card per datum', () => {
		render(
			<StatCardGrid
				theme={mockTheme}
				cards={[
					{ label: 'A', value: 1 },
					{ label: 'B', value: 2 },
					{ label: 'C', value: 3 },
				]}
			/>
		);
		expect(screen.getByText('A')).toBeInTheDocument();
		expect(screen.getByText('B')).toBeInTheDocument();
		expect(screen.getByText('C')).toBeInTheDocument();
	});

	it('renders nothing when there are no cards', () => {
		const { container } = render(<StatCardGrid theme={mockTheme} cards={[]} />);
		expect(container).toBeEmptyDOMElement();
	});
});

describe('SectionCard', () => {
	it('renders the title, an icon, an action slot, and the body', () => {
		render(
			<SectionCard
				theme={mockTheme}
				title="Activity Timeline"
				icon={Activity}
				action={<span>badge</span>}
			>
				<div data-testid="section-body">content</div>
			</SectionCard>
		);
		expect(screen.getByText('Activity Timeline')).toBeInTheDocument();
		expect(screen.getByText('badge')).toBeInTheDocument();
		expect(screen.getByTestId('section-body')).toBeInTheDocument();
	});
});

describe('ActivityTimeline', () => {
	const buckets: TimelineBucket[] = [
		{ auto: 2, user: 1, cue: 0 },
		{ auto: 0, user: 3, cue: 1 },
	];

	it('renders a column per bucket with a per-bucket tooltip', () => {
		render(<ActivityTimeline theme={mockTheme} buckets={buckets} />);
		expect(screen.getByTitle('Auto 2 · User 1 · Cue 0')).toBeInTheDocument();
		expect(screen.getByTitle('Auto 0 · User 3 · Cue 1')).toBeInTheDocument();
	});

	it('renders the AUTO/USER/CUE legend by default', () => {
		render(<ActivityTimeline theme={mockTheme} buckets={buckets} />);
		expect(screen.getByText('User')).toBeInTheDocument();
		expect(screen.getByText('Auto')).toBeInTheDocument();
		expect(screen.getByText('Cue')).toBeInTheDocument();
	});

	it('shows an empty state when all buckets are zero', () => {
		render(<ActivityTimeline theme={mockTheme} buckets={[{ auto: 0, user: 0, cue: 0 }]} />);
		expect(screen.getByText('No activity in this window')).toBeInTheDocument();
	});
});

describe('TypeBreakdown', () => {
	const slices: DonutSlice[] = [
		{ label: 'User', value: 30, color: '#1111ff' },
		{ label: 'Auto', value: 60, color: '#ffaa00' },
		{ label: 'Cue', value: 10, color: '#06b6d4' },
	];

	it('renders the center total and per-slice counts with percentages', () => {
		render(<TypeBreakdown theme={mockTheme} slices={slices} />);
		expect(screen.getByText('100')).toBeInTheDocument(); // total
		expect(screen.getByText('60')).toBeInTheDocument(); // auto count
		expect(screen.getByText('60%')).toBeInTheDocument(); // auto percentage
		expect(screen.getByText('30%')).toBeInTheDocument();
		expect(screen.getByText('10%')).toBeInTheDocument();
	});

	it('renders 0% for every slice when the total is zero', () => {
		render(
			<TypeBreakdown
				theme={mockTheme}
				slices={[
					{ label: 'User', value: 0, color: '#1111ff' },
					{ label: 'Auto', value: 0, color: '#ffaa00' },
				]}
			/>
		);
		expect(screen.getAllByText('0%')).toHaveLength(2);
	});
});

describe('AgentActivityBars', () => {
	it('sorts agents descending and renders each row with its count', () => {
		const data: BarDatum[] = [
			{ label: 'beta', value: 5 },
			{ label: 'alpha', value: 12 },
		];
		render(<AgentActivityBars theme={mockTheme} data={data} />);
		expect(screen.getByText('alpha')).toBeInTheDocument();
		expect(screen.getByText('12')).toBeInTheDocument();
		expect(screen.getByText('5')).toBeInTheDocument();
	});

	it('caps at top-N and summarizes the remainder in an overflow row', () => {
		const data: BarDatum[] = Array.from({ length: 10 }, (_, i) => ({
			label: `agent-${i}`,
			value: 10 - i, // 10, 9, 8, ... 1
		}));
		render(<AgentActivityBars theme={mockTheme} data={data} topN={8} />);
		// 10 agents, top 8 shown, 2 collapsed (values 2 + 1 = 3).
		expect(screen.getByText('+2 more agents')).toBeInTheDocument();
		expect(screen.getByText('agent-0')).toBeInTheDocument(); // highest
		expect(screen.queryByText('agent-9')).not.toBeInTheDocument(); // in overflow
	});

	it('shows an empty state when there is no agent activity', () => {
		render(<AgentActivityBars theme={mockTheme} data={[]} />);
		expect(screen.getByText('No agent activity in this window')).toBeInTheDocument();
	});
});

describe('SuccessFailureWidget', () => {
	it('renders the success-rate headline and per-outcome counts/percentages', () => {
		render(<SuccessFailureWidget theme={mockTheme} successCount={80} failureCount={20} />);
		// 80 / (80 + 20) = 80% success, 20% failure.
		expect(screen.getAllByText('80%').length).toBeGreaterThanOrEqual(1);
		expect(screen.getByText('20%')).toBeInTheDocument();
		expect(screen.getByText('Success')).toBeInTheDocument();
		expect(screen.getByText('Failure')).toBeInTheDocument();
		expect(screen.getByText('80')).toBeInTheDocument(); // success count
		expect(screen.getByText('20')).toBeInTheDocument(); // failure count
	});

	it('rounds the success rate to a whole percentage', () => {
		render(<SuccessFailureWidget theme={mockTheme} successCount={1} failureCount={2} />);
		// 1 / 3 = 33.33% -> 33% (shown in both the headline and the success
		// legend row), failure 67% (legend only).
		expect(screen.getAllByText('33%').length).toBeGreaterThanOrEqual(1);
		expect(screen.getByText('67%')).toBeInTheDocument();
	});

	it('shows an empty state when there are no recorded outcomes', () => {
		render(<SuccessFailureWidget theme={mockTheme} successCount={0} failureCount={0} />);
		expect(screen.getByText('No success/failure outcomes in this window')).toBeInTheDocument();
	});
});

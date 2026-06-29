/**
 * Tests for the shared output-widget library (src/renderer/components/widgets).
 *
 * Verifies the presentational widgets render their prop data deterministically,
 * stay alive on empty/zero data, and derive every color from the theme:
 * - StatCard: label, formatted value, displayValue override, caption, sparkline
 *   (incl. the all-zeros collapsed baseline)
 * - StatCardGrid: lays out one card per datum, nothing when empty
 * - SectionCard: title, icon, action slot, body children
 * - ActivityTimeline: stacked bars per bucket, empty state, legend
 * - TypeBreakdown: center total, per-slice counts + percentages, zero-total
 * - AgentActivityBars: sort desc, top-N cap, overflow row, empty state
 * - SuccessFailureWidget: success-rate headline, per-outcome legend, empty state
 * - theme color application: each widget pulls its surface/accent colors from
 *   `theme.colors.*` rather than a hardcoded palette
 * - ChartErrorBoundary: catches a throwing child and shows the retry UI
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Activity } from 'lucide-react';
import {
	StatCard,
	StatCardGrid,
	SectionCard,
	ActivityTimeline,
	TypeBreakdown,
	AgentActivityBars,
	SuccessFailureWidget,
	ChartErrorBoundary,
} from '../../../../renderer/components/widgets';
import type { TimelineBucket, DonutSlice, BarDatum } from '../../../../renderer/components/widgets';
import { mockTheme, createMockTheme } from '../../../helpers/mockTheme';

// ChartErrorBoundary reports caught errors through the structured logger and
// Sentry; stub both so the expected-failure specs don't emit real telemetry.
vi.mock('../../../../renderer/utils/logger', () => ({
	logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../../renderer/utils/sentry', () => ({
	captureException: vi.fn(),
	captureMessage: vi.fn(),
}));

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

	it('collapses the sparkline to a dashed baseline when the trend is all zeros', () => {
		render(<StatCard theme={mockTheme} label="Flat" value={0} trend={[0, 0, 0]} />);
		// A non-empty but all-zero trend keeps the layout stable by drawing the
		// collapsed baseline rather than a real (and crash-prone) trend line.
		expect(screen.getByTestId('sparkline-empty')).toBeInTheDocument();
		expect(screen.queryByTestId('sparkline')).not.toBeInTheDocument();
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

describe('theme color application', () => {
	// Each widget should pull its surface/accent colors from `theme.colors.*`
	// rather than a hardcoded palette. We render with sentinel colors and assert
	// they reach the DOM, so a regression that bakes in a literal hex (and breaks
	// under other themes) fails here.

	it('StatCard derives card surface and value colors from the theme', () => {
		const theme = createMockTheme({
			colors: { bgActivity: '#101010', border: '#202020', textMain: '#303030' },
		});
		const { container } = render(<StatCard theme={theme} label="Themed" value={42} />);
		expect(container.firstChild as HTMLElement).toHaveStyle({
			backgroundColor: '#101010',
			borderColor: '#202020',
		});
		expect(screen.getByText('42')).toHaveStyle({ color: '#303030' });
	});

	it('SectionCard derives surface, border, and title colors from the theme', () => {
		const theme = createMockTheme({
			colors: { bgMain: '#111111', border: '#222222', textMain: '#333333' },
		});
		const { container } = render(
			<SectionCard theme={theme} title="Themed Section">
				<div>body</div>
			</SectionCard>
		);
		expect(container.firstChild as HTMLElement).toHaveStyle({
			backgroundColor: '#111111',
			borderColor: '#222222',
		});
		expect(screen.getByText('Themed Section')).toHaveStyle({ color: '#333333' });
	});

	it('ActivityTimeline maps the legend dots to theme accent (user) and warning (auto)', () => {
		const theme = createMockTheme({ colors: { accent: '#aa00ff', warning: '#ffaa00' } });
		render(<ActivityTimeline theme={theme} buckets={[{ auto: 1, user: 1, cue: 0 }]} />);
		expect(screen.getByText('User').querySelector('span') as HTMLElement).toHaveStyle({
			backgroundColor: '#aa00ff',
		});
		expect(screen.getByText('Auto').querySelector('span') as HTMLElement).toHaveStyle({
			backgroundColor: '#ffaa00',
		});
	});

	it('TypeBreakdown draws the track ring and center total from the theme', () => {
		const theme = createMockTheme({ colors: { border: '#abcabc', textMain: '#defdef' } });
		const { container } = render(
			<TypeBreakdown
				theme={theme}
				slices={[
					{ label: 'A', value: 2, color: '#111111' },
					{ label: 'B', value: 3, color: '#999999' },
				]}
			/>
		);
		// First circle is the track ring; its stroke is the theme border.
		expect(container.querySelector('circle')).toHaveAttribute('stroke', '#abcabc');
		// Center total is 5 (unique vs the per-slice counts 2 and 3).
		expect(screen.getByText('5')).toHaveStyle({ color: '#defdef' });
	});

	it('AgentActivityBars derives label, track, and default bar colors from the theme', () => {
		const theme = createMockTheme({
			colors: { textMain: '#dddddd', border: '#bbbbbb', accent: '#cccccc' },
		});
		render(<AgentActivityBars theme={theme} data={[{ label: 'solo', value: 5 }]} />);
		const label = screen.getByText('solo');
		expect(label).toHaveStyle({ color: '#dddddd' });
		const track = label.parentElement?.querySelector('div') as HTMLElement;
		expect(track).toHaveStyle({ backgroundColor: '#bbbbbb' });
		// No per-bar color supplied, so the fill falls back to the theme accent.
		expect(track.querySelector('div') as HTMLElement).toHaveStyle({ backgroundColor: '#cccccc' });
	});

	it('SuccessFailureWidget draws the split bar from the theme success/error/border colors', () => {
		const theme = createMockTheme({
			colors: { success: '#00aa00', error: '#aa0000', border: '#0000aa' },
		});
		render(<SuccessFailureWidget theme={theme} successCount={3} failureCount={1} />);
		const bar = screen.getByRole('img');
		expect(bar).toHaveStyle({ backgroundColor: '#0000aa' });
		const [successSeg, failureSeg] = Array.from(bar.children) as HTMLElement[];
		expect(successSeg).toHaveStyle({ backgroundColor: '#00aa00' });
		expect(failureSeg).toHaveStyle({ backgroundColor: '#aa0000' });
	});
});

describe('ChartErrorBoundary', () => {
	// React logs every caught render error to console.error; silence it so the
	// expected-failure specs don't spam the reporter.
	const originalConsoleError = console.error;
	beforeEach(() => {
		console.error = vi.fn();
	});
	afterEach(() => {
		console.error = originalConsoleError;
	});

	function Boom(): never {
		throw new Error('widget exploded');
	}

	it('renders its children unchanged when they do not throw', () => {
		render(
			<ChartErrorBoundary theme={mockTheme}>
				<div data-testid="healthy-child">ok</div>
			</ChartErrorBoundary>
		);
		expect(screen.getByTestId('healthy-child')).toBeInTheDocument();
		expect(screen.queryByTestId('chart-error-boundary')).not.toBeInTheDocument();
	});

	it('catches a throwing child and shows the retry UI', () => {
		render(
			<ChartErrorBoundary theme={mockTheme} chartName="Activity Timeline">
				<Boom />
			</ChartErrorBoundary>
		);
		expect(screen.getByTestId('chart-error-boundary')).toBeInTheDocument();
		expect(screen.getByText('Failed to render Activity Timeline')).toBeInTheDocument();
		expect(screen.getByTestId('chart-retry-button')).toBeInTheDocument();
	});

	it('derives the retry button text color from the theme (no hardcoded white)', () => {
		// Guards the cross-theme fix: the retry button text used to be a baked-in
		// `#ffffff`, invisible on a light accent. It must read accentForeground.
		const themed = createMockTheme({
			colors: { accent: '#123456', accentForeground: '#fedcba' },
		});
		render(
			<ChartErrorBoundary theme={themed}>
				<Boom />
			</ChartErrorBoundary>
		);
		const retry = screen.getByTestId('chart-retry-button');
		expect(retry).toHaveStyle({ backgroundColor: '#123456', color: '#fedcba' });
	});

	it('re-renders the child when Retry is clicked after the fault clears', () => {
		let shouldThrow = true;
		function Flaky() {
			if (shouldThrow) throw new Error('transient');
			return <div data-testid="recovered">recovered</div>;
		}
		render(
			<ChartErrorBoundary theme={mockTheme}>
				<Flaky />
			</ChartErrorBoundary>
		);
		expect(screen.getByTestId('chart-error-boundary')).toBeInTheDocument();

		shouldThrow = false;
		fireEvent.click(screen.getByTestId('chart-retry-button'));

		expect(screen.getByTestId('recovered')).toBeInTheDocument();
		expect(screen.queryByTestId('chart-error-boundary')).not.toBeInTheDocument();
	});
});

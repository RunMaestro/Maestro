/**
 * Tests for the Throughput Gauge styles: every style honors `GaugeStyleProps`
 * (value, peak, and label on screen, in both the full and the compact variant),
 * the per-style details (VU segment colors and held peak, LCD ghost digits, the
 * sparkline's peak mark on the shared scale), and the "All three" layout's
 * three labeled gauges sharing one scale.
 */
import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { FloatingThroughputGauge } from '../../../../renderer/components/ThroughputGauge/FloatingThroughputGauge';
import { GAUGE_STYLE_COMPONENTS } from '../../../../renderer/components/ThroughputGauge/styles';
import {
	lcdCellCount,
	lcdDigits,
} from '../../../../renderer/components/ThroughputGauge/styles/LcdReadout';
import {
	VU_SEGMENTS,
	vuLitSegments,
	vuPeakSegment,
	vuSegmentColor,
} from '../../../../renderer/components/ThroughputGauge/styles/VuMeter';
import type { GaugeStyleProps } from '../../../../renderer/components/ThroughputGauge/styles/types';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import { useThroughputGaugeStore } from '../../../../renderer/stores/throughputGaugeStore';
import {
	DEFAULT_THROUGHPUT_GAUGE_SETTINGS,
	THROUGHPUT_STYLES,
} from '../../../../shared/throughputGauge';
import { installLocalStorageMock } from '../../../helpers/mockLocalStorage';
import { mockTheme, mockThemeColors } from '../../../helpers/mockTheme';

function props(overrides: Partial<GaugeStyleProps> = {}): GaugeStyleProps {
	return {
		theme: mockTheme,
		value: 123,
		peak: 456,
		max: 500,
		label: 'Combined',
		caption: 'all agents',
		history: [10, 60, 123],
		compact: false,
		...overrides,
	};
}

const STYLE_IDS = THROUGHPUT_STYLES.map((s) => s.value);

describe('Throughput Gauge styles', () => {
	it('maps every style setting to a component', () => {
		expect(Object.keys(GAUGE_STYLE_COMPONENTS).sort()).toEqual([...STYLE_IDS].sort());
	});

	describe.each(STYLE_IDS)('%s', (style) => {
		const Style = GAUGE_STYLE_COMPONENTS[style];

		it.each([false, true])('renders the value, peak, and label (compact %s)', (compact) => {
			render(<Style {...props({ compact })} />);

			const root = screen.getByTestId(`throughput-style-${style}`);
			expect(root).toHaveAttribute('data-gauge-max', '500');
			expect(screen.getByTestId('throughput-gauge-reading')).toHaveTextContent('123');
			expect(screen.getByTestId('throughput-gauge-peak')).toHaveTextContent('456');
			expect(screen.getByTestId('throughput-gauge-label').textContent?.toLowerCase()).toBe(
				'combined'
			);
			expect(screen.getByTestId('throughput-gauge-caption')).toHaveTextContent('all agents');
		});

		it('renders an idle reading with no history without throwing', () => {
			render(<Style {...props({ value: 0, peak: 0, max: 50, history: [], caption: undefined })} />);
			expect(screen.getByTestId('throughput-gauge-reading')).toHaveTextContent('0');
			expect(screen.queryByTestId('throughput-gauge-caption')).toBeNull();
		});
	});

	describe('VU meter', () => {
		it('shades from success through warning to error up the bar', () => {
			expect(vuSegmentColor(mockThemeColors, 0.1)).toBe(mockThemeColors.success);
			expect(vuSegmentColor(mockThemeColors, 0.6)).toBe(mockThemeColors.success);
			const mid = vuSegmentColor(mockThemeColors, 0.85);
			expect(mid).toBe(mockThemeColors.warning);
			expect(vuSegmentColor(mockThemeColors, 1)).toBe(mockThemeColors.error);
		});

		it('lights segments in proportion to the reading', () => {
			expect(vuLitSegments(0, 100)).toBe(0);
			expect(vuLitSegments(50, 100)).toBe(VU_SEGMENTS / 2);
			expect(vuLitSegments(500, 100)).toBe(VU_SEGMENTS);
		});

		it('holds the peak segment above a fallen reading', () => {
			expect(vuPeakSegment(0, 100)).toBe(-1);
			expect(vuPeakSegment(100, 100)).toBe(VU_SEGMENTS - 1);
			render(<GAUGE_STYLE_COMPONENTS.vu {...props({ value: 10, peak: 400, max: 500 })} />);
			const peakSegment = screen.getByTestId('throughput-vu-peak-segment');
			expect(peakSegment).not.toHaveAttribute('data-lit');
			expect(peakSegment.getAttribute('fill')).toBe(vuSegmentColor(mockThemeColors, 15.5 / 20));
		});
	});

	describe('LCD readout', () => {
		it('prints whole numbers and sizes its cells to the scale', () => {
			expect(lcdDigits(1234.6)).toBe('1235');
			expect(lcdDigits(-3)).toBe('0');
			expect(lcdCellCount(50)).toBe(3);
			expect(lcdCellCount(2500)).toBe(4);
			expect(lcdCellCount(10000)).toBe(5);
		});

		it('draws a ghost 8 behind every digit cell', () => {
			const { container } = render(<GAUGE_STYLE_COMPONENTS.lcd {...props({ max: 2500 })} />);
			const ghosts = Array.from(container.querySelectorAll('text')).filter(
				(node) => node.textContent === '8888'
			);
			expect(ghosts).toHaveLength(2);
		});
	});

	describe('sparkline', () => {
		it('draws the history on the shared scale with a dashed peak mark', () => {
			render(<GAUGE_STYLE_COMPONENTS.sparkline {...props()} />);
			expect(screen.getByTestId('sparkline')).toBeInTheDocument();
			const reference = screen.getByTestId('sparkline-reference');
			expect(reference).toHaveAttribute('stroke-dasharray', '3 3');
		});

		it('draws an idle history of zeros as a line, not the empty baseline', () => {
			render(<GAUGE_STYLE_COMPONENTS.sparkline {...props({ value: 0, history: [0, 0, 0] })} />);
			expect(screen.getByTestId('sparkline')).toBeInTheDocument();
			expect(screen.queryByTestId('sparkline-empty')).toBeNull();
		});
	});
});

describe('All three layout', () => {
	beforeEach(() => {
		installLocalStorageMock();
		useSessionStore.setState({ sessions: [], activeSessionId: '' });
		useThroughputGaugeStore.setState({
			visible: true,
			rates: { in: 30, out: 120, combined: 150 },
			peak: { in: 40, out: 420, combined: 300 },
			history: { in: [30], out: [120], combined: [150] },
			rects: {},
		});
	});

	it.each(STYLE_IDS)('renders three labeled %s gauges on one scale', (style) => {
		useSettingsStore.setState({
			throughputGaugeSettings: { ...DEFAULT_THROUGHPUT_GAUGE_SETTINGS, layout: 'all', style },
		});
		render(<FloatingThroughputGauge theme={mockTheme} />);

		const labels: Record<string, string> = { in: 'in', out: 'out', combined: 'combined' };
		for (const metric of ['in', 'out', 'combined'] as const) {
			const gauge = screen.getByTestId(`throughput-gauge-${metric}`);
			expect(within(gauge).getByTestId('throughput-gauge-label').textContent?.toLowerCase()).toBe(
				labels[metric]
			);
			// The largest reading or peak among the three (out's 420) sets the scale.
			expect(within(gauge).getByTestId(`throughput-style-${style}`)).toHaveAttribute(
				'data-gauge-max',
				'500'
			);
		}
		expect(screen.getByTestId('throughput-gauge-scope-caption')).toHaveTextContent('all agents');
	});

	it('renders one gauge for the chosen metric in the single layout', () => {
		useSettingsStore.setState({
			throughputGaugeSettings: { ...DEFAULT_THROUGHPUT_GAUGE_SETTINGS, metric: 'in' },
		});
		render(<FloatingThroughputGauge theme={mockTheme} />);

		expect(screen.getAllByTestId('throughput-gauge-reading')).toHaveLength(1);
		expect(screen.getByTestId('throughput-gauge-reading')).toHaveTextContent('30');
		expect(screen.getByTestId('throughput-style-dial')).toHaveAttribute('data-gauge-max', '50');
	});
});

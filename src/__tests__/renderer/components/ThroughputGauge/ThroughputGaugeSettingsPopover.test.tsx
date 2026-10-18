/**
 * Tests for the Throughput Gauge's gear popover: the gear toggles it, every
 * segmented choice writes the matching settings patch (and persists it) and
 * closes the popover, Reset peak reaches the store and closes it, and Escape or
 * an outside click closes the popover without hiding the gauge.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FloatingThroughputGauge } from '../../../../renderer/components/ThroughputGauge/FloatingThroughputGauge';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import { useThroughputGaugeStore } from '../../../../renderer/stores/throughputGaugeStore';
import {
	DEFAULT_THROUGHPUT_GAUGE_SETTINGS,
	THROUGHPUT_GAUGE_SETTINGS_KEY,
	type ThroughputGaugeSettings,
} from '../../../../shared/throughputGauge';
import { installLocalStorageMock } from '../../../helpers/mockLocalStorage';
import { mockTheme } from '../../../helpers/mockTheme';

const ZERO = { in: 0, out: 0, combined: 0 };

function openPopover() {
	render(<FloatingThroughputGauge theme={mockTheme} />);
	fireEvent.click(screen.getByTestId('throughput-gauge-settings-button'));
	return screen.getByTestId('throughput-gauge-settings');
}

describe('ThroughputGaugeSettingsPopover', () => {
	beforeEach(() => {
		installLocalStorageMock();
		vi.mocked(window.maestro.settings.set).mockClear();
		useSettingsStore.setState({
			throughputGaugeSettings: { ...DEFAULT_THROUGHPUT_GAUGE_SETTINGS },
		});
		useThroughputGaugeStore.setState({
			visible: true,
			rates: ZERO,
			peak: ZERO,
			history: { in: [], out: [], combined: [] },
		});
	});

	it('the gear toggles the popover', () => {
		openPopover();
		fireEvent.click(screen.getByTestId('throughput-gauge-settings-button'));
		expect(screen.queryByTestId('throughput-gauge-settings')).toBeNull();
	});

	it.each<[string, string, Partial<ThroughputGaugeSettings>]>([
		['scope', 'active', { scope: 'active' }],
		['metric', 'in', { metric: 'in' }],
		['metric', 'out', { metric: 'out' }],
		['layout', 'all', { layout: 'all' }],
		['style', 'vu', { style: 'vu' }],
		['style', 'lcd', { style: 'lcd' }],
		['style', 'sparkline', { style: 'sparkline' }],
		['windowMs', '5000', { windowMs: 5000 }],
		['windowMs', '60000', { windowMs: 60000 }],
	])('choosing %s = %s writes that patch and closes the popover', (field, value, patch) => {
		openPopover();

		fireEvent.click(screen.getByTestId(`throughput-gauge-setting-${field}-${value}`));

		const expected = { ...DEFAULT_THROUGHPUT_GAUGE_SETTINGS, ...patch };
		expect(useSettingsStore.getState().throughputGaugeSettings).toEqual(expected);
		expect(window.maestro.settings.set).toHaveBeenCalledWith(
			THROUGHPUT_GAUGE_SETTINGS_KEY,
			expected
		);
		expect(screen.queryByTestId('throughput-gauge-settings')).toBeNull();
		expect(useThroughputGaugeStore.getState().visible).toBe(true);
	});

	it('merges onto the current settings rather than the defaults', () => {
		useSettingsStore.setState({
			throughputGaugeSettings: { ...DEFAULT_THROUGHPUT_GAUGE_SETTINGS, style: 'lcd' },
		});
		openPopover();

		fireEvent.click(screen.getByTestId('throughput-gauge-setting-scope-active'));

		expect(useSettingsStore.getState().throughputGaugeSettings).toEqual({
			...DEFAULT_THROUGHPUT_GAUGE_SETTINGS,
			style: 'lcd',
			scope: 'active',
		});
	});

	it('marks the current value of every row as checked', () => {
		openPopover();
		for (const id of [
			'scope-all',
			'metric-combined',
			'layout-single',
			'style-dial',
			`windowMs-${DEFAULT_THROUGHPUT_GAUGE_SETTINGS.windowMs}`,
		]) {
			expect(screen.getByTestId(`throughput-gauge-setting-${id}`)).toHaveAttribute(
				'aria-checked',
				'true'
			);
		}
	});

	it('Reset peak calls resetPeak and closes the popover', () => {
		const resetPeak = vi.fn();
		useThroughputGaugeStore.setState({ resetPeak });
		openPopover();

		fireEvent.click(screen.getByTestId('throughput-gauge-reset-peak'));

		expect(resetPeak).toHaveBeenCalledTimes(1);
		expect(screen.queryByTestId('throughput-gauge-settings')).toBeNull();
	});

	it('Escape closes the popover without hiding the gauge', () => {
		const escapeSeenByCard = vi.fn();
		render(
			<div onKeyDown={escapeSeenByCard}>
				<FloatingThroughputGauge theme={mockTheme} />
			</div>
		);
		fireEvent.click(screen.getByTestId('throughput-gauge-settings-button'));

		fireEvent.keyDown(screen.getByTestId('throughput-gauge-settings'), { key: 'Escape' });

		expect(screen.queryByTestId('throughput-gauge-settings')).toBeNull();
		expect(screen.getByTestId('floating-throughput-gauge')).toBeInTheDocument();
		expect(useThroughputGaugeStore.getState().visible).toBe(true);
		// Stopped at the popover: nothing above it sees this Escape.
		expect(escapeSeenByCard).not.toHaveBeenCalled();
	});

	it('a click outside closes the popover; a click inside does not', () => {
		openPopover();

		fireEvent.mouseDown(screen.getByTestId('throughput-gauge-setting-metric-out'));
		expect(screen.getByTestId('throughput-gauge-settings')).toBeInTheDocument();

		fireEvent.mouseDown(document.body);
		expect(screen.queryByTestId('throughput-gauge-settings')).toBeNull();
		expect(useThroughputGaugeStore.getState().visible).toBe(true);
	});
});

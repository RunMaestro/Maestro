/**
 * Tests for ThroughputGaugeWidget, the gauge's desktop-window body: it draws
 * the readings the primary window publishes (the seed and every live
 * snapshot), its X and Escape send the `hide` command rather than hiding the
 * window, Reset peak sends `reset-peak`, and its settings edits go through the
 * settings store.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ThroughputGaugeWidget } from '../../../renderer/floatingWidget/ThroughputGaugeWidget';
import { formatGaugeRate } from '../../../renderer/components/ThroughputGauge/styles';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import type { ThroughputGaugeWidgetState } from '../../../shared/floatingWidgets';
import {
	DEFAULT_THROUGHPUT_GAUGE_SETTINGS,
	THROUGHPUT_GAUGE_SETTINGS_KEY,
	type ThroughputGaugeSettings,
} from '../../../shared/throughputGauge';
import { mockTheme } from '../../helpers/mockTheme';

const maestro = window.maestro as unknown as Record<string, unknown>;
const original = maestro.floatingWidgets;

function readings(overrides: Partial<ThroughputGaugeWidgetState> = {}): ThroughputGaugeWidgetState {
	return {
		rates: { in: 10, out: 32, combined: 42 },
		peak: { in: 20, out: 79, combined: 99 },
		history: { in: [10], out: [32], combined: [42] },
		activeAgentName: null,
		...overrides,
	};
}

let api: {
	onState: ReturnType<typeof vi.fn>;
	getState: ReturnType<typeof vi.fn>;
	sendCommand: ReturnType<typeof vi.fn>;
	hide: ReturnType<typeof vi.fn>;
};
let stateHandler: ((snapshot: unknown) => void) | null;
let unsubscribeState: ReturnType<typeof vi.fn>;

function setGaugeSettings(patch: Partial<ThroughputGaugeSettings>) {
	useSettingsStore.setState({
		throughputGaugeSettings: { ...DEFAULT_THROUGHPUT_GAUGE_SETTINGS, ...patch },
	});
}

async function renderWidget(seed: ThroughputGaugeWidgetState | null = readings()) {
	api.getState.mockResolvedValue(seed);
	const result = render(<ThroughputGaugeWidget theme={mockTheme} />);
	// Let the seed read resolve.
	await act(async () => {});
	return result;
}

beforeEach(() => {
	stateHandler = null;
	unsubscribeState = vi.fn();
	api = {
		onState: vi.fn((_id: string, handler: (snapshot: unknown) => void) => {
			stateHandler = handler;
			return unsubscribeState;
		}),
		getState: vi.fn().mockResolvedValue(null),
		sendCommand: vi.fn(),
		hide: vi.fn().mockResolvedValue(false),
	};
	maestro.floatingWidgets = api;
	vi.mocked(window.maestro.settings.set).mockClear();
	setGaugeSettings({});
});

afterEach(() => {
	maestro.floatingWidgets = original;
});

describe('ThroughputGaugeWidget', () => {
	it('draws the seeded readings inside the widget frame', async () => {
		await renderWidget();

		expect(api.getState).toHaveBeenCalledWith('throughput-gauge');
		expect(screen.getByTestId('floating-widget-title-strip')).toHaveTextContent('Throughput');
		expect(screen.getByTestId('throughput-gauge-reading')).toHaveTextContent(formatGaugeRate(42));
		expect(screen.getByTestId('throughput-gauge-peak')).toHaveTextContent(formatGaugeRate(99));
	});

	it('follows every live snapshot the primary window publishes', async () => {
		setGaugeSettings({ scope: 'active' });
		await renderWidget();

		act(() =>
			stateHandler?.(
				readings({ rates: { in: 3, out: 4, combined: 7 }, activeAgentName: 'Backend' })
			)
		);

		expect(screen.getByTestId('throughput-gauge-reading')).toHaveTextContent(formatGaugeRate(7));
		expect(screen.getByTestId('throughput-gauge-caption')).toHaveTextContent('Backend');
	});

	it('draws the layout and style from the settings store', async () => {
		setGaugeSettings({ layout: 'all', style: 'lcd' });
		await renderWidget();

		const widget = screen.getByTestId('throughput-gauge-widget');
		expect(widget).toHaveAttribute('data-layout', 'all');
		expect(widget).toHaveAttribute('data-style', 'lcd');
		for (const metric of ['in', 'out', 'combined']) {
			expect(screen.getByTestId(`throughput-gauge-${metric}`)).toBeInTheDocument();
		}
	});

	it('the X sends the hide command and never hides the window itself', async () => {
		await renderWidget();

		fireEvent.click(screen.getByTestId('floating-widget-close'));

		expect(api.sendCommand).toHaveBeenCalledWith('throughput-gauge', { type: 'hide' });
		expect(api.hide).not.toHaveBeenCalled();
	});

	it('Escape sends the hide command', async () => {
		await renderWidget();

		fireEvent.keyDown(window, { key: 'Escape' });

		expect(api.sendCommand).toHaveBeenCalledWith('throughput-gauge', { type: 'hide' });
		expect(api.hide).not.toHaveBeenCalled();
	});

	it('Escape with the settings popover open closes only the popover', async () => {
		await renderWidget();
		fireEvent.click(screen.getByTestId('throughput-gauge-settings-button'));

		fireEvent.keyDown(screen.getByTestId('throughput-gauge-settings'), { key: 'Escape' });

		expect(screen.queryByTestId('throughput-gauge-settings')).toBeNull();
		expect(api.sendCommand).not.toHaveBeenCalled();
	});

	it('a settings choice goes through the settings store', async () => {
		await renderWidget();
		fireEvent.click(screen.getByTestId('throughput-gauge-settings-button'));

		fireEvent.click(screen.getByTestId('throughput-gauge-setting-style-vu'));

		const expected = { ...DEFAULT_THROUGHPUT_GAUGE_SETTINGS, style: 'vu' };
		expect(useSettingsStore.getState().throughputGaugeSettings).toEqual(expected);
		expect(window.maestro.settings.set).toHaveBeenCalledWith(
			THROUGHPUT_GAUGE_SETTINGS_KEY,
			expected
		);
		expect(screen.getByTestId('throughput-gauge-widget')).toHaveAttribute('data-style', 'vu');
		expect(api.sendCommand).not.toHaveBeenCalled();
	});

	it('Reset peak sends the reset-peak command to the primary window', async () => {
		await renderWidget();
		fireEvent.click(screen.getByTestId('throughput-gauge-settings-button'));

		fireEvent.click(screen.getByTestId('throughput-gauge-reset-peak'));

		expect(api.sendCommand).toHaveBeenCalledWith('throughput-gauge', { type: 'reset-peak' });
		expect(screen.queryByTestId('throughput-gauge-settings')).toBeNull();
	});

	it('stops mirroring when it unmounts', async () => {
		const { unmount } = await renderWidget();

		unmount();

		expect(unsubscribeState).toHaveBeenCalledTimes(1);
	});
});

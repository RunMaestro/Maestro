import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ThroughputGaugeSection } from '../../../../../../renderer/components/Settings/tabs/EncoreTab/components';
import { useThroughputGaugeStore } from '../../../../../../renderer/stores/throughputGaugeStore';
import {
	DEFAULT_THROUGHPUT_GAUGE_SETTINGS,
	THROUGHPUT_GAUGE_SETTING_CONTROLS,
	type ThroughputGaugeSettings,
} from '../../../../../../shared/throughputGauge';
import { installLocalStorageMock } from '../../../../../helpers/mockLocalStorage';
import { mockTheme } from '../../../../../helpers/mockTheme';

function renderSection(
	settings: ThroughputGaugeSettings = { ...DEFAULT_THROUGHPUT_GAUGE_SETTINGS }
) {
	const setThroughputGaugeSettings = vi.fn();
	render(
		<ThroughputGaugeSection
			theme={mockTheme}
			throughputGaugeSettings={settings}
			setThroughputGaugeSettings={setThroughputGaugeSettings}
		/>
	);
	return setThroughputGaugeSettings;
}

describe('ThroughputGaugeSection', () => {
	beforeEach(() => {
		installLocalStorageMock();
	});

	it('anchors the section and its gated display settings for search', () => {
		renderSection();
		const root = document.querySelector('[data-setting-id="encore-throughput-gauge"]');
		expect(root).not.toBeNull();
		expect(
			root!.querySelector('[data-setting-id="encore-throughput-gauge-display"]')
		).not.toBeNull();
	});

	it('renders every setting with the shared labels and choices', () => {
		renderSection();
		for (const control of THROUGHPUT_GAUGE_SETTING_CONTROLS) {
			const row = screen.getByTestId(`throughput-gauge-section-${control.field}`);
			expect(row.textContent).toContain(control.label);
			for (const option of control.options) {
				expect(within(row).getByRole('button', { name: option.label })).toBeInTheDocument();
			}
		}
	});

	it.each<[keyof ThroughputGaugeSettings, string, Partial<ThroughputGaugeSettings>]>([
		['scope', 'Active agent', { scope: 'active' }],
		['metric', 'Out', { metric: 'out' }],
		['layout', 'All three', { layout: 'all' }],
		['style', 'Sparkline', { style: 'sparkline' }],
		['windowMs', '30s', { windowMs: 30000 }],
	])('choosing %s "%s" writes the merged settings', (field, label, patch) => {
		const current: ThroughputGaugeSettings = { ...DEFAULT_THROUGHPUT_GAUGE_SETTINGS, style: 'lcd' };
		const setThroughputGaugeSettings = renderSection(current);

		const row = screen.getByTestId(`throughput-gauge-section-${field}`);
		fireEvent.click(within(row).getByRole('button', { name: label }));

		expect(setThroughputGaugeSettings).toHaveBeenCalledWith({ ...current, ...patch });
	});

	it('Show gauge now brings a closed gauge back', () => {
		useThroughputGaugeStore.setState({ visible: false });
		renderSection();

		fireEvent.click(screen.getByRole('button', { name: /Show gauge now/ }));

		expect(useThroughputGaugeStore.getState().visible).toBe(true);
	});
});

import { describe, expect, it, vi } from 'vitest';
import { buildThroughputGaugeCommands } from '../../../../../renderer/components/QuickActionsModal/commands/throughputGaugeCommands';
import {
	DEFAULT_THROUGHPUT_GAUGE_SETTINGS,
	THROUGHPUT_SCOPES,
	THROUGHPUT_STYLES,
} from '../../../../../shared/throughputGauge';

function build(overrides: Partial<Parameters<typeof buildThroughputGaugeCommands>[0]> = {}) {
	return buildThroughputGaugeCommands({
		gaugeEnabled: true,
		gaugeVisible: false,
		settings: { ...DEFAULT_THROUGHPUT_GAUGE_SETTINGS },
		toggleGauge: vi.fn(),
		showGauge: vi.fn(),
		resetPeak: vi.fn(),
		applySettings: vi.fn(),
		setQuickActionOpen: vi.fn(),
		...overrides,
	});
}

describe('buildThroughputGaugeCommands', () => {
	it('offers nothing while the Throughput Gauge Encore Feature is off', () => {
		expect(build({ gaugeEnabled: false })).toEqual([]);
	});

	it('offers show/hide, reset peak, and one entry per style and scope', () => {
		expect(build().map((command) => command.id)).toEqual([
			'throughput-gauge-toggle',
			'throughput-gauge-reset-peak',
			...THROUGHPUT_STYLES.map((o) => `throughput-gauge-style-${o.value}`),
			...THROUGHPUT_SCOPES.map((o) => `throughput-gauge-scope-${o.value}`),
		]);
	});

	it('names what the toggle will do from the current visibility', () => {
		expect(build({ gaugeVisible: false })[0].label).toBe('Show Throughput Gauge');
		expect(build({ gaugeVisible: true })[0].label).toBe('Hide Throughput Gauge');
	});

	it('labels style and scope entries from the shared option lists', () => {
		const labels = build().map((command) => command.label);
		expect(labels).toContain('Throughput Gauge: Style Sparkline');
		expect(labels).toContain('Throughput Gauge: Scope Active agent');
	});

	it('marks the current style and scope', () => {
		const commands = build({
			settings: { ...DEFAULT_THROUGHPUT_GAUGE_SETTINGS, style: 'lcd', scope: 'active' },
		});
		const byId = (id: string) => commands.find((command) => command.id === id);
		expect(byId('throughput-gauge-style-lcd')?.subtext).toBe('Current style');
		expect(byId('throughput-gauge-style-dial')?.subtext).toBeUndefined();
		expect(byId('throughput-gauge-scope-active')?.subtext).toBe('Current scope');
	});

	it('runs the toggle and reset, and dismisses the palette', () => {
		const toggleGauge = vi.fn();
		const resetPeak = vi.fn();
		const setQuickActionOpen = vi.fn();
		const commands = build({ toggleGauge, resetPeak, setQuickActionOpen });

		commands[0].action();
		commands[1].action();

		expect(toggleGauge).toHaveBeenCalledTimes(1);
		expect(resetPeak).toHaveBeenCalledTimes(1);
		expect(setQuickActionOpen).toHaveBeenCalledTimes(2);
		expect(setQuickActionOpen).toHaveBeenCalledWith(false);
	});

	it('applies a chosen style or scope and shows the gauge', () => {
		const applySettings = vi.fn();
		const showGauge = vi.fn();
		const commands = build({ applySettings, showGauge });

		commands.find((command) => command.id === 'throughput-gauge-style-vu')!.action();
		commands.find((command) => command.id === 'throughput-gauge-scope-active')!.action();

		expect(applySettings).toHaveBeenNthCalledWith(1, { style: 'vu' });
		expect(applySettings).toHaveBeenNthCalledWith(2, { scope: 'active' });
		expect(showGauge).toHaveBeenCalledTimes(2);
	});
});

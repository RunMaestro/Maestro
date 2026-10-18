/**
 * Tests for the far end of `maestro-cli throughput-gauge`: every write must
 * call the SAME store action the hotkey, palette, menu, and gear popover call,
 * `set` must acknowledge only after the settings write has landed, and a write
 * while the Encore Feature is off must answer with the enable hint.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { installLocalStorageMock } from '../../helpers/mockLocalStorage';
import {
	readThroughputGaugeStatus,
	runRemoteThroughputGaugeCommand,
} from '../../../renderer/services/throughputGaugeCommands';
import { useThroughputGaugeStore } from '../../../renderer/stores/throughputGaugeStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { DEFAULT_THROUGHPUT_GAUGE_SETTINGS } from '../../../shared/throughputGauge';
import { THROUGHPUT_GAUGE_DISABLED_ERROR } from '../../../shared/throughputGaugeCommands';

const RATES = { in: 40, out: 142, combined: 182 };
const PEAK = { in: 100, out: 540, combined: 640 };

function setEnabled(enabled: boolean) {
	useSettingsStore.setState({
		encoreFeatures: { ...useSettingsStore.getState().encoreFeatures, throughputGauge: enabled },
	});
}

describe('runRemoteThroughputGaugeCommand', () => {
	let actions: Record<'show' | 'hide' | 'toggle' | 'resetPeak', ReturnType<typeof vi.fn>>;
	let setSettings: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		installLocalStorageMock();
		actions = { show: vi.fn(), hide: vi.fn(), toggle: vi.fn(), resetPeak: vi.fn() };
		useThroughputGaugeStore.setState({ visible: true, rates: RATES, peak: PEAK, ...actions });
		setSettings = vi.fn((value) => {
			useSettingsStore.setState({ throughputGaugeSettings: value });
			return Promise.resolve(true);
		});
		useSettingsStore.setState({
			throughputGaugeSettings: { ...DEFAULT_THROUGHPUT_GAUGE_SETTINGS },
			setThroughputGaugeSettings: setSettings,
		});
		setEnabled(true);
	});

	it.each([
		['show', 'show'],
		['hide', 'hide'],
		['toggle', 'toggle'],
		['reset-peak', 'resetPeak'],
	] as const)('%s calls the store action the UI calls', async (action, storeAction) => {
		const result = await runRemoteThroughputGaugeCommand({ action });
		expect(actions[storeAction]).toHaveBeenCalledTimes(1);
		expect(result).toEqual({ success: true, status: readThroughputGaugeStatus() });
	});

	it('status answers the live reading', async () => {
		expect(await runRemoteThroughputGaugeCommand({ action: 'status' })).toEqual({
			success: true,
			status: {
				enabled: true,
				visible: true,
				settings: DEFAULT_THROUGHPUT_GAUGE_SETTINGS,
				rates: RATES,
				peak: PEAK,
				windowMs: DEFAULT_THROUGHPUT_GAUGE_SETTINGS.windowMs,
			},
		});
	});

	it('set merges onto the live settings and acks only after the write persists', async () => {
		let persist: (ok: boolean) => void = () => {};
		setSettings.mockImplementation((value) => {
			useSettingsStore.setState({ throughputGaugeSettings: value });
			return new Promise<boolean>((resolve) => {
				persist = resolve;
			});
		});
		useSettingsStore.setState({
			throughputGaugeSettings: { ...DEFAULT_THROUGHPUT_GAUGE_SETTINGS, scope: 'active' },
		});

		let settled = false;
		const pending = runRemoteThroughputGaugeCommand({
			action: 'set',
			patch: { style: 'lcd', windowMs: 30000 },
		}).then((result) => {
			settled = true;
			return result;
		});
		await Promise.resolve();
		expect(settled).toBe(false);

		persist(true);
		const result = await pending;
		expect(setSettings).toHaveBeenCalledWith({
			...DEFAULT_THROUGHPUT_GAUGE_SETTINGS,
			scope: 'active',
			style: 'lcd',
			windowMs: 30000,
		});
		expect(result.success).toBe(true);
		expect(result.status?.settings.style).toBe('lcd');
		expect(result.status?.settings.scope).toBe('active');
		expect(result.status?.windowMs).toBe(30000);
	});

	it('set fails when the settings write did not land', async () => {
		setSettings.mockResolvedValue(false);
		const result = await runRemoteThroughputGaugeCommand({
			action: 'set',
			patch: { style: 'vu' },
		});
		expect(result).toEqual({
			success: false,
			error: 'Throughput Gauge settings could not be saved to disk',
		});
	});

	it('every write answers the enable hint while the feature is off', async () => {
		setEnabled(false);
		for (const action of ['show', 'hide', 'toggle', 'reset-peak'] as const) {
			expect(await runRemoteThroughputGaugeCommand({ action })).toEqual({
				success: false,
				error: THROUGHPUT_GAUGE_DISABLED_ERROR,
			});
		}
		expect(
			await runRemoteThroughputGaugeCommand({ action: 'set', patch: { style: 'lcd' } })
		).toEqual({ success: false, error: THROUGHPUT_GAUGE_DISABLED_ERROR });
		expect(Object.values(actions).every((fn) => fn.mock.calls.length === 0)).toBe(true);
		expect(setSettings).not.toHaveBeenCalled();
	});

	it('status still answers while the feature is off, reporting enabled false', async () => {
		setEnabled(false);
		const result = await runRemoteThroughputGaugeCommand({ action: 'status' });
		expect(result.success).toBe(true);
		expect(result.status?.enabled).toBe(false);
	});
});

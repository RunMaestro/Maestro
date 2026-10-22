/**
 * Answers `maestro-cli throughput-gauge` (the `throughput_gauge_command`
 * message) in the primary window, which owns the gauge's live rates.
 *
 * Every write calls the SAME function its click path calls: show, hide, and
 * toggle are the `throughputGaugeStore` actions the hotkey, the palette, and
 * the hamburger menu fire; `reset-peak` is the card's Reset peak; `set` merges
 * through `applyThroughputGaugeSettingsPatch` and `setThroughputGaugeSettings`,
 * exactly as the gear popover does. None of them moves focus.
 *
 * Every verb answers with the gauge's status after it ran, so a script can
 * verify the write it just made without a second round trip.
 */

import {
	THROUGHPUT_GAUGE_DISABLED_ERROR,
	type ThroughputGaugeCommandRequest,
	type ThroughputGaugeCommandResult,
	type ThroughputGaugeStatus,
} from '../../shared/throughputGaugeCommands';
import { applyThroughputGaugeSettingsPatch } from '../../shared/throughputGauge';
import { useSettingsStore } from '../stores/settingsStore';
import { useThroughputGaugeStore } from '../stores/throughputGaugeStore';
import { floatingWidgetsAvailable } from '../utils/floatingWidgetMode';

/**
 * The gauge as it stands right now, read from the live stores. `window` asks
 * the main process for the floating window's bounds, so the read is async; it
 * is null in the browser build (an in-app card) and whenever the gauge is off
 * or hidden.
 */
export async function readThroughputGaugeStatus(): Promise<ThroughputGaugeStatus> {
	const { encoreFeatures, throughputGaugeSettings } = useSettingsStore.getState();
	const { visible, rates, peak } = useThroughputGaugeStore.getState();
	const enabled = encoreFeatures?.throughputGauge === true;
	const windowBounds =
		enabled && visible && floatingWidgetsAvailable() ? await readGaugeWindowBounds() : null;
	return {
		enabled,
		visible,
		settings: { ...throughputGaugeSettings },
		rates: { ...rates },
		peak: { ...peak },
		windowMs: throughputGaugeSettings.windowMs,
		window: windowBounds,
	};
}

async function readGaugeWindowBounds(): Promise<ThroughputGaugeStatus['window']> {
	const bounds = await window.maestro.floatingWidgets.getBounds('throughput-gauge');
	if (!bounds) return null;
	const { x, y, width, height } = bounds;
	return { x, y, width, height };
}

/**
 * Run one `maestro-cli throughput-gauge` verb.
 *
 * `status` always answers, with `enabled: false` when the Encore Feature is
 * off, because a read that fails cannot tell a script WHY the gauge is not
 * there. Every write fails with the enable hint instead: the gauge does not
 * exist, so there is nothing to show, hide, or configure.
 *
 * `set` acknowledges only after the settings write has landed on disk, so a
 * `status` (or a fresh app launch) taken right after it sees the new value.
 */
export async function runRemoteThroughputGaugeCommand(
	request: ThroughputGaugeCommandRequest
): Promise<ThroughputGaugeCommandResult> {
	const status = await readThroughputGaugeStatus();
	if (request.action === 'status') return { success: true, status };
	if (!status.enabled) return { success: false, error: THROUGHPUT_GAUGE_DISABLED_ERROR };

	const gauge = useThroughputGaugeStore.getState();
	switch (request.action) {
		case 'show':
			gauge.show();
			break;
		case 'hide':
			gauge.hide();
			break;
		case 'toggle':
			gauge.toggle();
			break;
		case 'reset-peak':
			gauge.resetPeak();
			break;
		case 'set': {
			const settings = useSettingsStore.getState();
			const merged = applyThroughputGaugeSettingsPatch(
				settings.throughputGaugeSettings,
				request.patch
			);
			if (!merged.ok) return { success: false, error: merged.error };
			const persisted = await settings.setThroughputGaugeSettings(merged.settings);
			if (persisted === false) {
				return { success: false, error: 'Throughput Gauge settings could not be saved to disk' };
			}
			break;
		}
	}
	return { success: true, status: await readThroughputGaugeStatus() };
}

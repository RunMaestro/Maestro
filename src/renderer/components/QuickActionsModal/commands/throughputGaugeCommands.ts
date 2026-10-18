import type { QuickAction } from '../types';
import {
	THROUGHPUT_SCOPES,
	THROUGHPUT_STYLES,
	type ThroughputGaugeSettings,
} from '../../../../shared/throughputGauge';

interface BuildThroughputGaugeCommandsArgs {
	/** Throughput Gauge Encore Feature state - with it off, the gauge does not exist. */
	gaugeEnabled: boolean;
	/** True while the floating card is on screen. */
	gaugeVisible: boolean;
	settings: ThroughputGaugeSettings;
	toggleGauge: () => void;
	showGauge: () => void;
	resetPeak: () => void;
	/** Merge one validated field into the persisted gauge settings. */
	applySettings: (patch: Partial<ThroughputGaugeSettings>) => void;
	setQuickActionOpen: (open: boolean) => void;
	toggleShortcut?: QuickAction['shortcut'];
}

/**
 * Palette entries for the Throughput Gauge.
 *
 * The show/hide entry is offered whether or not the card is up, and names what
 * the keypress will do. The style and scope entries are one per option, drawn
 * from the shared option lists so a label is spelled once. Picking one also
 * shows the gauge: changing how it looks is asking to look at it.
 */
export function buildThroughputGaugeCommands({
	gaugeEnabled,
	gaugeVisible,
	settings,
	toggleGauge,
	showGauge,
	resetPeak,
	applySettings,
	setQuickActionOpen,
	toggleShortcut,
}: BuildThroughputGaugeCommandsArgs): QuickAction[] {
	if (!gaugeEnabled) return [];

	const run = (action: () => void) => () => {
		action();
		setQuickActionOpen(false);
	};
	const choose = (patch: Partial<ThroughputGaugeSettings>) =>
		run(() => {
			applySettings(patch);
			showGauge();
		});

	return [
		{
			id: 'throughput-gauge-toggle',
			label: gaugeVisible ? 'Hide Throughput Gauge' : 'Show Throughput Gauge',
			shortcut: toggleShortcut,
			subtext: gaugeVisible
				? 'Put the gauge away - capture keeps running'
				: 'Floating tokens-per-second gauge',
			action: run(toggleGauge),
		},
		{
			id: 'throughput-gauge-reset-peak',
			label: 'Reset Throughput Gauge Peak',
			subtext: 'Start the peak again from the current reading',
			action: run(resetPeak),
		},
		...THROUGHPUT_STYLES.map(
			(option): QuickAction => ({
				id: `throughput-gauge-style-${option.value}`,
				label: `Throughput Gauge: Style ${option.label}`,
				subtext: settings.style === option.value ? 'Current style' : undefined,
				action: choose({ style: option.value }),
			})
		),
		...THROUGHPUT_SCOPES.map(
			(option): QuickAction => ({
				id: `throughput-gauge-scope-${option.value}`,
				label: `Throughput Gauge: Scope ${option.label}`,
				subtext: settings.scope === option.value ? 'Current scope' : undefined,
				action: choose({ scope: option.value }),
			})
		),
	];
}

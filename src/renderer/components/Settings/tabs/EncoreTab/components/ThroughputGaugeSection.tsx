import { Activity, Gauge, LayoutGrid, Palette, Timer, Users, type LucideIcon } from 'lucide-react';
import {
	applyThroughputGaugeSettingsPatch,
	THROUGHPUT_GAUGE_SETTING_CONTROLS,
	type ThroughputGaugeSettings,
} from '../../../../../../shared/throughputGauge';
import { useThroughputGaugeStore } from '../../../../../stores/throughputGaugeStore';
import type { Theme } from '../../../../../types';
import { ToggleButtonGroup } from '../../../../ToggleButtonGroup';
import { SettingsSectionHeading } from '../../../SettingsSectionHeading';
import { ActionButton } from './ActionButton';

/** What each setting means, shown under its heading. The choices come from the shared lists. */
const FIELD_COPY: Record<keyof ThroughputGaugeSettings, { icon: LucideIcon; description: string }> =
	{
		scope: {
			icon: Users,
			description: 'Count every agent in this window, or only the agent you are looking at.',
		},
		metric: {
			icon: Activity,
			description:
				'Which reading the gauge shows: tokens the agents read in, tokens they write out, or both together.',
		},
		layout: {
			icon: LayoutGrid,
			description: 'One gauge for the chosen metric, or In, Out, and Combined side by side.',
		},
		style: {
			icon: Palette,
			description:
				'How the reading is drawn: a needle dial, a VU meter, an LCD readout, or a sparkline.',
		},
		windowMs: {
			icon: Timer,
			description:
				'How many seconds the rate is averaged over. A short window reacts fast; a long one is steadier. Changing it resets the peak.',
		},
	};

interface ThroughputGaugeSectionProps {
	theme: Theme;
	throughputGaugeSettings: ThroughputGaugeSettings;
	setThroughputGaugeSettings: (settings: ThroughputGaugeSettings) => void;
}

/**
 * Throughput Gauge's settings, shown in its Extensions tile: the same five
 * choices as the gear popover on the gauge, plus a way to bring a closed gauge
 * back.
 */
export function ThroughputGaugeSection({
	theme,
	throughputGaugeSettings,
	setThroughputGaugeSettings,
}: ThroughputGaugeSectionProps) {
	const show = useThroughputGaugeStore((s) => s.show);

	const update = (field: keyof ThroughputGaugeSettings, value: string | number) => {
		const result = applyThroughputGaugeSettingsPatch(throughputGaugeSettings, { [field]: value });
		if (result.ok) setThroughputGaugeSettings(result.settings);
	};

	return (
		<div data-setting-id="encore-throughput-gauge" className="space-y-5 pt-4">
			<div>
				<SettingsSectionHeading
					icon={Gauge}
					description="A floating dial of tokens per second across your agents. Close it from its own title strip and bring it back here. The gear on the gauge holds the same settings as below, and Reset peak."
				>
					Gauge
				</SettingsSectionHeading>
				<ActionButton theme={theme} icon={Gauge} label="Show gauge now" onClick={show} />
			</div>

			<div data-setting-id="encore-throughput-gauge-display" className="space-y-5">
				{THROUGHPUT_GAUGE_SETTING_CONTROLS.map((control) => {
					const copy = FIELD_COPY[control.field];
					return (
						<div key={control.field} data-testid={`throughput-gauge-section-${control.field}`}>
							<SettingsSectionHeading icon={copy.icon} description={copy.description}>
								{control.label}
							</SettingsSectionHeading>
							<ToggleButtonGroup<string | number>
								options={control.options.map((option) => ({
									value: option.value,
									label: option.label,
								}))}
								value={throughputGaugeSettings[control.field]}
								onChange={(value) => update(control.field, value)}
								theme={theme}
							/>
						</div>
					);
				})}
			</div>
		</div>
	);
}

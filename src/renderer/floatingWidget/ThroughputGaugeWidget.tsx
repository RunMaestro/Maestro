/**
 * ThroughputGaugeWidget - the Throughput Gauge in its own desktop-level window.
 *
 * This window only draws. The primary app window runs the rate engine and is
 * the gauge's authority: it publishes the readings, which this window mirrors
 * into a local store, and it owns the `visible` latch. So the X and Escape do
 * not hide this window; they send the `hide` command, the primary window's
 * store hides the gauge, and the latch hides the window. Reset peak goes the
 * same way, since the peak lives with the readings.
 *
 * The gauge's settings are ordinary user settings: the gear popover writes them
 * through the settings store, and the primary window picks the change up
 * through its external-change reload.
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Gauge, Settings } from 'lucide-react';
import { create } from 'zustand';

import type {
	ThroughputGaugeWidgetCommand,
	ThroughputGaugeWidgetState,
} from '../../shared/floatingWidgets';
import { EMPTY_THROUGHPUT_HISTORY, ZERO_THROUGHPUT_RATES } from '../../shared/throughputRate';
import { ThroughputGaugeBody } from '../components/ThroughputGauge/ThroughputGaugeBody';
import { ThroughputGaugeSettingsPopover } from '../components/ThroughputGauge/ThroughputGaugeSettingsPopover';
import { GhostIconButton } from '../components/ui/GhostIconButton';
import { useSettingsStore } from '../stores/settingsStore';
import { mirrorStoreState, sendWidgetCommand } from '../utils/windowStoreMirror';
import type { Theme } from '../types';
import { FloatingWidgetFrame } from './FloatingWidgetFrame';

const WIDGET_ID = 'throughput-gauge';

/** The readings the primary window last published. Replica only: never published back. */
const useMirroredReadings = create<ThroughputGaugeWidgetState>()(() => ({
	rates: ZERO_THROUGHPUT_RATES,
	peak: ZERO_THROUGHPUT_RATES,
	history: EMPTY_THROUGHPUT_HISTORY,
	activeAgentName: null,
}));

function sendCommand(command: ThroughputGaugeWidgetCommand) {
	sendWidgetCommand(WIDGET_ID, command);
}

interface ThroughputGaugeWidgetProps {
	theme: Theme;
}

export const ThroughputGaugeWidget = memo(function ThroughputGaugeWidget({
	theme,
}: ThroughputGaugeWidgetProps) {
	const { metric, scope, layout, style } = useSettingsStore((s) => s.throughputGaugeSettings);
	const rates = useMirroredReadings((s) => s.rates);
	const peak = useMirroredReadings((s) => s.peak);
	const history = useMirroredReadings((s) => s.history);
	const activeAgentName = useMirroredReadings((s) => s.activeAgentName);

	useEffect(
		() =>
			mirrorStoreState(
				WIDGET_ID,
				useMirroredReadings,
				(snapshot: ThroughputGaugeWidgetState) => snapshot
			),
		[]
	);

	const [settingsOpen, setSettingsOpen] = useState(false);
	const gearRef = useRef<HTMLButtonElement>(null);
	const closeSettings = useCallback(() => setSettingsOpen(false), []);
	const hide = useCallback(() => sendCommand({ type: 'hide' }), []);
	const resetPeak = useCallback(() => sendCommand({ type: 'reset-peak' }), []);

	return (
		<FloatingWidgetFrame
			theme={theme}
			icon={<Gauge className="w-3.5 h-3.5" />}
			title="Throughput"
			onClose={hide}
			closeLabel="Hide throughput gauge"
			actions={
				<GhostIconButton
					ref={gearRef}
					onClick={() => setSettingsOpen((open) => !open)}
					title="Gauge settings"
					ariaLabel="Throughput gauge settings"
					pressed={settingsOpen}
					color={settingsOpen ? theme.colors.accent : theme.colors.textDim}
					testId="throughput-gauge-settings-button"
				>
					<Settings className="w-3.5 h-3.5" />
				</GhostIconButton>
			}
		>
			<div
				data-testid="throughput-gauge-widget"
				data-layout={layout}
				data-style={style}
				className="flex-1 min-h-0 flex flex-col px-2 pt-1 pb-1.5"
			>
				<ThroughputGaugeBody
					theme={theme}
					metric={metric}
					scope={scope}
					layout={layout}
					style={style}
					rates={rates}
					peak={peak}
					history={history}
					activeAgentName={activeAgentName}
				/>
			</div>

			{settingsOpen && (
				<ThroughputGaugeSettingsPopover
					theme={theme}
					anchorRef={gearRef}
					onClose={closeSettings}
					onResetPeak={resetPeak}
				/>
			)}
		</FloatingWidgetFrame>
	);
});

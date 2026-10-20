/**
 * ThroughputGaugeHost - app-level owner of the Throughput Gauge.
 *
 * Mounted once in AppShell. With the `throughputGauge` Encore Feature off it
 * renders nothing and runs nothing: the capture hook lives in a child that only
 * exists while the flag is on, so no listener and no timer outlive the flag.
 *
 * Turning the feature on during the session (the Encore tile, or `maestro-cli
 * encore enable`) pops the card up at once, since that is the user asking to
 * see it. On launch with the feature already on, the remembered open/closed
 * latch wins, so a gauge the user closed stays closed.
 *
 * In the desktop app (`floatingWidgetsAvailable()`) the gauge draws in its own
 * desktop-level window instead of an in-app card. This window stays the
 * gauge's authority: the rate engine runs here, the readings are published to
 * the widget window, and the widget's X and Escape come back as commands that
 * go through the store, so the `visible` latch is the one truth for both.
 */

import { memo, useEffect, useRef } from 'react';

import { FloatingThroughputGauge } from './FloatingThroughputGauge';
import { useThroughputCapture } from './useThroughputCapture';
import { selectActiveSession, useSessionStore } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useThroughputGaugeStore } from '../../stores/throughputGaugeStore';
import { floatingWidgetsAvailable } from '../../utils/floatingWidgetMode';
import { onWidgetCommand, publishStoreState } from '../../utils/windowStoreMirror';
import {
	isThroughputGaugeWidgetCommand,
	type ThroughputGaugeWidgetState,
} from '../../../shared/floatingWidgets';
import type { Theme } from '../../types';

const WIDGET_ID = 'throughput-gauge';

interface ThroughputGaugeHostProps {
	theme: Theme;
}

/**
 * The desktop-window side of the gauge: publishes the readings, keeps the
 * widget's window in step with the `visible` latch, and answers its commands.
 * Renders nothing. Unmounting (the feature turned off) hides the window.
 */
function ThroughputGaugeWindowDriver() {
	const scope = useSettingsStore((s) => s.throughputGaugeSettings.scope);
	const activeAgentName = useSessionStore((s) =>
		scope === 'active' ? (selectActiveSession(s)?.name ?? null) : null
	);
	const visible = useThroughputGaugeStore((s) => s.visible);

	// A new agent name restarts the publish, which sends the new state at once.
	useEffect(
		() =>
			publishStoreState(
				WIDGET_ID,
				useThroughputGaugeStore,
				({ rates, peak, history }): ThroughputGaugeWidgetState => ({
					rates,
					peak,
					history,
					activeAgentName,
				})
			),
		[activeAgentName]
	);

	useEffect(() => {
		const api = window.maestro.floatingWidgets;
		void (visible ? api.show(WIDGET_ID) : api.hide(WIDGET_ID));
	}, [visible]);

	useEffect(() => () => void window.maestro.floatingWidgets.hide(WIDGET_ID), []);

	useEffect(
		() =>
			onWidgetCommand<unknown>(WIDGET_ID, (command) => {
				if (!isThroughputGaugeWidgetCommand(command)) return;
				const gauge = useThroughputGaugeStore.getState();
				if (command.type === 'hide') gauge.hide();
				else gauge.resetPeak();
			}),
		[]
	);

	return null;
}

/** The live part: exists only while the feature is on. */
function ThroughputGaugeRuntime({ theme }: ThroughputGaugeHostProps) {
	useThroughputCapture();
	const visible = useThroughputGaugeStore((s) => s.visible);
	if (floatingWidgetsAvailable()) return <ThroughputGaugeWindowDriver />;
	return visible ? <FloatingThroughputGauge theme={theme} /> : null;
}

export const ThroughputGaugeHost = memo(function ThroughputGaugeHost({
	theme,
}: ThroughputGaugeHostProps) {
	const enabled = useSettingsStore((s) => s.encoreFeatures?.throughputGauge === true);
	const settingsLoaded = useSettingsStore((s) => s.settingsLoaded);

	// The flag reads false until settings load, so the first value seen AFTER
	// load is the launch state, not a flip. Only a later off-to-on is a flip.
	const previousEnabledRef = useRef<boolean | null>(null);
	useEffect(() => {
		if (!settingsLoaded) return;
		const previous = previousEnabledRef.current;
		previousEnabledRef.current = enabled;
		if (previous === false && enabled) useThroughputGaugeStore.getState().show();
	}, [enabled, settingsLoaded]);

	return enabled ? <ThroughputGaugeRuntime theme={theme} /> : null;
});

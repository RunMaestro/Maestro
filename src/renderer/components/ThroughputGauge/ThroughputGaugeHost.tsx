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
 */

import { memo, useEffect, useRef } from 'react';

import { FloatingThroughputGauge } from './FloatingThroughputGauge';
import { useThroughputCapture } from './useThroughputCapture';
import { useSettingsStore } from '../../stores/settingsStore';
import { useThroughputGaugeStore } from '../../stores/throughputGaugeStore';
import type { Theme } from '../../types';

interface ThroughputGaugeHostProps {
	theme: Theme;
}

/** The live part: exists only while the feature is on. */
function ThroughputGaugeRuntime({ theme }: ThroughputGaugeHostProps) {
	useThroughputCapture();
	const visible = useThroughputGaugeStore((s) => s.visible);
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

/**
 * FloatingWidgetRoot - render entry for a desktop-level widget window.
 *
 * The main process loads the main renderer bundle into a small frameless,
 * transparent window with `?floatingWidget=<id>`, and main.tsx mounts this
 * instead of the full app. Like CadenzaHudRoot (`../cadenzaHud.tsx`), it boots
 * only what a widget needs: the user's settings (for the theme and fonts) and
 * the one widget body the id names. Each body draws its own
 * `FloatingWidgetFrame`, so it owns its title, actions and close behavior.
 *
 * The root reports the window ready to main only once those settings have
 * loaded. Main holds commands until then, and the media player's persisted
 * queue hydrates in that load, so a held `open-file` lands on the restored
 * queue rather than racing it (and losing it to the "restore only onto an
 * empty player" guard).
 *
 * An id this build does not know renders nothing: the window stays a
 * transparent, empty rectangle rather than a broken widget, and the reason
 * goes to the log.
 */

import { useEffect, useRef } from 'react';
import type { ComponentType } from 'react';
import { isFloatingWidgetId, type FloatingWidgetId } from '../../shared/floatingWidgets';
import { useWindowSettingsSync } from '../hooks/settings/useWindowSettingsSync';
import { useResolvedTheme } from '../hooks/ui/useResolvedTheme';
import { useSettingsStore } from '../stores/settingsStore';
import { logger } from '../utils/logger';
import type { Theme } from '../types';
import { VoiceWidget } from './VoiceWidget';
import { MediaPlayerWidget } from './MediaPlayerWidget';
import { ThroughputGaugeWidget } from './ThroughputGaugeWidget';

/** The URL parameter that names the widget a window hosts. */
export const FLOATING_WIDGET_QUERY_PARAM = 'floatingWidget';

export interface FloatingWidgetBodyProps {
	theme: Theme;
}

/** The body each widget id renders. */
const WIDGET_BODIES: Record<FloatingWidgetId, ComponentType<FloatingWidgetBodyProps>> = {
	'throughput-gauge': ThroughputGaugeWidget,
	'media-player': MediaPlayerWidget,
	'acappella-voice': VoiceWidget,
};

function readWidgetParam(): string | null {
	return new URLSearchParams(window.location.search).get(FLOATING_WIDGET_QUERY_PARAM);
}

export function FloatingWidgetRoot() {
	const param = readWidgetParam();

	useEffect(() => {
		if (!isFloatingWidgetId(param)) {
			logger.warn(`Unknown floating widget id: ${String(param)}`, 'FloatingWidget');
		}
	}, [param]);

	if (!isFloatingWidgetId(param)) return null;
	return <FloatingWidgetHost id={param} />;
}

function FloatingWidgetHost({ id }: { id: FloatingWidgetId }) {
	// Load settings once, reload them when another window or the CLI changes
	// them, and publish the typography: the window-settings bundle every
	// secondary window shares.
	useWindowSettingsSync();
	const theme = useResolvedTheme();
	const settingsLoaded = useSettingsStore((s) => s.settingsLoaded);

	// Tell main the body mounted (and subscribed) and the settings it hydrates
	// from have loaded, so commands it held for this window can be delivered.
	// The ref keeps StrictMode's remount from sending twice.
	const readySent = useRef(false);
	useEffect(() => {
		if (!settingsLoaded || readySent.current) return;
		readySent.current = true;
		window.maestro?.floatingWidgets?.ready(id);
	}, [id, settingsLoaded]);

	const Body = WIDGET_BODIES[id];
	return <Body theme={theme} />;
}

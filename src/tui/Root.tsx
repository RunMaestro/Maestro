import React, { useCallback, useRef, useState } from 'react';
import { App, type AppProps } from './App';
import { startBackgroundHost, type BackgroundHostDeps } from './background-host';
import type { TuiStartup } from './startup';

export interface RootProps extends Omit<
	AppProps,
	'client' | 'readOnlyLabel' | 'startupNotice' | 'onStartBackgroundHost'
> {
	/** How the TUI started (`startTuiHost`). */
	startup: TuiStartup;
	/** What "Start background host" runs; absent where the TUI cannot start one. */
	backgroundHost?: BackgroundHostDeps;
	/** Told every time the startup changes, so the caller closes the client that is current at exit. */
	onStartupChange?: (startup: TuiStartup) => void;
}

/**
 * Holds the client the App runs on. It is state, not a constant, because starting a background host
 * swaps the TUI's own runtime for a client of the detached one while the screen stays up.
 */
export function Root({
	startup: initial,
	backgroundHost,
	onStartupChange,
	...appProps
}: RootProps): React.ReactElement {
	const [startup, setStartup] = useState(initial);
	const startupRef = useRef(initial);

	const onStartBackgroundHost = useCallback(async () => {
		if (!backgroundHost) return { notice: 'A background host cannot be started from here.' };
		const outcome = await startBackgroundHost(startupRef.current, backgroundHost);
		if (outcome.startup) {
			startupRef.current = outcome.startup;
			setStartup(outcome.startup);
			onStartupChange?.(outcome.startup);
		}
		return { notice: outcome.notice };
	}, [backgroundHost, onStartupChange]);

	return (
		<App
			{...appProps}
			client={startup.branch === 'read-only' ? undefined : startup.client}
			onStartBackgroundHost={onStartBackgroundHost}
			{...(startup.branch === 'read-only'
				? { readOnlyLabel: startup.label, startupNotice: startup.notice }
				: {})}
		/>
	);
}

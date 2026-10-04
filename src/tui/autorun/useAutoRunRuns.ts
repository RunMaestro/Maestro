import { useCallback, useEffect, useState } from 'react';
import {
	EMPTY_AUTO_RUN,
	isAutoRunActive,
	reduceAutoRun,
	type AutoRunRun,
	type AutoRunRunEvent,
	type MaestroClient,
} from '../../shared/maestro-lib';

/** How often the run clock redraws while a run is on screen. */
export const RUN_CLOCK_TICK_MS = 1000;

/**
 * The runs on the host, by agent, folded as their events arrive. It listens for
 * every agent for as long as the App is up, not only while a screen is open, so
 * the clock, the token total, and the output tail are whole when the person
 * opens the screen halfway through a run. A finished run stays until the next
 * one replaces it.
 *
 * The host cannot be asked whether a run is going (gap G14), so a run is known
 * from its events alone. A fresh connection is the one moment those can have
 * been missed: the host replays every run that is still going, so each run held
 * is closed first and the replay restarts the live ones.
 */
export function useAutoRunRuns(
	client: MaestroClient | undefined
): Readonly<Record<string, AutoRunRun>> {
	const [runs, setRuns] = useState<Readonly<Record<string, AutoRunRun>>>({});

	const apply = useCallback((agentId: string, event: AutoRunRunEvent) => {
		setRuns((current) => ({
			...current,
			[agentId]: reduceAutoRun(current[agentId] ?? EMPTY_AUTO_RUN, event),
		}));
	}, []);

	useEffect(() => {
		if (!client) return;
		return client.events.subscribe(
			(event) => {
				if (event.type === 'autorun') {
					apply(event.agentId, event.event);
				} else if (event.type === 'host.connected' && !event.resumed) {
					const at = Date.now();
					setRuns((current) =>
						Object.fromEntries(
							Object.entries(current).map(([agentId, run]) => [
								agentId,
								isAutoRunActive(run) ? reduceAutoRun(run, { kind: 'state', at, state: null }) : run,
							])
						)
					);
				}
			},
			{ types: ['autorun', 'host.connected'] }
		);
	}, [client, apply]);

	return runs;
}

/** `Date.now()`, redrawn every second while `active`, so a clock on screen moves. */
export function useClockNow(active: boolean): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!active) return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), RUN_CLOCK_TICK_MS);
		return () => clearInterval(timer);
	}, [active]);
	return now;
}

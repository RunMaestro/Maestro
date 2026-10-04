import { useCallback, useEffect, useRef, useState } from 'react';
import type { MaestroClient } from '../../shared/maestro-lib';
import { foldTurnEvent, type LiveTurn } from './liveTurn';

/**
 * How long a finished turn stays on screen when the stored transcript never
 * shows it (an empty answer, a crash before any output). Past this the
 * transcript is the whole story.
 */
export const LIVE_TURN_LINGER_MS = 10_000;

/** The events that can open a turn. */
const OPENING_EVENTS: ReadonlySet<string> = new Set([
	'user',
	'started',
	'thinking',
	'text',
	'tool',
]);

export interface TurnStream {
	/** The tab's turn as it streams, from `started` until the transcript holds it. */
	turn: LiveTurn | undefined;
	/** Messages waiting in the host's execution queue for this tab (CH-4). */
	queued: number;
	/** Reads the queue again: the host does not push queue changes. */
	refreshQueue: () => void;
}

/**
 * One tab's live turn and queued count. Follows `client.turns.subscribe`, so a
 * turn started from the desktop or another surface streams here too (CO-2).
 * Without a client, or for no tab, there is nothing to follow.
 */
export function useTurnStream(
	client: MaestroClient | undefined,
	agentId: string | undefined,
	tabId: string | undefined
): TurnStream {
	const key = client && agentId && tabId ? `${agentId}:${tabId}` : undefined;
	const [state, setState] = useState<{ key: string; turn: LiveTurn | undefined } | undefined>();
	const [queue, setQueue] = useState<{ key: string; count: number } | undefined>();
	const refreshRef = useRef<() => void>(() => undefined);

	useEffect(() => {
		if (!client || !agentId || !tabId || !key) return;
		let cancelled = false;
		let lingerTimer: ReturnType<typeof setTimeout> | undefined;

		const readQueue = async () => {
			const read = await client.turns.queue.list(agentId);
			if (cancelled) return;
			// A host that cannot list the queue has none to show.
			setQueue({
				key,
				count: read.ok ? read.value.filter((item) => item.tabId === tabId).length : 0,
			});
		};
		refreshRef.current = () => void readQueue();
		void readQueue();

		const unsubscribe = client.turns.subscribe(agentId, tabId, (event) => {
			if (cancelled) return;
			setState((current) => {
				const previous = current?.key === key ? current.turn : undefined;
				return { key, turn: foldTurnEvent(previous, event) };
			});
			// A new turn must not be cleared by the previous turn's timer.
			if (OPENING_EVENTS.has(event.kind) && lingerTimer) {
				clearTimeout(lingerTimer);
				lingerTimer = undefined;
			}
			if (event.kind === 'outcome') {
				if (lingerTimer) clearTimeout(lingerTimer);
				lingerTimer = setTimeout(() => {
					setState((current) =>
						current?.key === key && current.turn?.outcome ? { key, turn: undefined } : current
					);
				}, LIVE_TURN_LINGER_MS);
			}
			// A queued message starts, or a turn ends and the next one starts: the count changes.
			if (event.kind === 'user' || event.kind === 'outcome') void readQueue();
		});

		return () => {
			cancelled = true;
			if (lingerTimer) clearTimeout(lingerTimer);
			unsubscribe();
			refreshRef.current = () => undefined;
		};
	}, [client, agentId, tabId, key]);

	const refreshQueue = useCallback(() => refreshRef.current(), []);
	return {
		turn: state?.key === key ? state?.turn : undefined,
		queued: queue && queue.key === key ? queue.count : 0,
		refreshQueue,
	};
}

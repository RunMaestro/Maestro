/**
 * The event bus both `MaestroClient` implementations deliver through (RT15).
 *
 * The WebSocket client and the in-process runtime used to be free to differ on
 * how an event reaches a listener; one bus means they cannot. Listeners run
 * synchronously in emit order. A listener that throws is logged and the others
 * still run, so one broken subscriber cannot silence the rest.
 */

import { logger } from '../host';
import type { EventFilter, MaestroEvent, Unsubscribe } from './types';

export interface EventBus {
	subscribe(listener: (event: MaestroEvent) => void, filter?: EventFilter): Unsubscribe;
	emit(event: MaestroEvent): void;
	emitAll(events: readonly MaestroEvent[]): void;
}

interface ListenerEntry {
	listener: (event: MaestroEvent) => void;
	filter?: EventFilter;
}

/**
 * Whether an event passes a filter. The agent filter narrows the agent-scoped
 * events (agent, tab, turn); connection, snapshot, group, and settings events
 * are about no single agent and always pass it.
 */
export function matchesFilter(event: MaestroEvent, filter: EventFilter | undefined): boolean {
	if (!filter) return true;
	if (filter.types && !filter.types.includes(event.type)) return false;
	if (filter.agentId === undefined) return true;
	switch (event.type) {
		case 'agent.added':
		case 'agent.updated':
			return event.agent.id === filter.agentId;
		case 'agent.removed':
		case 'tab.added':
		case 'tab.updated':
		case 'tab.removed':
		case 'turn':
		case 'autorun':
			return event.agentId === filter.agentId;
		default:
			return true;
	}
}

/** `logContext` prefixes the warning a throwing listener raises. */
export function createEventBus(logContext: string): EventBus {
	const listeners = new Set<ListenerEntry>();

	const emit = (event: MaestroEvent): void => {
		for (const entry of [...listeners]) {
			if (!matchesFilter(event, entry.filter)) continue;
			try {
				entry.listener(event);
			} catch (error) {
				logger.warn(
					`An event listener threw: ${error instanceof Error ? error.message : String(error)}`,
					logContext
				);
			}
		}
	};

	return {
		subscribe(listener, filter) {
			const entry: ListenerEntry = { listener, filter };
			listeners.add(entry);
			return () => {
				listeners.delete(entry);
			};
		},
		emit,
		emitAll(events) {
			for (const event of events) emit(event);
		},
	};
}

import type { PersistenceHandlerDependencies } from '../handlers/persistence';

type SessionsPersistedConsumer = NonNullable<PersistenceHandlerDependencies['onSessionsPersisted']>;

/**
 * `consumer`, then `note` (`noteHostedAgentsChanged()`): an agent moved back (`unlift --offline`
 * too) drops its host's outage and slows that host's redial at once, never at the next 30 s
 * re-check. `note` runs after a consumer that threw too: the write itself reached disk.
 */
export function withHostedAgentsNote(
	consumer: SessionsPersistedConsumer,
	note: () => void
): SessionsPersistedConsumer {
	return async (added, current, removedIds) => {
		try {
			await consumer(added, current, removedIds);
		} finally {
			note();
		}
	};
}

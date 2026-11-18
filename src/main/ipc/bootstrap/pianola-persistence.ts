import type { PersistenceHandlerDependencies } from '../handlers/persistence';
import type { PianolaSupervisor } from '../../pianola/pianola-supervisor';
import { logger } from '../../utils/logger';
import { captureException } from '../../utils/sentry';

/** The live bootstrap's post-flush consumer, shared with adapter composition tests. */
export function pianolaPersistenceConsumer(
	getSupervisor: () => Pick<PianolaSupervisor, 'autoWatchNewSessions'> | null | undefined
): NonNullable<PersistenceHandlerDependencies['onSessionsPersisted']> {
	return async (added, current, removedIds) => {
		try {
			await getSupervisor()?.autoWatchNewSessions(added, current, removedIds);
		} catch (error) {
			logger.error('Could not register new Pianola watches', '[Pianola]', error);
			void captureException(error, { operation: 'pianola:autoWatchNewSessions' });
		}
	};
}

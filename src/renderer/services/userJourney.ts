/**
 * Recording the User Journey: what the user did inside Maestro (files opened,
 * saved, created, renamed, deleted; pages browsed), per agent.
 *
 * Every recording site calls `recordJourney()`. It stamps the time and the
 * agent's SSH remote, then hands the entry to the main-process store over IPC
 * without waiting: recording must never block or break the UI action it
 * describes. A failed write goes to Sentry and nowhere else.
 *
 * The store (`src/main/user-journey-manager.ts`) normalizes the entry and
 * re-sanitizes `browser.*` URLs, but callers still pass URLs through
 * `sanitizeJourneyUrl()` so a query string never crosses IPC.
 */

import type { UserJourneyEntry } from '../../shared/userJourney';
import { selectSessionById, useSessionStore } from '../stores/sessionStore';
import { getSessionSshRemoteId } from '../utils/sessionHelpers';
import { captureException } from '../utils/sentry';

/** What a recording site supplies; `recordJourney` fills in the rest. */
export type JourneyRecord = Omit<UserJourneyEntry, 'ts' | 'agentId' | 'sshRemoteId'>;

/** Record one user action for an agent. Fire-and-forget; never throws. */
export function recordJourney(agentId: string, partial: JourneyRecord): void {
	const session = selectSessionById(agentId)(useSessionStore.getState());
	const sshRemoteId = getSessionSshRemoteId(session);
	const entry: UserJourneyEntry = {
		...partial,
		ts: Date.now(),
		agentId,
		...(sshRemoteId ? { sshRemoteId } : {}),
	};
	// Started inside a promise so a missing bridge (a synchronous throw) lands
	// in the same catch as a rejected write.
	void Promise.resolve()
		.then(() => window.maestro.journey.append(entry))
		.catch((error: unknown) => {
			captureException(error, {
				extra: { operation: 'journey:append', agentId, kind: partial.kind },
			});
		});
}

/**
 * Conductor routing outcome tracking, routing log, and roster handlers.
 */

import { withIpcErrorLogging } from '../../../utils/ipcHandler';
import { getSessionsStore } from '../../../stores/getters';
import type { RosterAgent, VoiceEvent } from '../../../../shared/acappella/protocol';
import { isScopeRouterId } from '../../../../shared/acappella/voice-mode';
import { getVoiceSessionService, readAgentRoster } from '../../../acappella';
import { invalidateRoutingContext } from '../../../acappella/router/routing-context';
import {
	lastRoutingTurn,
	loadRoutingLog,
	noteRoutingOutcome,
	readRoutingLog,
	routingQuality,
	type RoutingLogEntry,
	type RoutingQuality,
} from '../../../acappella/router/routing-log';
import { handlerOpts } from './shared';

/** Whether the latest `route-decision` came from a Brain (false in Tab mode). */
let lastDecisionWasRouted = true;

/**
 * Close the routing log's loop from the event stream.
 *
 * The router records what it DECIDED; only the session knows what became of it,
 * and the difference between those two is the entire value of the log. Doing it
 * here rather than inside the service keeps the service free of the router's
 * storage, and doing it from events rather than from call sites means a new
 * failure path cannot forget to report itself.
 */
export function recordRoutingOutcome(event: VoiceEvent): void {
	// Tab mode and a Quick Chat session route nothing, so their dispatch is not an
	// outcome of any logged turn; recording it would overwrite the verdict of the
	// last real one.
	if (event.type === 'route-decision') {
		lastDecisionWasRouted = !isScopeRouterId(event.brainProviderId);
		return;
	}
	if (!lastDecisionWasRouted) return;

	const turnId = lastRoutingTurn()?.id;
	if (!turnId) return;

	if (event.type === 'dispatch') {
		noteRoutingOutcome(turnId, 'dispatched', `${event.agentName} / ${event.action}`);
		return;
	}
	if (event.type === 'route-correction') {
		// The turn being corrected is the one BEFORE this correction's own entry,
		// which is why the correction is matched on the dispatch it replaced.
		const corrected = readRoutingLog()
			.reverse()
			.find((entry) => entry.outcome === 'dispatched');
		if (corrected) {
			noteRoutingOutcome(corrected.id, 'corrected', `moved to ${event.agentName}`);
		}
		return;
	}
	if (event.type === 'session-error' && event.code === 'dispatch-failed') {
		noteRoutingOutcome(turnId, 'failed', event.message);
	}
}

/**
 * Drop the cached routing context whenever an agent or a tab changes.
 *
 * The cache has a short TTL as a backstop, but a TTL alone is not good enough
 * here: within those seconds the roster can lose the very tab a decision is
 * about to name, and a routing turn is exactly the moment a user has just
 * finished rearranging their workspace.
 *
 * Best-effort by design. A store with no change feed (tests, an older
 * electron-store) simply falls back to the TTL rather than failing registration.
 */
export function watchRosterChanges(): void {
	try {
		const store = getSessionsStore() as unknown as {
			onDidChange?: (key: string, callback: () => void) => void;
		};
		store.onDidChange?.('sessions', invalidateRoutingContext);
	} catch {
		/* no store to watch: the context cache falls back to its TTL */
	}
}

export function createRoutingHandlers() {
	const wrappedGetRoster = withIpcErrorLogging(
		handlerOpts('getRoster'),
		async (): Promise<RosterAgent[]> => readAgentRoster()
	);

	const wrappedCorrectRoute = withIpcErrorLogging(
		handlerOpts('correctRoute'),
		// The HUD's "wrong tab" control. Returns false when there is nothing to
		// move, so a stray click is a no-op rather than an error.
		async (agentSessionId: unknown): Promise<boolean> => {
			if (typeof agentSessionId !== 'string' || !agentSessionId) {
				throw new Error('InvalidCorrectionTarget');
			}
			return (
				(await getVoiceSessionService()?.correctLastDispatch(agentSessionId, 'client-button')) ??
				false
			);
		}
	);

	const wrappedRoutingLog = withIpcErrorLogging(
		handlerOpts('routingLog'),
		async (): Promise<{ entries: RoutingLogEntry[]; quality: RoutingQuality }> => {
			await loadRoutingLog();
			return { entries: readRoutingLog(), quality: routingQuality() };
		}
	);

	return {
		wrappedGetRoster,
		wrappedCorrectRoute,
		wrappedRoutingLog,
	};
}

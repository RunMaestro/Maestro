import { useEffect, useRef } from 'react';
import type { Session, EncoreFeatureFlags } from '../types';
import { useSessionStore } from '../stores/sessionStore';
import { notifyToast } from '../stores/notificationStore';
import { captureException } from '../utils/sentry';
import { logger } from '../utils/logger';

/**
 * useCueAutoDiscovery — auto-discovers .maestro/cue.yaml files for sessions.
 *
 * Integration points:
 * 1. After sessions are restored on app launch, refreshes all sessions
 * 2. When a new session is created, refreshes that session
 * 3. When a session is removed, notifies the engine to clean up
 * 4. When the maestroCue encore feature is toggled on, starts the engine
 * 5. When the maestroCue encore feature is toggled off, stops the engine
 *
 * Session discovery always runs so the Cue indicator shows in the Left Bar
 * whenever a .maestro/cue.yaml exists. The encore feature flag only gates
 * engine execution (start/stop), not config discovery.
 */
export function useCueAutoDiscovery(sessions: Session[], encoreFeatures: EncoreFeatureFlags) {
	const sessionsLoaded = useSessionStore((s) => s.sessionsLoaded);
	const prevSessionIdsRef = useRef<Set<string>>(new Set());
	const prevMaestroCueEnabledRef = useRef<boolean>(encoreFeatures.maestroCue);
	const initialScanDoneRef = useRef(false);
	// Serializes in-flight enable/disable IPC calls so rapid toggles
	// (ON → OFF → ON) can't interleave and leave the engine in a state
	// that disagrees with the observed flag value.
	const toggleChainRef = useRef<Promise<void>>(Promise.resolve());

	// Track session additions and removals — always runs regardless of encore flag
	useEffect(() => {
		if (!sessionsLoaded) return;

		const currentIds = new Set(sessions.map((s) => s.id));
		const prevIds = prevSessionIdsRef.current;

		// --- Initial scan after sessions are loaded ---
		if (!initialScanDoneRef.current) {
			initialScanDoneRef.current = true;
			for (const session of sessions) {
				if (session.projectRoot) {
					window.maestro.cue
						.refreshSession(session.id, session.projectRoot)
						.catch((err) =>
							logger.error('[CueAutoDiscovery] Failed to refresh session:', undefined, err)
						);
				}
			}
			prevSessionIdsRef.current = currentIds;
			return;
		}

		// --- Detect new sessions ---
		for (const session of sessions) {
			if (!prevIds.has(session.id) && session.projectRoot) {
				window.maestro.cue
					.refreshSession(session.id, session.projectRoot)
					.catch((err) =>
						logger.error('[CueAutoDiscovery] Failed to refresh session:', undefined, err)
					);
			}
		}

		// --- Detect removed sessions ---
		for (const prevId of prevIds) {
			if (!currentIds.has(prevId)) {
				window.maestro.cue
					.removeSession(prevId)
					.catch((err) =>
						logger.error('[CueAutoDiscovery] Failed to remove session:', undefined, err)
					);
			}
		}

		prevSessionIdsRef.current = currentIds;
	}, [sessions, sessionsLoaded]);

	// Track encore feature toggle. Queues enable/disable calls on a single
	// chain so rapid ON/OFF/ON toggles always apply in the order the user
	// triggered them — not in IPC-response order.
	useEffect(() => {
		if (!sessionsLoaded) return;

		const wasEnabled = prevMaestroCueEnabledRef.current;
		const isEnabled = encoreFeatures.maestroCue;
		prevMaestroCueEnabledRef.current = isEnabled;

		if (wasEnabled === isEnabled) return;

		const sessionsSnapshot = sessions.filter((session) => !!session.projectRoot);

		toggleChainRef.current = toggleChainRef.current.then(async () => {
			if (isEnabled) {
				try {
					await window.maestro.cue.enable();
					await Promise.all(
						sessionsSnapshot.map((session) =>
							window.maestro.cue
								.refreshSession(session.id, session.projectRoot)
								.catch((err) =>
									logger.error('[CueAutoDiscovery] Failed to refresh session:', undefined, err)
								)
						)
					);
				} catch (err) {
					logger.error('[CueAutoDiscovery] Failed to enable Cue:', undefined, err);
					captureException(err, { extra: { action: 'maestro.cue.enable' } });
					notifyToast({
						type: 'error',
						title: 'Cue engine failed to start',
						message:
							err instanceof Error
								? err.message
								: 'Re-toggle Maestro Cue in Settings → Encore Features to retry.',
					});
				}
			} else {
				try {
					await window.maestro.cue.disable();
				} catch (err) {
					logger.error('[CueAutoDiscovery] Failed to disable Cue:', undefined, err);
					captureException(err, { extra: { action: 'maestro.cue.disable' } });
					notifyToast({
						type: 'error',
						title: 'Cue engine failed to stop',
						message:
							err instanceof Error
								? err.message
								: 'The engine may still be running. Restart the app if issues persist.',
					});
				}
			}
		});
	}, [encoreFeatures.maestroCue, sessions, sessionsLoaded]);
}

import { useEffect, useRef } from 'react';
import type { Session, EncoreFeatureFlags } from '../types';
import { useSessionStore } from '../stores/sessionStore';

/**
 * useCueAutoDiscovery — auto-discovers .maestro/cue.yaml files for sessions.
 *
 * Integration points:
 * 1. After sessions are restored on app launch, refreshes all sessions
 * 2. When a new session is created, refreshes that session
 * 3. When a session is removed, notifies the engine to clean up
 * 4. When the maestroCue encore feature is toggled on, scans all sessions
 * 5. When the maestroCue encore feature is toggled off, disables the engine
 *
 * All calls are gated on encoreFeatures.maestroCue being enabled.
 */
export function useCueAutoDiscovery(sessions: Session[], encoreFeatures: EncoreFeatureFlags) {
	const sessionsLoaded = useSessionStore((s) => s.sessionsLoaded);
	const prevSessionIdsRef = useRef<Set<string>>(new Set());
	const prevMaestroCueEnabledRef = useRef<boolean>(encoreFeatures.maestroCue);
	const initialScanDoneRef = useRef(false);

	// Track session additions and removals
	useEffect(() => {
		if (!sessionsLoaded) return;

		const currentIds = new Set(sessions.map((s) => s.id));
		const prevIds = prevSessionIdsRef.current;
		const isMaestroCueEnabled = encoreFeatures.maestroCue;

		// --- Initial scan after sessions are loaded ---
		if (!initialScanDoneRef.current && isMaestroCueEnabled) {
			initialScanDoneRef.current = true;
			for (const session of sessions) {
				if (session.projectRoot) {
					window.maestro.cue
						.refreshSession(session.id, session.projectRoot)
						.catch((err) => console.error('[CueAutoDiscovery] Failed to refresh session:', err));
				}
			}
			prevSessionIdsRef.current = currentIds;
			return;
		}

		if (!initialScanDoneRef.current) {
			initialScanDoneRef.current = true;
			prevSessionIdsRef.current = currentIds;
			return;
		}

		if (!isMaestroCueEnabled) {
			prevSessionIdsRef.current = currentIds;
			return;
		}

		// --- Detect new sessions ---
		for (const session of sessions) {
			if (!prevIds.has(session.id) && session.projectRoot) {
				window.maestro.cue
					.refreshSession(session.id, session.projectRoot)
					.catch((err) => console.error('[CueAutoDiscovery] Failed to refresh session:', err));
			}
		}

		// --- Detect removed sessions ---
		for (const prevId of prevIds) {
			if (!currentIds.has(prevId)) {
				window.maestro.cue
					.removeSession(prevId)
					.catch((err) => console.error('[CueAutoDiscovery] Failed to remove session:', err));
			}
		}

		prevSessionIdsRef.current = currentIds;
	}, [sessions, sessionsLoaded, encoreFeatures.maestroCue]);

	// Track encore feature toggle
	useEffect(() => {
		if (!sessionsLoaded) return;

		const wasEnabled = prevMaestroCueEnabledRef.current;
		const isEnabled = encoreFeatures.maestroCue;
		prevMaestroCueEnabledRef.current = isEnabled;

		if (wasEnabled === isEnabled) return;

		if (isEnabled) {
			window.maestro.cue
				.enable()
				.then(() =>
					Promise.all(
						sessions
							.filter((session) => !!session.projectRoot)
							.map((session) =>
								window.maestro.cue
									.refreshSession(session.id, session.projectRoot)
									.catch((err) =>
										console.error('[CueAutoDiscovery] Failed to refresh session:', err)
									)
							)
					)
				)
				.catch((err) => console.error('[CueAutoDiscovery] Failed to enable Cue:', err));
		} else {
			// Feature was just disabled — stop the engine
			window.maestro.cue
				.disable()
				.catch((err) => console.error('[CueAutoDiscovery] Failed to disable Cue:', err));
		}
	}, [encoreFeatures.maestroCue, sessions, sessionsLoaded]);
}

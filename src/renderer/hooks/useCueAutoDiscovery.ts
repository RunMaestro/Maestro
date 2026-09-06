import { useEffect, useRef } from 'react';
import type { EncoreFeatureFlags } from '../types';
import { useSessionStore } from '../stores/sessionStore';
import { selectCueDiscoverySignature } from '../stores/sessionEquality';
import { notifyToast } from '../stores/notificationStore';
import { captureException } from '../utils/sentry';
import { logger } from '../utils/logger';

/**
 * useCueAutoDiscovery - auto-discovers .maestro/cue.yaml files for sessions.
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
 *
 * PERF: Subscribes to a compact id+projectRoot signature (not the full
 * sessions array) so streaming log/token updates do not re-render App.
 * Session objects are read via getState() inside effects at event time.
 */
export function useCueAutoDiscovery(encoreFeatures: EncoreFeatureFlags, isLifecycleOwner = true) {
	const sessionsLoaded = useSessionStore((s) => s.sessionsLoaded);
	const cueDiscoverySignature = useSessionStore(selectCueDiscoverySignature);
	// id → projectRoot so root moves (same id, new cwd) are detected.
	const prevSessionRootsRef = useRef<Map<string, string>>(new Map());
	const prevMaestroCueEnabledRef = useRef<boolean>(encoreFeatures.maestroCue);
	const initialScanDoneRef = useRef(false);
	const lifecycleOwnerRef = useRef(isLifecycleOwner);
	const lifecycleGenerationRef = useRef(0);
	// Serializes in-flight enable/disable IPC calls so rapid toggles
	// (ON → OFF → ON) can't interleave and leave the engine in a state
	// that disagrees with the observed flag value.
	const toggleChainRef = useRef<Promise<void>>(Promise.resolve());

	// Invalidate queued toggle work whenever lifecycle ownership changes or the
	// hook unmounts. A queued callback must re-check this token before IPC work.
	useEffect(() => {
		lifecycleOwnerRef.current = isLifecycleOwner;
		const generation = ++lifecycleGenerationRef.current;
		return () => {
			if (lifecycleGenerationRef.current === generation) {
				lifecycleGenerationRef.current += 1;
				lifecycleOwnerRef.current = false;
			}
		};
	}, [isLifecycleOwner]);

	// Track session additions, removals, and projectRoot moves - always runs
	// regardless of encore flag
	useEffect(() => {
		if (!isLifecycleOwner || !sessionsLoaded) return;

		const sessions = useSessionStore.getState().sessions;
		const currentRoots = new Map(sessions.map((s) => [s.id, s.projectRoot ?? '']));
		const prevRoots = prevSessionRootsRef.current;

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
			prevSessionRootsRef.current = currentRoots;
			return;
		}

		// --- Detect new sessions and projectRoot moves ---
		for (const session of sessions) {
			const root = session.projectRoot ?? '';
			const prevRoot = prevRoots.get(session.id);

			if (prevRoot === undefined) {
				if (root) {
					window.maestro.cue
						.refreshSession(session.id, root)
						.catch((err) =>
							logger.error('[CueAutoDiscovery] Failed to refresh session:', undefined, err)
						);
				}
				continue;
			}

			if (prevRoot === root) continue;

			// Same agent id, different root: clear the old registration then
			// refresh against the new path (or leave cleared if root is empty).
			window.maestro.cue
				.removeSession(session.id)
				.then(() => {
					if (!root) return;
					return window.maestro.cue.refreshSession(session.id, root);
				})
				.catch((err) =>
					logger.error('[CueAutoDiscovery] Failed to move session projectRoot:', undefined, err)
				);
		}

		// --- Detect removed sessions ---
		for (const prevId of prevRoots.keys()) {
			if (!currentRoots.has(prevId)) {
				window.maestro.cue
					.removeSession(prevId)
					.catch((err) =>
						logger.error('[CueAutoDiscovery] Failed to remove session:', undefined, err)
					);
			}
		}

		prevSessionRootsRef.current = currentRoots;
	}, [cueDiscoverySignature, isLifecycleOwner, sessionsLoaded]);

	// Track encore feature toggle. Queues enable/disable calls on a single
	// chain so rapid ON/OFF/ON toggles always apply in the order the user
	// triggered them - not in IPC-response order.
	useEffect(() => {
		if (!isLifecycleOwner || !sessionsLoaded) return;

		const wasEnabled = prevMaestroCueEnabledRef.current;
		const isEnabled = encoreFeatures.maestroCue;
		prevMaestroCueEnabledRef.current = isEnabled;

		if (wasEnabled === isEnabled) return;

		const sessionsSnapshot = useSessionStore
			.getState()
			.sessions.filter((session) => !!session.projectRoot);
		const lifecycleGeneration = lifecycleGenerationRef.current;
		const canRun = () =>
			lifecycleOwnerRef.current && lifecycleGenerationRef.current === lifecycleGeneration;

		toggleChainRef.current = toggleChainRef.current.then(async () => {
			if (!canRun()) return;
			if (isEnabled) {
				try {
					if (!canRun()) return;
					await window.maestro.cue.enable();
					if (!canRun()) return;
					await Promise.all(
						sessionsSnapshot.map((session) =>
							canRun()
								? window.maestro.cue
										.refreshSession(session.id, session.projectRoot)
										.catch((err) =>
											logger.error('[CueAutoDiscovery] Failed to refresh session:', undefined, err)
										)
								: Promise.resolve()
						)
					);
				} catch (err) {
					if (!canRun()) return;
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
					if (!canRun()) return;
					await window.maestro.cue.disable();
				} catch (err) {
					if (!canRun()) return;
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
	}, [encoreFeatures.maestroCue, isLifecycleOwner, sessionsLoaded]);
}

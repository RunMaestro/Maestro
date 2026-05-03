/**
 * Mirrors the active session's terminal tab state to the main-process coworking
 * registry. The registry is what the MCP `list_terminals` tool reads from; this
 * hook is what keeps it accurate.
 *
 * Strategy: subscribe to the session store and re-sync whenever the active
 * session id, the active session's terminal tabs, or any tab's metadata change.
 * Cheap because it's just an IPC call with a small array.
 *
 * Gated on the `coworking` Encore flag — when off, we proactively send a null
 * active session so the registry empties and `list_terminals` returns [].
 */

import { useEffect, useRef } from 'react';
import { useSessionStore, selectActiveSession } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { getTerminalTabDisplayName } from '../../utils/terminalTabHelpers';
import { captureException } from '../../utils/sentry';

/** Errors we expect during teardown / pre-init — silently ignore. Anything else
 *  bubbles up to Sentry so we can see real bridge failures in production. */
function isExpectedTeardownIpcError(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	return /No handler registered|Object has been destroyed|cannot be cloned/i.test(err.message);
}

function reportIfUnexpected(err: unknown, scope: string): void {
	if (isExpectedTeardownIpcError(err)) return;
	void captureException(err instanceof Error ? err : new Error(String(err)), {
		extra: { scope: `useCoworkingRegistrySync:${scope}` },
	});
}

export function useCoworkingRegistrySync(): void {
	const activeSession = useSessionStore(selectActiveSession);
	const enabled = useSettingsStore((s) => s.encoreFeatures?.coworking ?? false);
	const lastPayloadRef = useRef<string>('');

	useEffect(() => {
		// Bail out cleanly when the coworking bridge isn't exposed (e.g. in test
		// harnesses that mock `window.maestro` without the namespace, or in older
		// preload bundles before this PR shipped). The hook is best-effort —
		// without the bridge there's nothing to sync to.
		const bridge = window.maestro?.coworking;
		if (!bridge) {
			lastPayloadRef.current = '';
			return;
		}

		if (!enabled) {
			bridge.setActiveSession(null).catch((err) => reportIfUnexpected(err, 'disable'));
			lastPayloadRef.current = '';
			return;
		}

		if (!activeSession) {
			bridge.setActiveSession(null).catch((err) => reportIfUnexpected(err, 'no-active-session'));
			lastPayloadRef.current = '';
			return;
		}

		const sessionId = activeSession.id;
		// Use the original-array index for `getTerminalTabDisplayName` so the auto-generated
		// "Terminal N" fallback name stays stable for tabs the agent sees, even if some
		// pre-feature tabs in the array lack a `coworkingId`.
		const allTabs = activeSession.terminalTabs ?? [];
		const records = allTabs
			.map((t, idx) => ({ tab: t, idx }))
			.filter(({ tab }) => typeof tab.coworkingId === 'number')
			.map(({ tab, idx }) => ({
				id: `term:${tab.coworkingId}`,
				cwd: tab.cwd ?? '',
				title: getTerminalTabDisplayName(tab, idx),
				tabUuid: tab.id,
				sessionId,
			}));

		// Skip the IPC if nothing has changed since last sync (cheap stringify of small payload).
		const payload = JSON.stringify({ sessionId, records });
		if (payload === lastPayloadRef.current) return;
		lastPayloadRef.current = payload;

		(async () => {
			try {
				await bridge.setActiveSession(sessionId);
				await bridge.syncSessionTerminals(sessionId, records);
			} catch (err) {
				reportIfUnexpected(err, 'sync');
			}
		})();
	}, [enabled, activeSession]);
}

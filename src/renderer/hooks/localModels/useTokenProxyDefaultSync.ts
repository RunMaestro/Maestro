import { useEffect } from 'react';

import { useIsLifecycleOwner } from '../../contexts/WindowContext';
import { syncAgentsToTokenProxyDefault } from '../../services/agentGateway';
import { useSessionStore } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { logger } from '../../utils/logger';

/**
 * Keep every agent that follows the Maestro proxy default on it.
 *
 * Mount once, in the app shell. In the window that owns app-wide effects it
 * runs the sync once settings and agents are read, and again whenever
 * `defaultTokenProxyMode` changes: from this window's Gateway section, from
 * another window, or from `maestro-cli settings set defaultTokenProxyMode`
 * (each reaches this window as a settings reload). A default changed while the
 * app was closed is applied by the first run. Every other window does nothing,
 * so the agents have one writer.
 */
export function useTokenProxyDefaultSync(): void {
	const isLifecycleOwner = useIsLifecycleOwner();
	const mode = useSettingsStore((s) => s.defaultTokenProxyMode);
	const settingsLoaded = useSettingsStore((s) => s.settingsLoaded);
	const sessionsReadOk = useSessionStore((s) => s.sessionsReadOk);

	useEffect(() => {
		if (!isLifecycleOwner || !settingsLoaded || !sessionsReadOk) return;
		syncAgentsToTokenProxyDefault().catch((error: unknown) => {
			logger.warn('[TokenProxyDefault] Could not apply the proxy default', undefined, error);
		});
	}, [isLifecycleOwner, settingsLoaded, sessionsReadOk, mode]);
}

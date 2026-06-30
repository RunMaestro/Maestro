/**
 * Hidden host that keeps background <webview>s alive for cross-session coworking
 * browser access. Renders the tabs requested in coworkingBackgroundBrowserStore
 * off-screen (fixed, far off the left edge, pointer-events:none, aria-hidden) so
 * their guest WebContents run (DOM reads + interaction work) without disturbing
 * the user. Each tab mounts with its own `partition`, so per-session browser
 * data is preserved. Mounts are capped + LRU-evicted by the store.
 *
 * onUpdateTab routes to the OWNING session (not the active session) so a
 * background navigation keeps that agent's tab metadata fresh.
 */

import { useCallback, useEffect } from 'react';
import { BrowserTabView } from '../MainPanel/BrowserTabView';
import type { BrowserTab, Theme } from '../../types';
import { useCoworkingBackgroundBrowserStore } from '../../stores/coworkingBackgroundBrowserStore';
import { useSessionStore, updateSessionWith } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { normalizeBrowserTabUpdates } from '../../hooks/tabs/internal/browserTabHelpers';

export function CoworkingBackgroundBrowsers({ theme }: { theme: Theme }) {
	const mounts = useCoworkingBackgroundBrowserStore((s) => s.mounts);
	const setHandle = useCoworkingBackgroundBrowserStore((s) => s.setHandle);
	const clear = useCoworkingBackgroundBrowserStore((s) => s.clear);
	const enabled = useSettingsStore((s) => s.coworkingBackgroundBrowsers);
	const sessions = useSessionStore((s) => s.sessions);

	const handleBackgroundTabUpdate = useCallback(
		(sessionId: string, tabId: string, updates: Partial<BrowserTab>) => {
			updateSessionWith(sessionId, (session) => ({
				...session,
				browserTabs: (session.browserTabs ?? []).map((t) =>
					t.id === tabId ? normalizeBrowserTabUpdates(t, updates) : t
				),
			}));
		},
		[]
	);

	// Opt-out releases every hidden webview (each is a renderer process).
	useEffect(() => {
		if (!enabled) clear();
	}, [enabled, clear]);

	if (!enabled || mounts.length === 0) return null;

	return (
		<div
			aria-hidden
			style={{
				position: 'fixed',
				left: -100000,
				top: 0,
				width: 1024,
				height: 768,
				overflow: 'hidden',
				opacity: 0,
				pointerEvents: 'none',
			}}
		>
			{mounts.map((m) => {
				const session = sessions.find((s) => s.id === m.sessionId);
				const tab = session?.browserTabs?.find((t) => t.id === m.tabUuid);
				if (!tab) return null;
				return (
					<div key={m.key} style={{ width: 1024, height: 768 }}>
						<BrowserTabView
							ref={(h) => setHandle(m.key, h)}
							tab={tab}
							theme={theme}
							isActive={false}
							onUpdateTab={(tid, updates) => handleBackgroundTabUpdate(m.sessionId, tid, updates)}
						/>
					</div>
				);
			})}
		</div>
	);
}

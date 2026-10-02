import { useEffect, useRef } from 'react';
import type { BrowserRelayTarget } from '../../../shared/browserRelay';
import { useSessionStore, updateSessionWith } from '../../stores/sessionStore';
import { useWindowContextOptional } from '../../contexts/WindowContext';
import { createBrowserTab, normalizeBrowserTabUpdates } from '../tabs/internal/browserTabHelpers';
import { getBrowserTabTitle, toWebviewSrc } from '../../utils/browserTabPersistence';
import { isWebDesktop } from '../../utils/runtimeContext';
import { DEFAULT_BROWSER_TAB_URL } from '../../utils/browserTabPersistence';
import { useSettingsStore } from '../../stores/settingsStore';
import { ensureInUnifiedTabOrder } from '../../utils/tabHelpers';
import { prepareSessionForPersistence } from '../utils/useDebouncedPersistence';

/** The trusted owning renderer authorizes existing tabs; main owns every browser workload. */
export function useHostBrowserRelayResponder(): void {
	const context = useWindowContextOptional();
	const contextRef = useRef(context);
	contextRef.current = context;
	useEffect(() => {
		if (isWebDesktop()) return;
		const api = window.maestro.browserSession;
		const known = new Map<string, BrowserRelayTarget>();
		const unsubscribe = api.onRelayRequest((request) => {
			try {
				if (contextRef.current && !contextRef.current.ownsSession(request.sessionId))
					throw new Error('Browser session belongs to a different owning host window');
				const session = useSessionStore
					.getState()
					.sessions.find((candidate) => candidate.id === request.sessionId);
				const tab = session?.browserTabs?.find((candidate) => candidate.id === request.tabId);
				if (!tab?.partition)
					throw new Error('Browser tab does not exist in the requested host session');
				api.relayRespond(request.requestId, {
					ok: true,
					partition: tab.partition,
					initialUrl: toWebviewSrc(tab.url),
				});
			} catch (error) {
				api.relayRespond(request.requestId, {
					ok: false,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		});
		const creations = api.onCreateTabRequest((request) => {
			void (async () => {
				if (contextRef.current && !contextRef.current.ownsSession(request.sessionId))
					throw new Error('Browser session belongs to a different owning host window');
				const baseline = useSessionStore
					.getState()
					.sessions.find((session) => session.id === request.sessionId);
				if (!baseline) throw new Error('Host session does not exist');
				if (!useSessionStore.getState().sessionsReadOk)
					throw new Error('Host sessions are not ready for browser creation');
				const url =
					request.options.url ??
					useSettingsStore.getState().browserHomeUrl ??
					DEFAULT_BROWSER_TAB_URL;
				const tab = createBrowserTab(baseline.id, url, {
					title: request.options.title,
					ephemeral: request.options.ephemeral,
					isLoading: url !== DEFAULT_BROWSER_TAB_URL,
				});
				updateSessionWith(baseline.id, (session) => ({
					...session,
					browserTabs: [...(session.browserTabs ?? []), tab],
					unifiedTabOrder: ensureInUnifiedTabOrder(
						session.unifiedTabOrder ?? [],
						'browser',
						tab.id
					),
				}));
				if (!tab.ephemeral) {
					const updated = useSessionStore
						.getState()
						.sessions.find((session) => session.id === baseline.id);
					if (!updated) throw new Error('Host session closed during browser creation');
					const saved = await window.maestro.sessions.setMany(
						[prepareSessionForPersistence(updated)],
						[],
						[prepareSessionForPersistence(baseline)]
					);
					if (saved === false) throw new Error('Host browser tab could not be persisted');
				}
				const registered = useSessionStore
					.getState()
					.sessions.find((session) => session.id === baseline.id)
					?.browserTabs?.find((candidate) => candidate.id === tab.id);
				if (!registered) throw new Error('Host browser tab closed before acknowledgement');
				api.relayRespond(request.requestId, { ok: true, value: registered });
			})().catch((error) =>
				api.relayRespond(request.requestId, {
					ok: false,
					error: error instanceof Error ? error.message : String(error),
				})
			);
		});
		const events = api.onPageEvent((event) => {
			const id = JSON.stringify([event.target.sessionId, event.target.tabId]);
			known.set(id, event.target);
			const session = useSessionStore
				.getState()
				.sessions.find((candidate) => candidate.id === event.target.sessionId);
			const tab = session?.browserTabs?.find((candidate) => candidate.id === event.target.tabId);
			if (!tab) {
				known.delete(id);
				void api.pageClose(event.target);
				return;
			}
			const state = event.state;
			const title = getBrowserTabTitle(state.url, state.title || tab.title);
			if (
				tab.url === state.url &&
				tab.title === title &&
				tab.canGoBack === state.canGoBack &&
				tab.canGoForward === state.canGoForward &&
				tab.isLoading === state.isLoading &&
				tab.webContentsId === state.webContentsId &&
				tab.favicon === state.favicon
			)
				return;
			updateSessionWith(event.target.sessionId, (current) => ({
				...current,
				browserTabs: (current.browserTabs ?? []).map((browser) =>
					browser.id === event.target.tabId
						? normalizeBrowserTabUpdates(browser, {
								url: state.url,
								title,
								canGoBack: state.canGoBack,
								canGoForward: state.canGoForward,
								isLoading: state.isLoading,
								webContentsId: state.webContentsId,
								favicon: state.favicon,
							})
						: browser
				),
			}));
		});
		const sessions = useSessionStore.subscribe((state) => {
			for (const [id, target] of known) {
				if (
					state.sessions.some(
						(session) =>
							session.id === target.sessionId &&
							session.browserTabs?.some((tab) => tab.id === target.tabId)
					)
				)
					continue;
				known.delete(id);
				void api.pageClose(target);
			}
		});
		void api.relayReady(true);
		return () => {
			unsubscribe();
			creations();
			events();
			sessions();
			void api.relayReady(false);
		};
	}, []);
}

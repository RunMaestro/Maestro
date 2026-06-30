/**
 * Answers `coworking:requestBrowserOp` events from main by resolving the target
 * browser tab's live BrowserTabView handle and running the requested BrowserOp.
 *
 * Resolution policy (decision A'): prefer an already-mounted webview handle. The
 * active agent's browser tabs are kept mounted (visible, or hidden via the
 * browserTabKeepAlive setting) by useBrowserTabMounting, so reads never steal
 * focus when the tab is already live. Only when the target tab isn't mounted do
 * we activate it (which mounts it), run the op, then restore the previously
 * active browser tab.
 *
 * Scope: the live webview only exists for the ACTIVE agent. If the requesting
 * session isn't the focused agent, we return a clear ok:false result. The
 * metadata tools (list_browsers / get_browser_url) still work cross-session
 * because they read the registry mirror, not a live webview.
 */

import { useEffect } from 'react';
import type { MutableRefObject } from 'react';
import type { BrowserTabViewHandle } from '../../components/MainPanel/BrowserTabView';
import type { BrowserOp, BrowserOpResult } from '../../../shared/coworkingBrowser';
import { useSessionStore, selectActiveSession } from '../../stores/sessionStore';
import { captureException } from '../../utils/sentry';

/** Promise-based delay (ES2024 Promise.withResolvers, ambient-typed for the
 *  project's ES2020 lib). Used to poll for the activated tab's handle. */
function delay(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

async function applyBrowserOp(
	handle: BrowserTabViewHandle,
	op: BrowserOp
): Promise<BrowserOpResult> {
	switch (op.kind) {
		case 'read': {
			const content = await handle.extract(op.format);
			const meta = handle.getMeta();
			return { ok: true, content, url: meta.url, title: meta.title };
		}
		default:
			// Interaction ops (navigate / click / type / eval / back / forward / ...)
			// are wired in a later phase behind the browser-interaction permission.
			// Until then the bridge never dispatches them, so this stays unreachable.
			return { ok: false, content: `Unsupported browser op: ${op.kind}` };
	}
}

async function resolveAndRun(
	browserViewRefs: MutableRefObject<Map<string, BrowserTabViewHandle>>,
	selectBrowserTab: (sessionId: string, tabUuid: string) => void,
	tabUuid: string,
	sessionId: string,
	op: BrowserOp
): Promise<BrowserOpResult> {
	const active = selectActiveSession(useSessionStore.getState());
	if (!active || active.id !== sessionId) {
		return {
			ok: false,
			content:
				'Browser tab is not live: its Maestro agent is not currently focused. ' +
				'list_browsers and get_browser_url still work; focus this agent to read or drive its browser tabs.',
		};
	}

	// Fast path: the tab is already mounted (visible or kept-alive hidden) - use
	// its handle directly so we never steal focus.
	const mounted = browserViewRefs.current.get(tabUuid);
	if (mounted && mounted.getTabId() === tabUuid) {
		return applyBrowserOp(mounted, op);
	}

	// Fallback: activate the tab so it mounts, run the op, then restore the
	// previously active browser tab. The session guard above guarantees the tab
	// belongs to the focused agent, so activating within that agent is correct.
	const prevActiveBrowserTabId = active.activeBrowserTabId;
	selectBrowserTab(sessionId, tabUuid);
	let handle: BrowserTabViewHandle | undefined;
	for (let i = 0; i < 40; i++) {
		await delay(50);
		const candidate = browserViewRefs.current.get(tabUuid);
		if (candidate && candidate.getTabId() === tabUuid) {
			handle = candidate;
			break;
		}
	}
	try {
		if (!handle) {
			return {
				ok: false,
				content: 'Browser tab could not be mounted (it may have been closed).',
			};
		}
		return await applyBrowserOp(handle, op);
	} finally {
		if (prevActiveBrowserTabId && prevActiveBrowserTabId !== tabUuid) {
			selectBrowserTab(sessionId, prevActiveBrowserTabId);
		}
	}
}

export function useCoworkingBrowserResponder(
	browserViewRefs: MutableRefObject<Map<string, BrowserTabViewHandle>>,
	selectBrowserTab: (sessionId: string, tabUuid: string) => void
): void {
	useEffect(() => {
		const bridge = window.maestro?.coworking;
		if (!bridge) return;
		const off = bridge.onRequestBrowserOp((tabUuid, sessionId, op, responseChannel) => {
			void (async () => {
				let result: BrowserOpResult;
				try {
					result = await resolveAndRun(browserViewRefs, selectBrowserTab, tabUuid, sessionId, op);
				} catch (err) {
					// Unexpected failures degrade to a clear ok:false for the agent, but
					// are captured so they're visible in production instead of swallowed.
					captureException(err instanceof Error ? err : new Error(String(err)), {
						extra: { context: 'useCoworkingBrowserResponder', tabUuid, sessionId, kind: op.kind },
					});
					result = { ok: false, content: err instanceof Error ? err.message : String(err) };
				}
				bridge.sendBrowserOpResponse(responseChannel, result);
			})();
		});
		return off;
	}, [browserViewRefs, selectBrowserTab]);
}

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
import {
	browserOpNeedsConfirm,
	DEFAULT_BROWSER_CONFIRM_POLICY,
} from '../../../shared/coworkingBrowser';
import { useSessionStore, selectActiveSession, selectSessionById } from '../../stores/sessionStore';
import { captureException } from '../../utils/sentry';
import { useSettingsStore } from '../../stores/settingsStore';
import { requestCoworkingApproval } from '../../stores/coworkingApprovalStore';
import {
	useCoworkingBackgroundBrowserStore,
	backgroundBrowserKey,
} from '../../stores/coworkingBackgroundBrowserStore';

/** Promise-based delay (ES2024 Promise.withResolvers, ambient-typed for the
 *  project's ES2020 lib). Used to poll for the activated tab's handle. */
function delay(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

/** Decides whether a browser op needs per-call approval and, if so, prompts the
 *  user. Returns true to proceed, false to decline. */
export type BrowserApprovalRequester = (
	op: BrowserOp,
	ctx: { agentId: string; sessionId: string }
) => Promise<boolean>;

/** Human-readable phrase describing what a browser op will do (for the approval
 *  dialog). Truncates free-form text/code so the dialog stays readable. */
function describeBrowserOp(op: BrowserOp): string {
	switch (op.kind) {
		case 'navigate':
			return `navigate the browser to ${op.url}`;
		case 'click':
			return `click the element ${op.selector}`;
		case 'type':
			return `type into ${op.selector}: "${op.text.slice(0, 120)}"`;
		case 'eval':
			return `run JavaScript in the page:\n${op.code.slice(0, 300)}`;
		case 'back':
			return 'navigate the browser back';
		case 'forward':
			return 'navigate the browser forward';
		case 'reload':
			return 'reload the browser page';
		case 'stop':
			return 'stop the browser load';
		case 'screenshot':
			return 'capture a screenshot of the page';
		case 'read':
			return 'read the page content';
		default:
			return 'perform a browser action';
	}
}

/** Default approval requester: reads the per-agent confirm policy and, when the
 *  op needs approval, shows the confirm dialog and awaits the user's decision. */
async function defaultRequestApproval(
	op: BrowserOp,
	ctx: { agentId: string; sessionId: string }
): Promise<boolean> {
	if (op.kind === 'read') return true;
	const policyMap = useSettingsStore.getState().coworkingBrowserInteractionConfirm;
	const policy = policyMap[ctx.agentId] ?? DEFAULT_BROWSER_CONFIRM_POLICY;
	if (!browserOpNeedsConfirm(policy, op.kind)) return true;
	return requestCoworkingApproval({
		agentId: ctx.agentId,
		sessionId: ctx.sessionId,
		title: 'Allow browser action?',
		message: `The "${ctx.agentId}" agent wants to ${describeBrowserOp(op)}.`,
	});
}

export async function applyBrowserOp(
	handle: BrowserTabViewHandle,
	op: BrowserOp
): Promise<BrowserOpResult> {
	switch (op.kind) {
		case 'read': {
			const content = await handle.extract(op.format);
			const meta = handle.getMeta();
			return { ok: true, content, url: meta.url, title: meta.title };
		}
		case 'navigate': {
			const url = handle.navigate(op.url);
			return { ok: true, url, content: `navigated to ${url}` };
		}
		case 'back':
			handle.goBack();
			return { ok: true, content: 'went back' };
		case 'forward':
			handle.goForward();
			return { ok: true, content: 'went forward' };
		case 'reload':
			handle.reload();
			return { ok: true, content: 'reloaded' };
		case 'stop':
			handle.stop();
			return { ok: true, content: 'stopped loading' };
		case 'click': {
			const res = await handle.executeJavaScript(
				`(function(){var el=document.querySelector(${JSON.stringify(op.selector)});if(!el)return 'notfound';el.click();return 'ok';})()`
			);
			if (res === 'notfound') {
				return { ok: false, content: `No element matches selector: ${op.selector}` };
			}
			return { ok: true, content: `clicked ${op.selector}` };
		}
		case 'type': {
			const res = await handle.executeJavaScript(
				`(function(){var el=document.querySelector(${JSON.stringify(op.selector)});if(!el)return 'notfound';if(el.focus)el.focus();if('value' in el){el.value=${JSON.stringify(op.text)};el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));}else{el.textContent=${JSON.stringify(op.text)};}return 'ok';})()`
			);
			if (res === 'notfound') {
				return { ok: false, content: `No element matches selector: ${op.selector}` };
			}
			return { ok: true, content: `typed into ${op.selector}` };
		}
		case 'eval': {
			const res = await handle.executeJavaScript(op.code);
			let text: string;
			if (typeof res === 'string') {
				text = res;
			} else {
				try {
					text = JSON.stringify(res) ?? String(res);
				} catch {
					text = String(res);
				}
			}
			return { ok: true, content: text };
		}
		case 'screenshot': {
			const dataUrl = await handle.capturePage();
			// capturePage on a hidden/off-screen webview returns nothing (Electron
			// captures the visible compositor surface). Surface that clearly rather
			// than handing the agent an empty image.
			if (!dataUrl || dataUrl.length < 64) {
				return {
					ok: false,
					content:
						'Screenshot unavailable: this browser tab is not visible (background tabs capture nothing). ' +
						'Focus this agent to screenshot its browser tab.',
				};
			}
			return { ok: true, dataUrl, content: 'captured screenshot' };
		}
		default:
			return { ok: false, content: 'Unsupported browser op' };
	}
}

export async function resolveAndRun(
	browserViewRefs: MutableRefObject<Map<string, BrowserTabViewHandle>>,
	selectBrowserTab: (sessionId: string, tabUuid: string) => void,
	tabUuid: string,
	sessionId: string,
	op: BrowserOp,
	requestApproval: BrowserApprovalRequester,
	resolveBackgroundHandle?: (
		sessionId: string,
		tabUuid: string
	) => Promise<BrowserTabViewHandle | null>
): Promise<BrowserOpResult> {
	const state = useSessionStore.getState();
	const active = selectActiveSession(state);
	const isFocused = !!active && active.id === sessionId;
	const requesting = isFocused ? active : selectSessionById(sessionId)(state);
	if (!requesting) {
		return {
			ok: false,
			content: 'Browser tab is not live: its Maestro agent session was not found.',
		};
	}

	// Per-call approval for state-changing ops, BEFORE any focus change, mount,
	// or side effect. read ops are never gated. Uses the REQUESTING agent's
	// policy, not the focused one.
	if (op.kind !== 'read') {
		const approved = await requestApproval(op, { agentId: requesting.toolType, sessionId });
		if (!approved) {
			return { ok: false, content: 'Browser action declined by the user.' };
		}
	}

	// Focused agent: operate on the live (visible or kept-alive hidden) webview.
	if (isFocused) {
		// Fast path: the tab is already mounted - use its handle directly so we
		// never steal focus.
		const mounted = browserViewRefs.current.get(tabUuid);
		if (mounted && mounted.getTabId() === tabUuid) {
			return applyBrowserOp(mounted, op);
		}

		// Fallback: activate the tab so it mounts, run the op, then restore the
		// previously active browser tab. The focus guard guarantees the tab
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

	// Cross-session: the requesting agent is not focused, so there is no live
	// webview in the active UI. If the opt-in background host is available, mount
	// the tab off-screen and operate on it without disturbing the user.
	if (resolveBackgroundHandle) {
		const bgHandle = await resolveBackgroundHandle(sessionId, tabUuid);
		if (bgHandle && bgHandle.getTabId() === tabUuid) {
			// Guard the tab against LRU eviction for the duration of the op so a
			// concurrent cross-session mount can't unmount its webview mid-run.
			const store = useCoworkingBackgroundBrowserStore.getState();
			const key = backgroundBrowserKey(sessionId, tabUuid);
			store.markOpStart(key);
			try {
				return await applyBrowserOp(bgHandle, op);
			} finally {
				store.markOpEnd(key);
			}
		}
	}

	return {
		ok: false,
		content:
			'Browser tab is not live: its Maestro agent is not focused and background browsing is off. ' +
			'list_browsers and get_browser_url still work; focus this agent (or enable background ' +
			'Coworking browsers in Settings) to read or drive its browser tabs.',
	};
}

/** Resolves a non-focused agent's tab to a live handle via the opt-in,
 *  capped background webview host. Mounts the tab off-screen on demand and
 *  polls for its handle. Returns null when the feature is off or the tab
 *  cannot be mounted (then the caller surfaces a clear ok:false). */
async function defaultResolveBackgroundHandle(
	sessionId: string,
	tabUuid: string
): Promise<BrowserTabViewHandle | null> {
	const settings = useSettingsStore.getState();
	if (!settings.coworkingBackgroundBrowsers) return null;
	const store = useCoworkingBackgroundBrowserStore.getState();
	store.requestMount(sessionId, tabUuid, settings.coworkingBackgroundBrowsersLimit);
	const key = backgroundBrowserKey(sessionId, tabUuid);
	for (let i = 0; i < 60; i++) {
		await delay(50);
		const handle = useCoworkingBackgroundBrowserStore.getState().handles.get(key);
		if (handle && handle.getTabId() === tabUuid) {
			useCoworkingBackgroundBrowserStore.getState().touch(key);
			return handle;
		}
	}
	return null;
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
					result = await resolveAndRun(
						browserViewRefs,
						selectBrowserTab,
						tabUuid,
						sessionId,
						op,
						defaultRequestApproval,
						defaultResolveBackgroundHandle
					);
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

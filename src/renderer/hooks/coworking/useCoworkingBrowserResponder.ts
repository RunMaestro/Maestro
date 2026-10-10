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
	BROWSER_APPROVAL_TIMEOUT_MS,
} from '../../../shared/coworkingBrowser';
import { useSessionStore, selectActiveSession, selectSessionById } from '../../stores/sessionStore';
import { captureException } from '../../utils/sentry';
import { useSettingsStore } from '../../stores/settingsStore';
import { requestCoworkingApproval } from '../../stores/coworkingApprovalStore';
import {
	useCoworkingBackgroundBrowserStore,
	backgroundBrowserKey,
} from '../../stores/coworkingBackgroundBrowserStore';
import { useCoworkingBrowserKeepAliveStore } from '../../stores/coworkingBrowserKeepAliveStore';
import { createBrowserTab } from '../tabs/internal/browserTabHelpers';
import { closeBrowserTab } from '../../utils/tabHelpers';
import { insertAfterActiveInUnifiedTabOrder } from '../../utils/unifiedTabOrderUtils';
import {
	DEFAULT_BROWSER_TAB_URL,
	resolveBrowserTabNavigationTarget,
} from '../../utils/browserTabPersistence';

/** Promise-based delay (ES2024 Promise.withResolvers, ambient-typed for the
 *  project's ES2020 lib). Used to poll for the activated tab's handle. */
function delay(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

/** Poll `browserViewRefs` for a mounted tab's live handle (up to ~2s). Returns
 *  the handle once its BrowserTabView has mounted and registered, else undefined. */
async function pollForHandle(
	browserViewRefs: MutableRefObject<Map<string, BrowserTabViewHandle>>,
	tabUuid: string
): Promise<BrowserTabViewHandle | undefined> {
	for (let i = 0; i < 40; i++) {
		await delay(50);
		const candidate = browserViewRefs.current.get(tabUuid);
		if (candidate && candidate.getTabId() === tabUuid) return candidate;
	}
	return undefined;
}

/** Decides whether a browser op needs per-call approval and, if so, prompts the
 *  user. Returns true to proceed, false to decline. */
export type BrowserApprovalRequester = (
	op: BrowserOp,
	ctx: {
		agentId: string;
		sessionId: string;
		/** Main-process approval-requirement computation (from the policy mirrored
		 *  into the registry). ORed with the local policy - either side saying
		 *  "confirm" forces the dialog, so a stale renderer settings read can
		 *  never weaken the gate. */
		forceConfirm?: boolean;
	}
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
		case 'waitFor':
			return `wait for the element ${op.selector}`;
		case 'newTab':
			return `open a new${op.ephemeral ? ' incognito' : ''} browser tab${op.url ? ` at ${op.url}` : ''}`;
		case 'closeTab':
			return 'close this browser tab';
		default:
			return 'perform a browser action';
	}
}

/** Default approval requester: reads the per-agent confirm policy and, when the
 *  op needs approval, shows the confirm dialog and awaits the user's decision. */
async function defaultRequestApproval(
	op: BrowserOp,
	ctx: { agentId: string; sessionId: string; forceConfirm?: boolean }
): Promise<boolean> {
	if (op.kind === 'read') return true;
	const policyMap = useSettingsStore.getState().coworkingBrowserInteractionConfirm;
	const policy = policyMap[ctx.agentId] ?? DEFAULT_BROWSER_CONFIRM_POLICY;
	if (!ctx.forceConfirm && !browserOpNeedsConfirm(policy, op.kind)) return true;
	return requestCoworkingApproval(
		{
			agentId: ctx.agentId,
			sessionId: ctx.sessionId,
			title: 'Allow browser action?',
			message: `The "${ctx.agentId}" agent wants to ${describeBrowserOp(op)}.`,
		},
		// Auto-decline before the main resolver's interaction timeout so a late
		// decision never executes the op after the caller has already given up.
		BROWSER_APPROVAL_TIMEOUT_MS
	);
}

/** Create a browser tab in the requesting session (the `newTab` op). The tab is
 *  appended to the session's tab strip and selected within that session; if the
 *  session isn't focused, nothing changes on screen until the user switches to
 *  it. The new tab gets its `browser:N` id on the next registry sync, so the
 *  result tells the agent to call list_browsers. */
function createTabForSession(
	sessionId: string,
	op: { url?: string; ephemeral?: boolean }
): BrowserOpResult {
	// Normalize like browser_navigate does: scheme-less hosts and search text go
	// through the same resolver, so the agent never gets a "successful" tab whose
	// webview src is raw unloadable text.
	let targetUrl = DEFAULT_BROWSER_TAB_URL;
	if (op.url) {
		const resolved = resolveBrowserTabNavigationTarget(op.url);
		if (resolved.kind === 'error') {
			return { ok: false, content: resolved.message };
		}
		targetUrl = resolved.url;
	}
	const { setSessions } = useSessionStore.getState();
	const created = createBrowserTab(sessionId, targetUrl, {
		ephemeral: op.ephemeral === true,
	});
	// The session-existence check happens BEFORE the approval await, so a session
	// closed during approval would otherwise drop the tab silently while telling
	// the agent success. Track whether the updater actually matched the session.
	let sessionFound = false;
	setSessions((prev) =>
		prev.map((s) => {
			if (s.id !== sessionId) return s;
			sessionFound = true;
			const base = {
				...s,
				browserTabs: [...(s.browserTabs || []), created],
				unifiedTabOrder: insertAfterActiveInUnifiedTabOrder(s, {
					type: 'browser',
					id: created.id,
				}),
			};
			// Only bring the new tab into view if the user is ALREADY on a browser
			// tab in this session (opening another browser tab is then a natural
			// continuation). Otherwise leave their surface untouched so an agent
			// opening a tab never hijacks their chat/terminal/file view - it still
			// appears in the tab strip and the agent drives it hidden via the pin.
			if (!(s.inputMode === 'ai' && s.activeBrowserTabId)) return base;
			return {
				...base,
				activeFileTabId: null,
				activeBrowserTabId: created.id,
				activeTerminalTabId: null,
				inputMode: 'ai' as const,
			};
		})
	);
	if (!sessionFound) {
		return {
			ok: false,
			content: 'Session no longer exists; the tab could not be created.',
		};
	}
	// Pin the freshly-opened tab so it stays mounted from creation - the agent
	// usually navigates/reads it next, and it must not unmount the instant the
	// user clicks away before that first follow-up op.
	useCoworkingBrowserKeepAliveStore.getState().pin(created.id);
	return {
		ok: true,
		url: created.url,
		content: `Opened a new${op.ephemeral ? ' incognito' : ''} browser tab at ${created.url}. Call list_browsers to get its id.`,
	};
}

/** Close a browser tab in the requesting session (the `closeTab` op). Pure
 *  state update via the shared close helper (keeps closed-tab history and
 *  unified-order repair consistent with a user-initiated close). */
function closeTabForSession(sessionId: string, tabUuid: string): BrowserOpResult {
	const { setSessions } = useSessionStore.getState();
	let closed = false;
	setSessions((prev) =>
		prev.map((s) => {
			if (s.id !== sessionId) return s;
			const result = closeBrowserTab(s, tabUuid);
			if (!result) return s;
			closed = true;
			return result.session;
		})
	);
	return closed
		? { ok: true, content: 'Closed the browser tab.' }
		: { ok: false, content: 'Browser tab could not be closed (it may already be closed).' };
}

export async function applyBrowserOp(
	handle: BrowserTabViewHandle,
	op: BrowserOp
): Promise<BrowserOpResult> {
	switch (op.kind) {
		case 'read': {
			if (op.selector) {
				const res = await handle.executeJavaScript(
					`(function(){var el=document.querySelector(${JSON.stringify(op.selector)});if(!el)return null;return ${
						op.format === 'html' ? 'el.outerHTML' : "el.innerText||el.textContent||''"
					};})()`
				);
				if (res === null || res === undefined) {
					return { ok: false, content: `No element matches selector: ${op.selector}` };
				}
				const meta = handle.getMeta();
				return { ok: true, content: String(res), url: meta.url, title: meta.title };
			}
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
			// handle.capturePage() force-paints a backgrounded (visibility:hidden) tab
			// behind an opaque cover so a hidden tab still captures. A short/empty
			// result means even that failed (the guest never produced a frame) -
			// surface it clearly rather than handing the agent an empty image.
			if (!dataUrl || dataUrl.length < 64) {
				return {
					ok: false,
					content:
						'Screenshot failed: the page did not produce a frame in time. Try again in a moment.',
				};
			}
			return { ok: true, dataUrl, content: 'captured screenshot' };
		}
		case 'waitFor': {
			// Poll from the host side (150ms cadence) so the injected probe stays a
			// trivial synchronous expression. Timeout is validated <=30s in the
			// bridge; re-clamp defensively here.
			const timeoutMs = Math.min(op.timeoutMs ?? 10000, 30000);
			const deadline = Date.now() + timeoutMs;
			const probe = `!!document.querySelector(${JSON.stringify(op.selector)})`;
			// Snapshot the tab this handle is bound to. If a mid-wait navigation (or
			// tab recycle) reassigns the handle to a different tab, surface it right
			// away instead of polling the wrong webview until the full timeout.
			const expectedTabId = handle.getTabId();
			for (;;) {
				if (handle.getTabId() !== expectedTabId) {
					return {
						ok: false,
						content: `Browser tab changed while waiting for selector: ${op.selector}`,
					};
				}
				const found = await handle.executeJavaScript(probe);
				if (found === true) {
					return { ok: true, content: `Element appeared: ${op.selector}` };
				}
				if (Date.now() >= deadline) {
					return {
						ok: false,
						content: `Timed out after ${timeoutMs}ms waiting for selector: ${op.selector}`,
					};
				}
				await delay(150);
			}
		}
		default:
			return { ok: false, content: 'Unsupported browser op' };
	}
}

export async function resolveAndRun(
	browserViewRefs: MutableRefObject<Map<string, BrowserTabViewHandle>>,
	tabUuid: string,
	sessionId: string,
	op: BrowserOp,
	requestApproval: BrowserApprovalRequester,
	resolveBackgroundHandle?: (
		sessionId: string,
		tabUuid: string
	) => Promise<BrowserTabViewHandle | null>,
	mainNeedsConfirm?: boolean
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

	// Execution-boundary re-check for tab-targeted ops: main's registry filter is
	// authoritative for addressing, but a tab can be closed or hidden-from-agents
	// while an op is in flight (or before a registry sync lands). The freshest
	// renderer state wins; hidden is deliberately indistinguishable from closed.
	if (op.kind !== 'newTab') {
		const target = (requesting.browserTabs ?? []).find((t) => t.id === tabUuid);
		if (!target || target.hiddenFromAgent) {
			return {
				ok: false,
				content: 'Browser tab not found in your session (it may have been closed).',
			};
		}
	}

	// Per-call approval for state-changing ops, BEFORE any focus change, mount,
	// or side effect. read ops are never gated. Uses the REQUESTING agent's
	// policy, ORed with main's own computation from its mirrored policy - either
	// side requiring approval forces the dialog.
	if (op.kind !== 'read') {
		const approved = await requestApproval(op, {
			agentId: requesting.toolType,
			sessionId,
			forceConfirm: mainNeedsConfirm === true,
		});
		if (!approved) {
			return { ok: false, content: 'Browser action declined by the user.' };
		}
	}

	// Session-scoped ops: pure store updates, no live webview needed. Work for
	// focused AND non-focused sessions alike (no mount, no focus change).
	if (op.kind === 'newTab') {
		return createTabForSession(sessionId, op);
	}
	if (op.kind === 'closeTab') {
		return closeTabForSession(sessionId, tabUuid);
	}

	// Focused agent: operate on the live (visible or kept-alive hidden) webview
	// WITHOUT ever switching the user's visible tab - forcing the view to the
	// agent's tab is jarring. The keep-alive pin mounts the tab hidden on demand,
	// so we can always reach a handle without changing what the user sees.
	if (isFocused) {
		useCoworkingBrowserKeepAliveStore.getState().pin(tabUuid);
		let handle = browserViewRefs.current.get(tabUuid);
		if (!handle || handle.getTabId() !== tabUuid) {
			// The pin above adds the tab to the mounted set; wait for it to mount
			// (hidden) and register its handle. We never activate it.
			handle = await pollForHandle(browserViewRefs, tabUuid);
		}
		if (handle) {
			return applyBrowserOp(handle, op);
		}
		return {
			ok: false,
			content: 'Browser tab could not be reached (it may have been closed).',
		};
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
	browserViewRefs: MutableRefObject<Map<string, BrowserTabViewHandle>>
): void {
	useEffect(() => {
		const bridge = window.maestro?.coworking;
		if (!bridge) return;
		const off = bridge.onRequestBrowserOp(
			(tabUuid, sessionId, op, responseChannel, needsConfirm) => {
				void (async () => {
					let result: BrowserOpResult;
					try {
						result = await resolveAndRun(
							browserViewRefs,
							tabUuid,
							sessionId,
							op,
							defaultRequestApproval,
							defaultResolveBackgroundHandle,
							needsConfirm
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
			}
		);
		return off;
	}, [browserViewRefs]);
}

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
	formatBrowserPickRect,
	isUngatedBrowserOp,
	DEFAULT_BROWSER_CONFIRM_POLICY,
	BROWSER_APPROVAL_TIMEOUT_MS,
} from '../../../shared/coworkingBrowser';
import {
	DEFAULT_BROWSER_VIEWPORT_PRESET,
	describeBrowserViewport,
	type BrowserViewportPreset,
} from '../../../shared/browserViewport';
import type { DesignPickCapture } from '../../utils/designModePicker';
import {
	useSessionStore,
	selectActiveSession,
	selectSessionById,
	updateBrowserTab,
} from '../../stores/sessionStore';
import { captureException } from '../../utils/sentry';
import { useSettingsStore } from '../../stores/settingsStore';
import { requestCoworkingApproval } from '../../stores/coworkingApprovalStore';
import {
	useCoworkingBackgroundBrowserStore,
	backgroundBrowserKey,
} from '../../stores/coworkingBackgroundBrowserStore';
import { useCoworkingBrowserKeepAliveStore } from '../../stores/coworkingBrowserKeepAliveStore';
import { createBrowserTab, normalizeBrowserTabUpdates } from '../tabs/internal/browserTabHelpers';
import { closeBrowserTab } from '../../utils/tabHelpers';
import { insertAfterActiveInUnifiedTabOrder } from '../../utils/unifiedTabOrderUtils';
import { deliverDesignPick, queueDesignPick } from '../../services/designModePick';
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
 *  dialog). Free-form text an op carries is not in it: see browserOpDetail. */
function describeBrowserOp(op: BrowserOp): string {
	switch (op.kind) {
		case 'navigate':
			return `navigate the browser to ${op.url}`;
		case 'click':
			return `click the element ${op.selector}`;
		case 'type':
			return `type this text into ${op.selector}`;
		case 'eval':
			return 'run this JavaScript in the page';
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
		case 'pick':
			return op.rect !== undefined
				? `add the region ${formatBrowserPickRect(op.rect)} to the message`
				: `add the element ${op.selector} to the message`;
		default:
			return 'perform a browser action';
	}
}

/** The free-form text a browser op carries, which the approval dialog shows
 *  in full: the dialog must show everything that will run (or be typed). */
function browserOpDetail(op: BrowserOp): string | undefined {
	if (op.kind === 'eval') return op.code;
	if (op.kind === 'type') return op.text;
	return undefined;
}

/** Default approval requester: reads the per-agent confirm policy and, when the
 *  op needs approval, shows the confirm dialog and awaits the user's decision. */
export async function defaultRequestApproval(
	op: BrowserOp,
	ctx: { agentId: string; sessionId: string; forceConfirm?: boolean }
): Promise<boolean> {
	if (isUngatedBrowserOp(op.kind)) return true;
	const settings = useSettingsStore.getState();
	const policy =
		settings.coworkingBrowserInteractionConfirm[ctx.agentId] ?? DEFAULT_BROWSER_CONFIRM_POLICY;
	const allowTyping = settings.coworkingBrowserTypingWithoutConfirmation.includes(ctx.agentId);
	if (!ctx.forceConfirm && !browserOpNeedsConfirm(policy, op.kind, allowTyping)) return true;
	const detail = browserOpDetail(op);
	return requestCoworkingApproval(
		{
			agentId: ctx.agentId,
			sessionId: ctx.sessionId,
			title: 'Allow browser action?',
			message: `The "${ctx.agentId}" agent wants to ${describeBrowserOp(op)}${detail === undefined ? '.' : ':'}`,
			detail,
			// A script runs with the page's privileges: a stray Enter must decline.
			focusDeny: op.kind === 'eval',
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

/**
 * Set or read a browser tab's viewport preset (the host-only `viewport` op,
 * `maestro-cli browser-viewport`). A pure store update, like `closeTab`: the
 * preset is a saved field of the tab, so it needs no live webview, works for any
 * agent's tab (focused or not) and never moves the view. A write ends in
 * updateBrowserTab() + normalizeBrowserTabUpdates(), the route the toolbar
 * control's `onUpdateTab` takes, so a mounted BrowserTabView lays itself out
 * from the store exactly as it does after a click. The result is read back from
 * the store, so it reports what the tab shows, not what was asked for.
 */
function viewportForSession(
	sessionId: string,
	tabUuid: string,
	op: Extract<BrowserOp, { kind: 'viewport' }>
): BrowserOpResult {
	const read = (): BrowserViewportPreset | null => {
		const tab = selectSessionById(sessionId)(useSessionStore.getState())?.browserTabs?.find(
			(t) => t.id === tabUuid
		);
		return tab ? (tab.viewportPreset ?? DEFAULT_BROWSER_VIEWPORT_PRESET) : null;
	};
	const previous = read();
	if (!previous) {
		return {
			ok: false,
			content: 'Browser tab not found in your session (it may have been closed).',
		};
	}
	const wanted = op.preset ?? previous;
	if (wanted !== previous) {
		updateBrowserTab(sessionId, tabUuid, (tab) =>
			normalizeBrowserTabUpdates(tab, { viewportPreset: wanted })
		);
	}
	const current = read();
	if (current !== wanted) {
		return { ok: false, content: 'The browser tab changed while its viewport was being set.' };
	}
	return {
		ok: true,
		content: describeBrowserViewport(current),
		viewportPreset: current,
		previousViewportPreset: previous,
	};
}

/**
 * What a `pick` op names, captured: the element its selector matches (as a
 * click describes it) or the region its rect covers (as a drag lists it), or
 * the reason there is nothing to pick.
 */
async function capturePickTarget(
	handle: BrowserTabViewHandle,
	op: Extract<BrowserOp, { kind: 'pick' }>
): Promise<DesignPickCapture | { miss: string }> {
	if (op.rect !== undefined) {
		const region = await handle.inspectRegion(op.rect);
		return (
			region ?? {
				miss: `No part of the region ${formatBrowserPickRect(op.rect)} is in the page's viewport (--rect is CSS px from the viewport's top-left corner).`,
			}
		);
	}
	const capture = await handle.inspectElement(op.selector);
	if (capture === 'invalid-selector') return { miss: `Not a valid CSS selector: ${op.selector}` };
	if (capture === 'not-found' || capture === null) {
		return { miss: `No element matches selector: ${op.selector}` };
	}
	return capture;
}

/**
 * The host-only `pick` op (`maestro-cli browser-pick`): the same capture,
 * crop, and composer delivery as Design Mode, for an element by selector (a
 * click) or a region by rect (a drag). The pick lands as a chip; the result
 * carries the block it adds at send and the chip's id. With `op.queue` it is
 * queued as its own message instead, as the pick card's Queue button does (no
 * chip, no view change, so `background` is not read): the result carries the
 * same block and the queue item's id.
 */
async function pickElement(
	handle: BrowserTabViewHandle,
	op: Extract<BrowserOp, { kind: 'pick' }>,
	sessionId: string
): Promise<BrowserOpResult> {
	const capture = await capturePickTarget(handle, op);
	if ('miss' in capture) return { ok: false, content: capture.miss };
	const what = 'region' in capture ? 'region' : 'element';
	const delivery = {
		...capture,
		sessionId,
		browserTabId: handle.getTabId(),
		note: op.note,
	};
	// A chip (`pickId`) or a queued message (`queueItemId`); either way the block
	// it carries and the AI tab it went to come back the same.
	const landed = op.queue
		? await queueDesignPick(delivery)
		: await deliverDesignPick({ ...delivery, reveal: op.background !== true });
	if (!landed) {
		return {
			ok: false,
			content: op.queue
				? `This agent has no AI tab to queue the ${what} into.`
				: `This agent has no AI tab to add the ${what} to.`,
		};
	}
	const meta = handle.getMeta();
	return {
		ok: true,
		content: landed.text,
		aiTabId: landed.aiTabId,
		...('queueItemId' in landed ? { queueItemId: landed.queueItemId } : { pickId: landed.pickId }),
		...(capture.screenshot ? { dataUrl: capture.screenshot } : {}),
		url: meta.url,
		title: meta.title,
	};
}

export async function applyBrowserOp(
	handle: BrowserTabViewHandle,
	op: BrowserOp,
	sessionId?: string
): Promise<BrowserOpResult> {
	switch (op.kind) {
		case 'pick':
			if (!sessionId) return { ok: false, content: 'Design Mode pick needs the owning agent.' };
			return pickElement(handle, op, sessionId);
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
			// React tracks assignments through an instance setter. Use the platform
			// setter so the bubbling input event delivers the change to React.
			const res = await handle.executeJavaScript(
				`(() => {
					const el = document.querySelector(${JSON.stringify(op.selector)});
					if (!el) return 'notfound';
					if (el.focus) el.focus();
					const text = ${JSON.stringify(op.text)};
					if ('value' in el) {
						const prototype = el instanceof HTMLInputElement ? HTMLInputElement.prototype
							: el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : null;
						const setter = prototype && Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
						if (setter) setter.call(el, text);
						else el.value = text;
						el.dispatchEvent(new Event('input', { bubbles: true }));
						el.dispatchEvent(new Event('change', { bubbles: true }));
					} else {
						el.textContent = text;
					}
					return 'ok';
				})()`
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
	if (!isUngatedBrowserOp(op.kind)) {
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
	if (op.kind === 'viewport') {
		return viewportForSession(sessionId, tabUuid, op);
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
			return applyBrowserOp(handle, op, sessionId);
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
				return await applyBrowserOp(bgHandle, op, sessionId);
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

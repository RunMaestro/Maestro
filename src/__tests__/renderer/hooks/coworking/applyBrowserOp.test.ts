import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	applyBrowserOp,
	resolveAndRun,
	type BrowserApprovalRequester,
} from '../../../../renderer/hooks/coworking/useCoworkingBrowserResponder';
import type { BrowserTabViewHandle } from '../../../../renderer/components/MainPanel/BrowserTabView';
import { selectActiveSession, useSessionStore } from '../../../../renderer/stores/sessionStore';
import type { SessionStore } from '../../../../renderer/stores/sessionStore';
import type { BrowserTab, Session } from '../../../../renderer/types';
import {
	useCoworkingBrowserKeepAliveStore,
	activePinnedTabIds,
} from '../../../../renderer/stores/coworkingBrowserKeepAliveStore';

vi.mock('../../../../renderer/stores/sessionStore', () => ({
	useSessionStore: { getState: vi.fn(() => ({})) },
	selectActiveSession: vi.fn(),
	selectSessionById: vi.fn(() => () => ({
		id: 'sess-A',
		toolType: 'claude-code',
		activeBrowserTabId: null,
		// The execution-boundary re-check consults browserTabs; keep the suite's
		// cross-session target visible by default.
		browserTabs: [{ id: 'u-1' }],
	})),
}));

/** resolveAndRun reads id, activeBrowserTabId, toolType and (for the
 *  execution-boundary tab re-check) browserTabs. Every tab uuid this suite
 *  drives is live and visible by default; tests for the boundary check pass
 *  their own list. */
function fakeActive(
	id: string,
	activeBrowserTabId: string | null,
	browserTabs: Array<Partial<BrowserTab>> = [
		{ id: 'u-1' },
		{ id: 'u-2' },
		{ id: 'u-3' },
		{ id: 'u-9' },
	]
): Session {
	return { id, activeBrowserTabId, toolType: 'claude-code', browserTabs } as unknown as Session;
}

function makeHandle(overrides: Partial<BrowserTabViewHandle> = {}): BrowserTabViewHandle {
	return {
		getContent: vi.fn(async () => ''),
		getTabId: vi.fn(() => 'tab-1'),
		openFind: vi.fn(),
		goBack: vi.fn(),
		goForward: vi.fn(),
		focusWebview: vi.fn(),
		extract: vi.fn(async () => ''),
		getMeta: vi.fn(() => ({ url: 'https://e', title: 'E' })),
		navigate: vi.fn(() => 'https://e'),
		reload: vi.fn(),
		stop: vi.fn(),
		executeJavaScript: vi.fn(async () => undefined),
		capturePage: vi.fn(async () => 'data:image/png;base64,AAAA'),
		...overrides,
	};
}

describe('applyBrowserOp', () => {
	it('read returns the extracted content plus url/title meta', async () => {
		const extract = vi.fn(async () => 'PAGE');
		const handle = makeHandle({ extract, getMeta: () => ({ url: 'https://x', title: 'X' }) });
		const res = await applyBrowserOp(handle, { kind: 'read', format: 'text' });
		expect(extract).toHaveBeenCalledWith('text');
		expect(res).toEqual({ ok: true, content: 'PAGE', url: 'https://x', title: 'X' });
	});

	it('navigate resolves the url through the handle', async () => {
		const navigate = vi.fn(() => 'https://resolved');
		const res = await applyBrowserOp(makeHandle({ navigate }), {
			kind: 'navigate',
			url: 'resolved',
		});
		expect(navigate).toHaveBeenCalledWith('resolved');
		expect(res.ok).toBe(true);
		expect(res.url).toBe('https://resolved');
	});

	it('back/forward/reload/stop invoke the matching handle methods', async () => {
		const goBack = vi.fn();
		const goForward = vi.fn();
		const reload = vi.fn();
		const stop = vi.fn();
		const handle = makeHandle({ goBack, goForward, reload, stop });
		expect((await applyBrowserOp(handle, { kind: 'back' })).ok).toBe(true);
		expect((await applyBrowserOp(handle, { kind: 'forward' })).ok).toBe(true);
		expect((await applyBrowserOp(handle, { kind: 'reload' })).ok).toBe(true);
		expect((await applyBrowserOp(handle, { kind: 'stop' })).ok).toBe(true);
		expect(goBack).toHaveBeenCalled();
		expect(goForward).toHaveBeenCalled();
		expect(reload).toHaveBeenCalled();
		expect(stop).toHaveBeenCalled();
	});

	it('click returns ok and JSON-escapes the selector into the page script', async () => {
		const executeJavaScript = vi.fn(async () => 'ok');
		const res = await applyBrowserOp(makeHandle({ executeJavaScript }), {
			kind: 'click',
			selector: '#go',
		});
		expect(res.ok).toBe(true);
		expect(String(executeJavaScript.mock.calls[0][0])).toContain('"#go"');
	});

	it('click returns ok:false when no element matches', async () => {
		const executeJavaScript = vi.fn(async () => 'notfound');
		const res = await applyBrowserOp(makeHandle({ executeJavaScript }), {
			kind: 'click',
			selector: '#missing',
		});
		expect(res.ok).toBe(false);
	});

	it('type injects the selector and text (JSON-escaped) and reports success', async () => {
		const executeJavaScript = vi.fn(async () => 'ok');
		const res = await applyBrowserOp(makeHandle({ executeJavaScript }), {
			kind: 'type',
			selector: '#in',
			text: 'hi "there"',
		});
		expect(res.ok).toBe(true);
		const js = String(executeJavaScript.mock.calls[0][0]);
		expect(js).toContain('"#in"');
		expect(js).toContain(JSON.stringify('hi "there"'));
	});

	it('eval stringifies a non-string result', async () => {
		const executeJavaScript = vi.fn(async () => ({ a: 1 }));
		const res = await applyBrowserOp(makeHandle({ executeJavaScript }), {
			kind: 'eval',
			code: '({a:1})',
		});
		expect(res.ok).toBe(true);
		expect(res.content).toBe(JSON.stringify({ a: 1 }));
	});

	it('screenshot returns the captured data url', async () => {
		const pngUrl = 'data:image/png;base64,' + 'A'.repeat(120);
		const capturePage = vi.fn(async () => pngUrl);
		const res = await applyBrowserOp(makeHandle({ capturePage }), { kind: 'screenshot' });
		expect(res.ok).toBe(true);
		expect(res.dataUrl).toBe(pngUrl);
	});

	it('screenshot returns ok:false when the capture produced no frame', async () => {
		// capturePage() now force-paints even a hidden/backgrounded tab, so a
		// blank/too-short result means the guest genuinely produced no frame - not
		// that the tab was hidden. The host still refuses to hand back an empty image.
		const capturePage = vi.fn(async () => '');
		const res = await applyBrowserOp(makeHandle({ capturePage }), { kind: 'screenshot' });
		expect(res.ok).toBe(false);
		expect(String(res.content)).toMatch(/did not produce a frame/i);
	});

	it('waitFor returns ok when the selector appears on the first probe', async () => {
		const executeJavaScript = vi.fn(async () => true);
		const res = await applyBrowserOp(makeHandle({ executeJavaScript }), {
			kind: 'waitFor',
			selector: '#late',
		});
		expect(res.ok).toBe(true);
		expect(String(res.content)).toMatch(/appeared/i);
		expect(String(executeJavaScript.mock.calls[0][0])).toContain('"#late"');
	});

	it('waitFor keeps polling until the selector appears', async () => {
		const executeJavaScript = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
		const res = await applyBrowserOp(makeHandle({ executeJavaScript }), {
			kind: 'waitFor',
			selector: '#late',
			timeoutMs: 5000,
		});
		expect(res.ok).toBe(true);
		expect(executeJavaScript.mock.calls.length).toBeGreaterThanOrEqual(2);
	});

	it('waitFor returns ok:false when the timeout elapses without a match', async () => {
		const executeJavaScript = vi.fn(async () => false);
		const res = await applyBrowserOp(makeHandle({ executeJavaScript }), {
			kind: 'waitFor',
			selector: '#never',
			timeoutMs: 1,
		});
		expect(res.ok).toBe(false);
		expect(String(res.content)).toMatch(/timed out/i);
	});

	it('selector-scoped read returns the matched element content with page meta', async () => {
		const executeJavaScript = vi.fn(async () => 'ELEMENT TEXT');
		const extract = vi.fn(async () => 'WHOLE PAGE');
		const res = await applyBrowserOp(
			makeHandle({
				executeJavaScript,
				extract,
				getMeta: () => ({ url: 'https://x', title: 'X' }),
			}),
			{ kind: 'read', format: 'text', selector: '#main' }
		);
		expect(res).toEqual({ ok: true, content: 'ELEMENT TEXT', url: 'https://x', title: 'X' });
		// The selector path must query the element, not fall back to full-page extract.
		expect(extract).not.toHaveBeenCalled();
		expect(String(executeJavaScript.mock.calls[0][0])).toContain('"#main"');
	});

	it('selector-scoped read maps html format to outerHTML extraction', async () => {
		const executeJavaScript = vi.fn(async () => '<div id="main"></div>');
		const res = await applyBrowserOp(makeHandle({ executeJavaScript }), {
			kind: 'read',
			format: 'html',
			selector: '#main',
		});
		expect(res.ok).toBe(true);
		expect(res.content).toBe('<div id="main"></div>');
		expect(String(executeJavaScript.mock.calls[0][0])).toContain('outerHTML');
	});

	it('selector-scoped read returns ok:false when nothing matches', async () => {
		const executeJavaScript = vi.fn(async () => null);
		const res = await applyBrowserOp(makeHandle({ executeJavaScript }), {
			kind: 'read',
			format: 'text',
			selector: '#missing',
		});
		expect(res.ok).toBe(false);
		expect(String(res.content)).toMatch(/no element matches/i);
	});
});

describe('resolveAndRun', () => {
	const allow: BrowserApprovalRequester = async () => true;

	beforeEach(() => {
		vi.clearAllMocks();
		// Focused ops now pin into the module-singleton keep-alive store; start
		// clean and cancel the real 120s prune timer between tests.
		useCoworkingBrowserKeepAliveStore.getState().clear();
	});

	afterEach(() => {
		useCoworkingBrowserKeepAliveStore.getState().clear();
	});

	it('returns ok:false when a non-focused agent has no background host', async () => {
		vi.mocked(selectActiveSession).mockReturnValue(fakeActive('other', null));
		const res = await resolveAndRun(
			{ current: new Map() },
			'u-1',
			'sess-A',
			{ kind: 'read', format: 'text' },
			allow
		);
		expect(res.ok).toBe(false);
		expect(String(res.content)).toMatch(/not live/i);
	});

	it('uses an already-mounted handle for a focused op', async () => {
		vi.mocked(selectActiveSession).mockReturnValue(fakeActive('sess-A', 'u-1'));
		const handle = makeHandle({
			getTabId: () => 'u-1',
			extract: vi.fn(async () => 'TXT'),
			getMeta: () => ({ url: 'https://x', title: 'X' }),
		});
		const res = await resolveAndRun(
			{ current: new Map([['u-1', handle]]) },
			'u-1',
			'sess-A',
			{ kind: 'read', format: 'text' },
			allow
		);
		expect(res).toEqual({ ok: true, content: 'TXT', url: 'https://x', title: 'X' });
	});

	it('runs on the pin-driven hidden mount without switching the user surface', async () => {
		// The user is on a terminal tab (activeBrowserTabId null). The op must drive
		// the browser tab through the keep-alive pin's hidden mount and NEVER switch
		// the visible surface: the activate/prevSurface-restore path is gone, so
		// setSessions must not be touched at all.
		vi.mocked(selectActiveSession).mockReturnValue(fakeActive('sess-A', null, [{ id: 'u-2' }]));
		const setSessions = vi.fn();
		vi.mocked(useSessionStore.getState).mockReturnValue({
			setSessions,
		} as unknown as SessionStore);
		const reload = vi.fn();
		const handle = makeHandle({ getTabId: () => 'u-2', reload });
		const res = await resolveAndRun(
			{ current: new Map([['u-2', handle]]) },
			'u-2',
			'sess-A',
			{ kind: 'reload' },
			allow
		);
		expect(res.ok).toBe(true);
		expect(reload).toHaveBeenCalled();
		// The tab was pinned for keep-alive so it stays mounted (hidden)...
		expect(activePinnedTabIds(useCoworkingBrowserKeepAliveStore.getState().pins)).toContain('u-2');
		// ...and the user's visible surface was never switched.
		expect(setSessions).not.toHaveBeenCalled();
	});

	it('returns ok:false when the pinned tab never mounts a handle', async () => {
		vi.mocked(selectActiveSession).mockReturnValue(fakeActive('sess-A', null, [{ id: 'u-3' }]));
		const setSessions = vi.fn();
		vi.mocked(useSessionStore.getState).mockReturnValue({
			setSessions,
		} as unknown as SessionStore);
		const res = await resolveAndRun(
			{ current: new Map() },
			'u-3',
			'sess-A',
			{ kind: 'read', format: 'text' },
			allow
		);
		expect(res.ok).toBe(false);
		expect(String(res.content)).toMatch(/could not be reached/i);
		// No activate/restore surface-switch on the unreachable path.
		expect(setSessions).not.toHaveBeenCalled();
	});

	it('does not request approval for read ops', async () => {
		vi.mocked(selectActiveSession).mockReturnValue(fakeActive('sess-A', 'u-1'));
		const handle = makeHandle({ getTabId: () => 'u-1', extract: vi.fn(async () => 'TXT') });
		const requestApproval = vi.fn(async () => true);
		await resolveAndRun(
			{ current: new Map([['u-1', handle]]) },
			'u-1',
			'sess-A',
			{ kind: 'read', format: 'text' },
			requestApproval
		);
		expect(requestApproval).not.toHaveBeenCalled();
	});

	it('declines an interaction op when approval is denied and never touches the handle', async () => {
		vi.mocked(selectActiveSession).mockReturnValue(fakeActive('sess-A', 'u-9'));
		const reload = vi.fn();
		const handle = makeHandle({ getTabId: () => 'u-9', reload });
		const deny: BrowserApprovalRequester = async () => false;
		const res = await resolveAndRun(
			{ current: new Map([['u-9', handle]]) },
			'u-9',
			'sess-A',
			{ kind: 'reload' },
			deny
		);
		expect(res.ok).toBe(false);
		expect(String(res.content)).toMatch(/declined/i);
		expect(reload).not.toHaveBeenCalled();
	});

	it('reads a non-focused tab via the background host when provided', async () => {
		vi.mocked(selectActiveSession).mockReturnValue(fakeActive('other', null));
		const handle = makeHandle({ getTabId: () => 'u-1', extract: vi.fn(async () => 'BG') });
		const resolveBackground = vi.fn(async () => handle);
		const res = await resolveAndRun(
			{ current: new Map() },
			'u-1',
			'sess-A',
			{ kind: 'read', format: 'text' },
			allow,
			resolveBackground
		);
		expect(res).toEqual({ ok: true, content: 'BG', url: 'https://e', title: 'E' });
		expect(resolveBackground).toHaveBeenCalledWith('sess-A', 'u-1');
	});

	it('drives a non-focused tab via the background host (interaction)', async () => {
		vi.mocked(selectActiveSession).mockReturnValue(fakeActive('other', null));
		const reload = vi.fn();
		const handle = makeHandle({ getTabId: () => 'u-1', reload });
		const resolveBackground = vi.fn(async () => handle);
		const res = await resolveAndRun(
			{ current: new Map() },
			'u-1',
			'sess-A',
			{ kind: 'reload' },
			allow,
			resolveBackground
		);
		expect(res.ok).toBe(true);
		expect(reload).toHaveBeenCalled();
	});

	it('returns ok:false when the background host cannot mount the tab', async () => {
		vi.mocked(selectActiveSession).mockReturnValue(fakeActive('other', null));
		const resolveBackground = vi.fn(async () => null);
		const res = await resolveAndRun(
			{ current: new Map() },
			'u-1',
			'sess-A',
			{ kind: 'read', format: 'text' },
			allow,
			resolveBackground
		);
		expect(res.ok).toBe(false);
		expect(String(res.content)).toMatch(/not live/i);
		expect(resolveBackground).toHaveBeenCalled();
	});

	it('rejects an op targeting a hidden tab before requesting approval (hidden == closed)', async () => {
		vi.mocked(selectActiveSession).mockReturnValue(
			fakeActive('sess-A', 'u-1', [{ id: 'u-1', hiddenFromAgent: true }])
		);
		const reload = vi.fn();
		const handle = makeHandle({ getTabId: () => 'u-1', reload });
		const requestApproval = vi.fn(async () => true);
		const res = await resolveAndRun(
			{ current: new Map([['u-1', handle]]) },
			'u-1',
			'sess-A',
			{ kind: 'reload' },
			requestApproval
		);
		expect(res.ok).toBe(false);
		expect(String(res.content)).toMatch(/not found in your session/i);
		expect(requestApproval).not.toHaveBeenCalled();
		expect(reload).not.toHaveBeenCalled();
	});

	it('rejects an op whose tab is gone from the requesting session', async () => {
		vi.mocked(selectActiveSession).mockReturnValue(fakeActive('sess-A', null, [{ id: 'u-1' }]));
		const res = await resolveAndRun(
			{ current: new Map() },
			'u-gone',
			'sess-A',
			{ kind: 'read', format: 'text' },
			allow
		);
		expect(res.ok).toBe(false);
		expect(String(res.content)).toMatch(/not found in your session/i);
	});

	it("propagates main's needsConfirm to the approval gate as forceConfirm", async () => {
		vi.mocked(selectActiveSession).mockReturnValue(fakeActive('sess-A', 'u-1'));
		const reload = vi.fn();
		const handle = makeHandle({ getTabId: () => 'u-1', reload });
		const requestApproval = vi.fn(async () => true);
		const res = await resolveAndRun(
			{ current: new Map([['u-1', handle]]) },
			'u-1',
			'sess-A',
			{ kind: 'reload' },
			requestApproval,
			undefined,
			true
		);
		expect(res.ok).toBe(true);
		expect(requestApproval).toHaveBeenCalledWith(
			{ kind: 'reload' },
			{ agentId: 'claude-code', sessionId: 'sess-A', forceConfirm: true }
		);
	});

	it('does not force approval when main did not require confirmation', async () => {
		vi.mocked(selectActiveSession).mockReturnValue(fakeActive('sess-A', 'u-1'));
		const handle = makeHandle({ getTabId: () => 'u-1' });
		const requestApproval = vi.fn(async () => true);
		await resolveAndRun(
			{ current: new Map([['u-1', handle]]) },
			'u-1',
			'sess-A',
			{ kind: 'reload' },
			requestApproval
		);
		expect(requestApproval).toHaveBeenCalledWith(
			{ kind: 'reload' },
			{ agentId: 'claude-code', sessionId: 'sess-A', forceConfirm: false }
		);
	});
});

describe('resolveAndRun session-scoped ops (newTab / closeTab)', () => {
	const allow: BrowserApprovalRequester = async () => true;

	beforeEach(() => {
		vi.clearAllMocks();
		// createTabForSession pins the new tab; keep the singleton clean + cancel
		// its 120s prune timer between tests.
		useCoworkingBrowserKeepAliveStore.getState().clear();
	});

	afterEach(() => {
		useCoworkingBrowserKeepAliveStore.getState().clear();
	});

	/** Minimal structural stand-in for the Session slices these ops touch. */
	interface StoreSession {
		id: string;
		browserTabs: Array<Partial<BrowserTab>>;
		unifiedTabOrder: Array<{ type: string; id: string }>;
		activeBrowserTabId?: string | null;
		inputMode?: string;
		aiTabs?: unknown[];
		filePreviewTabs?: unknown[];
		terminalTabs?: unknown[];
	}

	/** Wires useSessionStore.getState().setSessions to a mutable array so the
	 *  tests can observe what the op actually did to the requesting session. */
	function wireStore(sessions: StoreSession[]) {
		const setSessions = vi.fn((updater: (prev: Session[]) => Session[]) => {
			const prev = sessions as unknown as Session[];
			const next = updater(prev) as unknown as StoreSession[];
			sessions.length = 0;
			sessions.push(...next);
		});
		vi.mocked(useSessionStore.getState).mockReturnValue({
			setSessions,
		} as unknown as SessionStore);
		return setSessions;
	}

	it('newTab creates a tab in the requesting session without any webview or surface hijack', async () => {
		vi.mocked(selectActiveSession).mockReturnValue(fakeActive('other', null));
		const sessions: StoreSession[] = [
			{ id: 'other', browserTabs: [], unifiedTabOrder: [] },
			{ id: 'sess-A', browserTabs: [], unifiedTabOrder: [], activeBrowserTabId: null },
		];
		const setSessions = wireStore(sessions);
		const requestApproval = vi.fn(async () => true);
		const resolveBackground = vi.fn(async () => null);
		const res = await resolveAndRun(
			{ current: new Map() },
			'',
			'sess-A',
			{ kind: 'newTab', url: 'example.com', ephemeral: true },
			requestApproval,
			resolveBackground
		);
		expect(res.ok).toBe(true);
		expect(String(res.content)).toContain('list_browsers');
		// Scheme-less input went through the shared navigation resolver.
		expect(res.url).toBe('https://example.com/');
		// The tab landed in the REQUESTING session, flagged + partitioned incognito.
		const target = sessions.find((s) => s.id === 'sess-A');
		expect(target?.browserTabs).toHaveLength(1);
		const created = target?.browserTabs[0];
		expect(created?.url).toBe('https://example.com/');
		expect(created?.ephemeral).toBe(true);
		expect(created?.partition).toMatch(/^maestro-ephemeral-/);
		expect(target?.unifiedTabOrder).toContainEqual({ type: 'browser', id: created?.id });
		// No-hijack: the session was NOT already on a browser tab, so its active
		// surface is left untouched (activeBrowserTabId stays null).
		expect(target?.activeBrowserTabId).toBeNull();
		// The focused ('other') session is untouched.
		expect(sessions.find((s) => s.id === 'other')?.browserTabs).toHaveLength(0);
		// No webview handle was needed: the background host was never consulted.
		expect(resolveBackground).not.toHaveBeenCalled();
		// newTab is an interaction op: the approval gate still ran.
		expect(requestApproval).toHaveBeenCalled();
		expect(setSessions).toHaveBeenCalledTimes(1);
	});

	it('newTab brings the tab into view only when the session is already on a browser tab', async () => {
		vi.mocked(selectActiveSession).mockReturnValue(fakeActive('sess-A', 'u-existing'));
		const sessions: StoreSession[] = [
			{
				id: 'sess-A',
				browserTabs: [{ id: 'u-existing' }],
				unifiedTabOrder: [{ type: 'browser', id: 'u-existing' }],
				activeBrowserTabId: 'u-existing',
				inputMode: 'ai',
			},
		];
		wireStore(sessions);
		const res = await resolveAndRun(
			{ current: new Map() },
			'',
			'sess-A',
			{ kind: 'newTab', url: 'example.com' },
			allow
		);
		expect(res.ok).toBe(true);
		const created = sessions[0].browserTabs.at(-1);
		expect(created?.id).not.toBe('u-existing');
		// Already viewing a browser tab -> opening another is a natural continuation,
		// so the new tab becomes the active surface.
		expect(sessions[0].activeBrowserTabId).toBe(created?.id);
		expect(sessions[0].inputMode).toBe('ai');
	});

	it('newTab pins the freshly created tab so it stays mounted from creation', async () => {
		// Test 2 (assigned): createTabForSession must pin the new tab's uuid the
		// instant it is created, so a user clicking away before the agent's next op
		// cannot unmount it. Teeth: dropping pin(created.id) empties the pin set.
		vi.mocked(selectActiveSession).mockReturnValue(fakeActive('sess-A', null));
		const sessions: StoreSession[] = [
			{ id: 'sess-A', browserTabs: [], unifiedTabOrder: [], activeBrowserTabId: null },
		];
		wireStore(sessions);
		const res = await resolveAndRun(
			{ current: new Map() },
			'',
			'sess-A',
			{ kind: 'newTab', url: 'example.com' },
			allow
		);
		expect(res.ok).toBe(true);
		const created = sessions.find((s) => s.id === 'sess-A')?.browserTabs.at(-1);
		expect(created?.id).toBeTruthy();
		expect(activePinnedTabIds(useCoworkingBrowserKeepAliveStore.getState().pins)).toContain(
			created?.id
		);
	});

	it('newTab without ephemeral mints a persistent per-session partition', async () => {
		vi.mocked(selectActiveSession).mockReturnValue(fakeActive('other', null));
		const sessions: StoreSession[] = [{ id: 'sess-A', browserTabs: [], unifiedTabOrder: [] }];
		wireStore(sessions);
		const res = await resolveAndRun(
			{ current: new Map() },
			'',
			'sess-A',
			{ kind: 'newTab' },
			allow
		);
		expect(res.ok).toBe(true);
		const created = sessions[0].browserTabs[0];
		expect(created?.url).toBe('about:blank');
		expect(created?.partition).toMatch(/^persist:maestro-browser-session-/);
		expect(created?.ephemeral).toBeUndefined();
	});

	it('newTab rejects an unloadable target and creates no tab', async () => {
		vi.mocked(selectActiveSession).mockReturnValue(fakeActive('other', null));
		const sessions: StoreSession[] = [{ id: 'sess-A', browserTabs: [], unifiedTabOrder: [] }];
		const setSessions = wireStore(sessions);
		const res = await resolveAndRun(
			{ current: new Map() },
			'',
			'sess-A',
			{ kind: 'newTab', url: 'javascript:alert(1)' },
			allow
		);
		expect(res.ok).toBe(false);
		expect(String(res.content)).toMatch(/protocol not allowed/i);
		expect(setSessions).not.toHaveBeenCalled();
	});

	it('closeTab removes the target tab from the requesting session', async () => {
		vi.mocked(selectActiveSession).mockReturnValue(fakeActive('sess-A', null, [{ id: 'u-1' }]));
		const sessions: StoreSession[] = [
			{
				id: 'sess-A',
				browserTabs: [{ id: 'u-1', url: 'https://a', title: 'A' }],
				unifiedTabOrder: [{ type: 'browser', id: 'u-1' }],
				aiTabs: [],
				filePreviewTabs: [],
				terminalTabs: [],
			},
		];
		wireStore(sessions);
		const res = await resolveAndRun(
			{ current: new Map() },
			'u-1',
			'sess-A',
			{ kind: 'closeTab' },
			allow
		);
		expect(res.ok).toBe(true);
		expect(sessions[0].browserTabs).toHaveLength(0);
		expect(sessions[0].unifiedTabOrder).toHaveLength(0);
	});

	it('closeTab on a tab missing from the session fails closed at the boundary', async () => {
		vi.mocked(selectActiveSession).mockReturnValue(fakeActive('sess-A', null, [{ id: 'u-1' }]));
		const sessions: StoreSession[] = [
			{ id: 'sess-A', browserTabs: [{ id: 'u-1' }], unifiedTabOrder: [] },
		];
		const setSessions = wireStore(sessions);
		const res = await resolveAndRun(
			{ current: new Map() },
			'u-9',
			'sess-A',
			{ kind: 'closeTab' },
			allow
		);
		expect(res.ok).toBe(false);
		expect(String(res.content)).toMatch(/not found in your session/i);
		expect(sessions[0].browserTabs).toHaveLength(1);
		expect(setSessions).not.toHaveBeenCalled();
	});
});

describe('resolveAndRun keep-alive pin', () => {
	const allow: BrowserApprovalRequester = async () => true;

	beforeEach(() => {
		vi.clearAllMocks();
		// Every focused op pins into this module-level singleton; start clean so a
		// prior test's pin can't produce a false positive here.
		useCoworkingBrowserKeepAliveStore.getState().clear();
	});

	afterEach(() => {
		// Cancel the real 120s prune timer the pin scheduled.
		useCoworkingBrowserKeepAliveStore.getState().clear();
	});

	it('pins the driven tab for keep-alive on a focused-session op', async () => {
		vi.mocked(selectActiveSession).mockReturnValue(fakeActive('sess-A', 'u-1'));
		const handle = makeHandle({ getTabId: () => 'u-1', extract: vi.fn(async () => 'TXT') });
		// A read needs no approval and hits the already-mounted fast path, so it
		// returns without any focus change - isolating the pin() side effect.
		const res = await resolveAndRun(
			{ current: new Map([['u-1', handle]]) },
			'u-1',
			'sess-A',
			{ kind: 'read', format: 'text' },
			allow
		);
		expect(res.ok).toBe(true);
		expect(activePinnedTabIds(useCoworkingBrowserKeepAliveStore.getState().pins)).toContain('u-1');
	});

	it('does not pin the focused keep-alive store for a non-focused (background) op', async () => {
		// The requesting agent is not the focused session; it resolves via the
		// background host and must NOT touch the focused-agent keep-alive store
		// (that store scopes the active agent only).
		vi.mocked(selectActiveSession).mockReturnValue(fakeActive('other', null));
		const handle = makeHandle({ getTabId: () => 'u-1', extract: vi.fn(async () => 'BG') });
		const res = await resolveAndRun(
			{ current: new Map() },
			'u-1',
			'sess-A',
			{ kind: 'read', format: 'text' },
			allow,
			async () => handle
		);
		expect(res.ok).toBe(true);
		expect(activePinnedTabIds(useCoworkingBrowserKeepAliveStore.getState().pins)).not.toContain(
			'u-1'
		);
	});
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	applyBrowserOp,
	resolveAndRun,
	type BrowserApprovalRequester,
} from '../../../../renderer/hooks/coworking/useCoworkingBrowserResponder';
import type { BrowserTabViewHandle } from '../../../../renderer/components/MainPanel/BrowserTabView';
import { selectActiveSession, useSessionStore } from '../../../../renderer/stores/sessionStore';
import type { SessionStore } from '../../../../renderer/stores/sessionStore';
import type { BrowserTab, Session } from '../../../../renderer/types';

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

	it('screenshot returns ok:false when the capture is blank (hidden webview)', async () => {
		const capturePage = vi.fn(async () => '');
		const res = await applyBrowserOp(makeHandle({ capturePage }), { kind: 'screenshot' });
		expect(res.ok).toBe(false);
		expect(String(res.content)).toMatch(/not visible|unavailable/i);
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
	beforeEach(() => vi.clearAllMocks());

	const allow: BrowserApprovalRequester = async () => true;

	it('returns ok:false when the requesting session is not the focused agent', async () => {
		vi.mocked(selectActiveSession).mockReturnValue(fakeActive('other', null));
		const selectBrowserTab = vi.fn();
		const res = await resolveAndRun(
			{ current: new Map() },
			selectBrowserTab,
			'u-1',
			'sess-A',
			{ kind: 'read', format: 'text' },
			allow
		);
		expect(res.ok).toBe(false);
		expect(String(res.content)).toMatch(/not live/i);
		expect(selectBrowserTab).not.toHaveBeenCalled();
	});

	it('uses an already-mounted handle without stealing focus (fast path)', async () => {
		vi.mocked(selectActiveSession).mockReturnValue(fakeActive('sess-A', 'u-1'));
		const handle = makeHandle({
			getTabId: () => 'u-1',
			extract: vi.fn(async () => 'TXT'),
			getMeta: () => ({ url: 'https://x', title: 'X' }),
		});
		const selectBrowserTab = vi.fn();
		const res = await resolveAndRun(
			{ current: new Map([['u-1', handle]]) },
			selectBrowserTab,
			'u-1',
			'sess-A',
			{ kind: 'read', format: 'text' },
			allow
		);
		expect(res).toEqual({ ok: true, content: 'TXT', url: 'https://x', title: 'X' });
		expect(selectBrowserTab).not.toHaveBeenCalled();
	});

	it('activates an unmounted tab, runs the op, then restores the previous tab', async () => {
		vi.mocked(selectActiveSession).mockReturnValue(fakeActive('sess-A', 'prev-tab'));
		const reload = vi.fn();
		const handle = makeHandle({ getTabId: () => 'u-2', reload });
		const map = new Map<string, BrowserTabViewHandle>();
		// Activating the tab simulates it mounting by populating the ref map.
		const selectBrowserTab = vi.fn((_sessionId: string, tabUuid: string) => {
			if (tabUuid === 'u-2') map.set('u-2', handle);
		});
		const res = await resolveAndRun(
			{ current: map },
			selectBrowserTab,
			'u-2',
			'sess-A',
			{ kind: 'reload' },
			allow
		);
		expect(res.ok).toBe(true);
		expect(reload).toHaveBeenCalled();
		expect(selectBrowserTab).toHaveBeenNthCalledWith(1, 'sess-A', 'u-2');
		expect(selectBrowserTab).toHaveBeenNthCalledWith(2, 'sess-A', 'prev-tab');
	});

	it('returns ok:false when the tab cannot be mounted', async () => {
		vi.mocked(selectActiveSession).mockReturnValue(fakeActive('sess-A', null));
		const selectBrowserTab = vi.fn();
		const res = await resolveAndRun(
			{ current: new Map() },
			selectBrowserTab,
			'u-3',
			'sess-A',
			{ kind: 'read', format: 'text' },
			allow
		);
		expect(res.ok).toBe(false);
		expect(String(res.content)).toMatch(/could not be mounted/i);
	});

	it('declines an interaction op when approval is denied and never touches the handle', async () => {
		vi.mocked(selectActiveSession).mockReturnValue(fakeActive('sess-A', 'u-9'));
		const reload = vi.fn();
		const handle = makeHandle({ getTabId: () => 'u-9', reload });
		const selectBrowserTab = vi.fn();
		const deny: BrowserApprovalRequester = async () => false;
		const res = await resolveAndRun(
			{ current: new Map([['u-9', handle]]) },
			selectBrowserTab,
			'u-9',
			'sess-A',
			{ kind: 'reload' },
			deny
		);
		expect(res.ok).toBe(false);
		expect(String(res.content)).toMatch(/declined/i);
		expect(reload).not.toHaveBeenCalled();
	});

	it('does not request approval for read ops', async () => {
		vi.mocked(selectActiveSession).mockReturnValue(fakeActive('sess-A', 'u-1'));
		const handle = makeHandle({ getTabId: () => 'u-1', extract: vi.fn(async () => 'TXT') });
		const requestApproval = vi.fn(async () => true);
		await resolveAndRun(
			{ current: new Map([['u-1', handle]]) },
			vi.fn(),
			'u-1',
			'sess-A',
			{ kind: 'read', format: 'text' },
			requestApproval
		);
		expect(requestApproval).not.toHaveBeenCalled();
	});

	it('reads a non-focused tab via the background host when provided', async () => {
		vi.mocked(selectActiveSession).mockReturnValue(fakeActive('other', null));
		const handle = makeHandle({ getTabId: () => 'u-1', extract: vi.fn(async () => 'BG') });
		const resolveBackground = vi.fn(async () => handle);
		const selectBrowserTab = vi.fn();
		const res = await resolveAndRun(
			{ current: new Map() },
			selectBrowserTab,
			'u-1',
			'sess-A',
			{ kind: 'read', format: 'text' },
			allow,
			resolveBackground
		);
		expect(res).toEqual({ ok: true, content: 'BG', url: 'https://e', title: 'E' });
		expect(resolveBackground).toHaveBeenCalledWith('sess-A', 'u-1');
		expect(selectBrowserTab).not.toHaveBeenCalled();
	});

	it('drives a non-focused tab via the background host (interaction)', async () => {
		vi.mocked(selectActiveSession).mockReturnValue(fakeActive('other', null));
		const reload = vi.fn();
		const handle = makeHandle({ getTabId: () => 'u-1', reload });
		const resolveBackground = vi.fn(async () => handle);
		const res = await resolveAndRun(
			{ current: new Map() },
			vi.fn(),
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
			vi.fn(),
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
			vi.fn(),
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
			vi.fn(),
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
			vi.fn(),
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
			vi.fn(),
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
	beforeEach(() => vi.clearAllMocks());

	const allow: BrowserApprovalRequester = async () => true;

	/** Minimal structural stand-in for the Session slices these ops touch. */
	interface StoreSession {
		id: string;
		browserTabs: Array<Partial<BrowserTab>>;
		unifiedTabOrder: Array<{ type: string; id: string }>;
		activeBrowserTabId?: string | null;
		aiTabs?: unknown[];
		filePreviewTabs?: unknown[];
		terminalTabs?: unknown[];
	}

	/** Wires useSessionStore.getState().setSessions to a mutable array so the
	 *  tests can observe what the op actually did to the requesting session. */
	function wireStore(sessions: StoreSession[]) {
		const setSessions = vi.fn((updater: (prev: Session[]) => Session[]) => {
			// StoreSession is a structural stand-in for Session; the updaters under
			// test only touch the fields it carries.
			const prev = sessions as unknown as Session[];
			const next = updater(prev) as unknown as StoreSession[];
			sessions.length = 0;
			sessions.push(...next);
		});
		// Only setSessions is consumed from getState() on these paths.
		const storeState = { setSessions } as unknown as SessionStore;
		vi.mocked(useSessionStore.getState).mockReturnValue(storeState);
		return setSessions;
	}

	it('newTab creates a tab in the requesting (non-focused) session without any webview', async () => {
		vi.mocked(selectActiveSession).mockReturnValue(fakeActive('other', null));
		const sessions: StoreSession[] = [
			{ id: 'other', browserTabs: [], unifiedTabOrder: [] },
			{ id: 'sess-A', browserTabs: [], unifiedTabOrder: [], activeBrowserTabId: null },
		];
		const setSessions = wireStore(sessions);
		const requestApproval = vi.fn(async () => true);
		const resolveBackground = vi.fn(async () => null);
		const selectBrowserTab = vi.fn();
		const res = await resolveAndRun(
			{ current: new Map() },
			selectBrowserTab,
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
		expect(target?.activeBrowserTabId).toBe(created?.id);
		expect(target?.unifiedTabOrder).toContainEqual({ type: 'browser', id: created?.id });
		// The focused session is untouched.
		expect(sessions.find((s) => s.id === 'other')?.browserTabs).toHaveLength(0);
		// No webview handle was needed: neither mount path was exercised.
		expect(selectBrowserTab).not.toHaveBeenCalled();
		expect(resolveBackground).not.toHaveBeenCalled();
		// newTab is an interaction op: the approval gate still ran.
		expect(requestApproval).toHaveBeenCalled();
		expect(setSessions).toHaveBeenCalledTimes(1);
	});

	it('newTab without ephemeral mints a persistent per-session partition', async () => {
		vi.mocked(selectActiveSession).mockReturnValue(fakeActive('other', null));
		const sessions: StoreSession[] = [{ id: 'sess-A', browserTabs: [], unifiedTabOrder: [] }];
		wireStore(sessions);
		const res = await resolveAndRun(
			{ current: new Map() },
			vi.fn(),
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
			vi.fn(),
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
			vi.fn(),
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
			vi.fn(),
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

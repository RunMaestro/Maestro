import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	applyBrowserOp,
	resolveAndRun,
	type BrowserApprovalRequester,
} from '../../../../renderer/hooks/coworking/useCoworkingBrowserResponder';
import type { BrowserTabViewHandle } from '../../../../renderer/components/MainPanel/BrowserTabView';
import { selectActiveSession } from '../../../../renderer/stores/sessionStore';
import type { Session } from '../../../../renderer/types';

vi.mock('../../../../renderer/stores/sessionStore', () => ({
	useSessionStore: { getState: vi.fn(() => ({})) },
	selectActiveSession: vi.fn(),
	selectSessionById: vi.fn(() => () => ({
		id: 'sess-A',
		toolType: 'claude-code',
		activeBrowserTabId: null,
	})),
}));

function fakeActive(id: string, activeBrowserTabId: string | null): Session {
	// resolveAndRun only reads id + activeBrowserTabId; a minimal stand-in suffices.
	return { id, activeBrowserTabId } as unknown as Session;
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
});

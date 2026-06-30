import { describe, it, expect, vi } from 'vitest';
import { applyBrowserOp } from '../../../../renderer/hooks/coworking/useCoworkingBrowserResponder';
import type { BrowserTabViewHandle } from '../../../../renderer/components/MainPanel/BrowserTabView';

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
		const capturePage = vi.fn(async () => 'data:image/png;base64,XYZ');
		const res = await applyBrowserOp(makeHandle({ capturePage }), { kind: 'screenshot' });
		expect(res.ok).toBe(true);
		expect(res.dataUrl).toBe('data:image/png;base64,XYZ');
	});
});

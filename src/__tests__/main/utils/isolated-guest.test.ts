/**
 * @file isolated-guest.test.ts
 * @description The shared lockdown of isolated `<webview>` guests (plugin panels, DataviewJS): forced web
 * preferences, per-session hardening (the host's scheme served, every other request cancelled, every
 * permission denied, installed once), the scheme a session was hardened for, guest documents with the CSP
 * as header and meta, and the guest lockdown (popups denied, every navigation prevented).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { warnSpy } = vi.hoisted(() => ({ warnSpy: vi.fn() }));
vi.mock('../../../main/utils/logger', () => ({
	logger: { warn: warnSpy, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
	attachIsolatedGuestSecurity,
	hardenIsolatedGuestSession,
	hardenIsolatedGuestWebPreferences,
	isIsolatedGuestSession,
	isolatedGuestDocument,
	isolatedGuestNotFound,
	type IsolatedGuestContents,
} from '../../../main/utils/isolated-guest';

type ProtocolHandler = (request: { url: string }) => Response | Promise<Response>;
type BeforeRequestListener = (
	details: { url: string },
	callback: (response: { cancel: boolean }) => void
) => void;

function fakeSession() {
	return {
		protocol: { handle: vi.fn<(scheme: string, handler: ProtocolHandler) => void>() },
		webRequest: { onBeforeRequest: vi.fn<(listener: BeforeRequestListener) => void>() },
		setPermissionRequestHandler: vi.fn(),
		setPermissionCheckHandler: vi.fn(),
	};
}

const options = (serve: ProtocolHandler = () => isolatedGuestNotFound()) => ({
	scheme: 'guest-scheme',
	serve,
	label: 'test guest',
	logContext: 'Test',
});

beforeEach(() => warnSpy.mockClear());

describe('hardenIsolatedGuestWebPreferences', () => {
	it('forces the host preload and the locked-down flags over whatever the renderer set', () => {
		const prefs: Record<string, unknown> = {
			preload: '/tmp/evil.js',
			preloadURL: 'file:///tmp/evil.js',
			nodeIntegration: true,
			nodeIntegrationInSubFrames: true,
			nodeIntegrationInWorker: true,
			contextIsolation: false,
			sandbox: false,
			webSecurity: false,
			allowRunningInsecureContent: true,
			webviewTag: true,
			plugins: true,
		};
		hardenIsolatedGuestWebPreferences(prefs, '/dist/main/guest-preload.js');
		expect(prefs).toEqual({
			preload: '/dist/main/guest-preload.js',
			nodeIntegration: false,
			nodeIntegrationInSubFrames: false,
			nodeIntegrationInWorker: false,
			contextIsolation: true,
			sandbox: true,
			webSecurity: true,
			allowRunningInsecureContent: false,
			webviewTag: false,
			plugins: false,
		});
	});
});

describe('hardenIsolatedGuestSession', () => {
	it('installs the scheme handler, egress denial, and permission denial once per session', () => {
		const ses = fakeSession();
		expect(hardenIsolatedGuestSession(ses, options())).toBe(true);
		expect(hardenIsolatedGuestSession(ses, options())).toBe(false);
		expect(ses.protocol.handle).toHaveBeenCalledTimes(1);
		expect(ses.protocol.handle).toHaveBeenCalledWith('guest-scheme', expect.any(Function));
		expect(ses.webRequest.onBeforeRequest).toHaveBeenCalledTimes(1);
		expect(ses.setPermissionRequestHandler).toHaveBeenCalledTimes(1);
		expect(ses.setPermissionCheckHandler).toHaveBeenCalledTimes(1);
	});

	it('remembers which scheme a session serves', () => {
		const ses = fakeSession();
		hardenIsolatedGuestSession(ses, options());
		expect(isIsolatedGuestSession(ses, 'guest-scheme')).toBe(true);
		expect(isIsolatedGuestSession(ses, 'other-scheme')).toBe(false);
		expect(isIsolatedGuestSession(fakeSession(), 'guest-scheme')).toBe(false);
		expect(isIsolatedGuestSession(undefined, 'guest-scheme')).toBe(false);
		expect(isIsolatedGuestSession(null, 'guest-scheme')).toBe(false);
	});

	it("hands the scheme's requests to the host's serve function", async () => {
		const serve = vi.fn(() =>
			isolatedGuestDocument('<html><head></head></html>', "default-src 'none'")
		);
		const ses = fakeSession();
		hardenIsolatedGuestSession(ses, options(serve));
		const handler = ses.protocol.handle.mock.calls[0][1];
		const response = await handler({ url: 'guest-scheme://x/doc.html' });
		expect(serve).toHaveBeenCalledWith({ url: 'guest-scheme://x/doc.html' });
		expect(response.status).toBe(200);
	});

	it('cancels every request off the scheme, whatever the CSP lets through', () => {
		const ses = fakeSession();
		hardenIsolatedGuestSession(ses, options());
		const listener = ses.webRequest.onBeforeRequest.mock.calls[0][0];
		const cancelled: boolean[] = [];
		for (const url of [
			'https://evil.example/exfil?d=secret',
			'http://127.0.0.1:4000/',
			'ws://evil.example/socket',
			'file:///etc/passwd',
			'data:text/html,hi',
			'plugin-panel://panel/x',
			'guest-scheme://x/doc.html',
		]) {
			listener({ url }, (response) => cancelled.push(response.cancel));
		}
		expect(cancelled).toEqual([true, true, true, true, true, true, false]);
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('test guest egress'), 'Test');
	});

	it('denies every permission request and check', () => {
		const ses = fakeSession();
		hardenIsolatedGuestSession(ses, options());
		const requestHandler = ses.setPermissionRequestHandler.mock.calls[0][0] as (
			...args: unknown[]
		) => void;
		for (const permission of ['media', 'clipboard-read', 'notifications', 'geolocation']) {
			const callback = vi.fn();
			requestHandler({}, permission, callback);
			expect(callback, permission).toHaveBeenCalledWith(false);
		}
		const checkHandler = ses.setPermissionCheckHandler.mock.calls[0][0] as () => boolean;
		expect(checkHandler()).toBe(false);
	});
});

describe('isolatedGuestDocument', () => {
	it('serves HTML with the CSP as a header and as the first thing in the head', async () => {
		const csp = "default-src 'none'; script-src 'unsafe-inline'";
		const response = isolatedGuestDocument('<html><head><script>x()</script></head></html>', csp);
		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Security-Policy')).toBe(csp);
		expect(response.headers.get('Content-Type')).toContain('text/html');
		const body = await response.text();
		expect(body.indexOf('http-equiv="Content-Security-Policy"')).toBeLessThan(
			body.indexOf('<script')
		);
	});

	it('refuses with a bodiless 404', () => {
		const response = isolatedGuestNotFound();
		expect(response.status).toBe(404);
		expect(response.body).toBeNull();
	});
});

describe('attachIsolatedGuestSecurity', () => {
	function fakeGuest() {
		const handlers = new Map<string, (...args: unknown[]) => void>();
		let openHandler: (({ url }: { url: string }) => { action: string }) | null = null;
		const guest: IsolatedGuestContents = {
			setWindowOpenHandler: (handler) => {
				openHandler = handler;
			},
			on: (event, handler) => {
				handlers.set(event, handler as (...args: unknown[]) => void);
			},
		};
		return { guest, handlers, open: (url: string) => openHandler!({ url }) };
	}

	it('denies every popup', () => {
		const { guest, open } = fakeGuest();
		attachIsolatedGuestSecurity(guest, { label: 'test guest', logContext: 'Test' });
		expect(open('https://popup.example/')).toEqual({ action: 'deny' });
		expect(open('guest-scheme://x/doc.html')).toEqual({ action: 'deny' });
	});

	it('prevents every navigation, redirect, and frame navigation, its own scheme included', () => {
		const { guest, handlers } = fakeGuest();
		attachIsolatedGuestSecurity(guest, { label: 'test guest', logContext: 'Test' });
		for (const eventName of ['will-navigate', 'will-redirect'] as const) {
			for (const url of ['https://evil.example/', 'guest-scheme://x/doc.html']) {
				const preventDefault = vi.fn();
				handlers.get(eventName)!({ preventDefault }, url);
				expect(preventDefault, `${eventName} ${url}`).toHaveBeenCalled();
			}
		}
		const preventFrame = vi.fn();
		handlers.get('will-frame-navigate')!({ preventDefault: preventFrame, url: 'https://x/' });
		expect(preventFrame).toHaveBeenCalled();
	});
});

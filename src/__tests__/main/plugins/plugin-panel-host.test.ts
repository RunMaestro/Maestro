/**
 * @file plugin-panel-host.test.ts
 * @description Main-process lockdown of the plugin panel render host:
 * will-attach web-preference forcing (broker-only preload, no Node,
 * contextIsolation, sandbox), per-plugin session hardening (protocol handler
 * serves ONLY the session's own plugin's grant-gated documents with the CSP
 * header + meta; webRequest cancels all non-panel egress; permissions all
 * denied; idempotent per session), and guest lockdown (window.open denied,
 * every navigation/redirect prevented).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
	// The module accepts an injectable session factory; the electron `session`
	// default is only reached in production wiring.
	session: { fromPartition: vi.fn() },
}));

const { warnSpy } = vi.hoisted(() => ({ warnSpy: vi.fn() }));
vi.mock('../../../main/utils/logger', () => ({
	logger: { warn: warnSpy, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
	setPanelHtmlProvider,
	hardenPluginPanelWebPreferences,
	hardenPluginPanelSession,
	isPluginPanelSession,
	attachPluginPanelGuestSecurity,
	type PluginPanelGuestContents,
} from '../../../main/plugins/plugin-panel-host';
import { pluginPanelUrl, PANEL_CSP_CONTENT } from '../../../shared/plugins/panel-host';

type ProtocolHandler = (request: { url: string }) => Response;
type BeforeRequestListener = (
	details: { url: string },
	callback: (response: { cancel: boolean }) => void
) => void;

function fakeSession() {
	const ses = {
		protocol: { handle: vi.fn<(scheme: string, handler: ProtocolHandler) => void>() },
		webRequest: { onBeforeRequest: vi.fn<(listener: BeforeRequestListener) => void>() },
		setPermissionRequestHandler: vi.fn(),
		setPermissionCheckHandler: vi.fn(),
	};
	return ses;
}

beforeEach(() => {
	warnSpy.mockClear();
	setPanelHtmlProvider(() => null);
});

describe('hardenPluginPanelWebPreferences', () => {
	it('forces the broker-only preload and strips everything renderer-supplied', () => {
		const prefs: Record<string, unknown> = {
			preload: '/tmp/evil-preload.js',
			preloadURL: 'file:///tmp/evil.js',
			nodeIntegration: true,
			contextIsolation: false,
			sandbox: false,
		};
		hardenPluginPanelWebPreferences(prefs, '/dist/main/plugin-panel-preload.js');

		expect(prefs.preload).toBe('/dist/main/plugin-panel-preload.js');
		expect(prefs.preloadURL).toBeUndefined();
		expect(prefs.nodeIntegration).toBe(false);
		expect(prefs.nodeIntegrationInSubFrames).toBe(false);
		expect(prefs.nodeIntegrationInWorker).toBe(false);
		expect(prefs.contextIsolation).toBe(true);
		expect(prefs.sandbox).toBe(true);
		expect(prefs.webSecurity).toBe(true);
		expect(prefs.allowRunningInsecureContent).toBe(false);
		expect(prefs.webviewTag).toBe(false);
	});
});

describe('hardenPluginPanelSession', () => {
	it('registers the panel protocol, egress denial, and permission denial once per session', () => {
		const ses = fakeSession();
		const factory = vi.fn(() => ses);

		hardenPluginPanelSession('plugin:acme.tools', factory);
		hardenPluginPanelSession('plugin:acme.tools', factory);

		expect(factory).toHaveBeenCalledTimes(2);
		// Second call is a no-op: same session object, already hardened.
		expect(ses.protocol.handle).toHaveBeenCalledTimes(1);
		expect(ses.protocol.handle).toHaveBeenCalledWith('plugin-panel', expect.any(Function));
		expect(ses.webRequest.onBeforeRequest).toHaveBeenCalledTimes(1);
		expect(ses.setPermissionRequestHandler).toHaveBeenCalledTimes(1);
		expect(ses.setPermissionCheckHandler).toHaveBeenCalledTimes(1);
	});

	it('does nothing for a non-panel partition', () => {
		const ses = fakeSession();
		const factory = vi.fn(() => ses);
		hardenPluginPanelSession('persist:maestro-browser-session-1', factory);
		expect(factory).not.toHaveBeenCalled();
	});

	it('marks the session so did-attach-webview can branch on it', () => {
		const ses = fakeSession();
		hardenPluginPanelSession('plugin:acme.tools', () => ses);
		expect(isPluginPanelSession(ses)).toBe(true);
		expect(isPluginPanelSession(fakeSession())).toBe(false);
		expect(isPluginPanelSession(undefined)).toBe(false);
		expect(isPluginPanelSession(null)).toBe(false);
	});

	it("serves the plugin's own grant-gated document with the CSP header AND meta", async () => {
		setPanelHtmlProvider((panelId) =>
			panelId === 'acme.tools/board' ? '<html><head></head><body>hi</body></html>' : null
		);
		const ses = fakeSession();
		hardenPluginPanelSession('plugin:acme.tools', () => ses);
		const handler = ses.protocol.handle.mock.calls[0][1];

		const response = handler({ url: pluginPanelUrl('acme.tools/board') });
		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Security-Policy')).toBe(PANEL_CSP_CONTENT);
		expect(response.headers.get('Content-Type')).toContain('text/html');
		const body = await response.text();
		expect(body).toContain('<body>hi</body>');
		expect(body).toMatch(/<meta http-equiv="Content-Security-Policy"[^>]*connect-src 'none'/);
	});

	it("refuses another plugin's panel id on this session (404, no provider call)", () => {
		const provider = vi.fn(() => '<p>leak</p>');
		setPanelHtmlProvider(provider);
		const ses = fakeSession();
		hardenPluginPanelSession('plugin:acme.tools', () => ses);
		const handler = ses.protocol.handle.mock.calls[0][1];

		expect(handler({ url: pluginPanelUrl('evil.corp/board') }).status).toBe(404);
		expect(handler({ url: 'plugin-panel://panel/garbage%2F' }).status).toBe(404);
		expect(handler({ url: 'plugin-panel://elsewhere/x' }).status).toBe(404);
		expect(provider).not.toHaveBeenCalled();
	});

	it('404s an unknown/ungranted panel (provider returns null - default deny)', () => {
		const ses = fakeSession();
		hardenPluginPanelSession('plugin:acme.tools', () => ses);
		const handler = ses.protocol.handle.mock.calls[0][1];
		expect(handler({ url: pluginPanelUrl('acme.tools/board') }).status).toBe(404);
	});

	it('cancels every request that is not a panel-document fetch (session egress denial)', () => {
		const ses = fakeSession();
		hardenPluginPanelSession('plugin:acme.tools', () => ses);
		const listener = ses.webRequest.onBeforeRequest.mock.calls[0][0];

		const results: boolean[] = [];
		const capture = (response: { cancel: boolean }) => results.push(response.cancel);
		listener({ url: 'https://evil.example/exfil?d=secret' }, capture);
		listener({ url: 'http://10.0.0.1/leak' }, capture);
		listener({ url: 'ws://evil.example/socket' }, capture);
		listener({ url: 'file:///etc/passwd' }, capture);
		listener({ url: pluginPanelUrl('acme.tools/board') }, capture);

		expect(results).toEqual([true, true, true, true, false]);
	});

	it('denies every permission request and check', () => {
		const ses = fakeSession();
		hardenPluginPanelSession('plugin:acme.tools', () => ses);

		const requestHandler = ses.setPermissionRequestHandler.mock.calls[0][0] as (
			...args: unknown[]
		) => void;
		const granted = vi.fn();
		requestHandler({}, 'media', granted);
		expect(granted).toHaveBeenCalledWith(false);

		const checkHandler = ses.setPermissionCheckHandler.mock.calls[0][0] as () => boolean;
		expect(checkHandler()).toBe(false);
	});
});

describe('attachPluginPanelGuestSecurity', () => {
	function fakeGuest() {
		const handlers = new Map<string, (...args: unknown[]) => void>();
		let windowOpenHandler: (({ url }: { url: string }) => { action: string }) | null = null;
		const guest: PluginPanelGuestContents = {
			setWindowOpenHandler: (handler) => {
				windowOpenHandler = handler;
			},
			on: (event, handler) => {
				handlers.set(event, handler as (...args: unknown[]) => void);
			},
		};
		return { guest, handlers, getWindowOpenHandler: () => windowOpenHandler };
	}

	it('denies window.open', () => {
		const { guest, getWindowOpenHandler } = fakeGuest();
		attachPluginPanelGuestSecurity(guest);
		expect(getWindowOpenHandler()!({ url: 'https://popup.example/' })).toEqual({
			action: 'deny',
		});
	});

	it('prevents ALL navigations, redirects, and frame navigations', () => {
		const { guest, handlers } = fakeGuest();
		attachPluginPanelGuestSecurity(guest);

		for (const eventName of ['will-navigate', 'will-redirect'] as const) {
			const preventDefault = vi.fn();
			handlers.get(eventName)!({ preventDefault }, 'https://evil.example/?d=secret');
			expect(preventDefault, eventName).toHaveBeenCalled();
			// Even a same-scheme panel URL is denied - the guest lives on its
			// initial document forever.
			const preventOwn = vi.fn();
			handlers.get(eventName)!({ preventDefault: preventOwn }, pluginPanelUrl('acme.tools/board'));
			expect(preventOwn, eventName).toHaveBeenCalled();
		}

		const preventFrame = vi.fn();
		handlers.get('will-frame-navigate')!({
			preventDefault: preventFrame,
			url: 'https://evil.example/frame',
		});
		expect(preventFrame).toHaveBeenCalled();
	});
});

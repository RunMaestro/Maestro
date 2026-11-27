/**
 * Web permissions on a browser-tab session (RC-F10). Electron grants every permission request and check
 * on a session with no handler, and a browser-tab partition (`persist:maestro-browser-session-*`, or an
 * incognito `maestro-ephemeral-*`) had none, so any page in a Maestro browser tab got the camera, the
 * microphone, the location, and the rest without a prompt.
 *
 * These tests pin the policy (two kinds allowed, to the tab's own webview only), that it is installed once
 * per session, and that the webview attach gate installs it only on a partition that passed the gate,
 * without touching the plugin panel lockdown.
 */

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

const { fromPartition, sessions, logger } = vi.hoisted(() => {
	interface FakeSession {
		protocol: { handle: Mock };
		webRequest: { onBeforeRequest: Mock };
		setPermissionRequestHandler: Mock;
		setPermissionCheckHandler: Mock;
	}
	const sessions = new Map<string, FakeSession>();
	// One object per partition string, as Electron's `session.fromPartition` does.
	const fromPartition = vi.fn((partition: string) => {
		let ses = sessions.get(partition);
		if (!ses) {
			ses = {
				protocol: { handle: vi.fn() },
				webRequest: { onBeforeRequest: vi.fn() },
				setPermissionRequestHandler: vi.fn(),
				setPermissionCheckHandler: vi.fn(),
			};
			sessions.set(partition, ses);
		}
		return ses;
	});
	const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
	return { fromPartition, sessions, logger };
});

vi.mock('electron', () => ({
	session: { fromPartition },
	Menu: { buildFromTemplate: vi.fn() },
	shell: { openExternal: vi.fn() },
	clipboard: { writeText: vi.fn() },
}));
vi.mock('../../../main/utils/logger', () => ({ logger }));
vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));

import {
	attachGuestWebviewSecurity,
	hardenBrowserTabSession,
	isBrowserTabPermissionGranted,
} from '../../../main/app-lifecycle/guest-webview-security';

/** The kinds RC-F10 names as denied. */
const DENIED = [
	'media',
	'geolocation',
	'notifications',
	'midi',
	'midiSysex',
	'hid',
	'serial',
	'usb',
	'display-capture',
	'openExternal',
	'idle-detection',
	'storage-access',
	'top-level-storage-access',
	'window-management',
	'keyboardLock',
	'pointerLock',
];
const ALLOWED = ['clipboard-sanitized-write', 'fullscreen'];
/** Kinds the policy does not name. Every one is denied. */
const UNLISTED = [
	'clipboard-read',
	'deprecated-sync-clipboard-read',
	'fileSystem',
	'mediaKeySystem',
	'speaker-selection',
	'unknown',
	'a-kind-electron-adds-later',
	'',
];

const webview = { getType: () => 'webview' };
const offscreenPage = { getType: () => 'offscreen' };

/** Anything that is not the tab's own webview, with a label for the failure message. */
const OTHER_REQUESTERS: Array<[string, { getType?: () => string } | null]> = [
	['the offscreen relay page', offscreenPage],
	['an app window', { getType: () => 'window' }],
	['a webContents with no type', {}],
	['a check that names no webContents', null],
];

function fakeTabSession() {
	return { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() };
}

type InstalledOn = { setPermissionRequestHandler: Mock; setPermissionCheckHandler: Mock };

/** What the request handler installed on `ses` grants, read from the callback it answers. */
function requestGrants(ses: InstalledOn, requester: unknown, permission: string): boolean {
	const handler = ses.setPermissionRequestHandler.mock.calls[0][0];
	const callback = vi.fn();
	handler(requester, permission, callback, {});
	expect(callback, permission).toHaveBeenCalledTimes(1);
	return callback.mock.calls[0][0];
}

/** What the check handler installed on `ses` answers. */
function checkGrants(ses: InstalledOn, requester: unknown, permission: string): boolean {
	const handler = ses.setPermissionCheckHandler.mock.calls[0][0];
	return handler(requester, permission, 'https://example.com', {});
}

describe('isBrowserTabPermissionGranted', () => {
	it('denies the tab webview every kind RC-F10 names', () => {
		for (const permission of DENIED) {
			expect(isBrowserTabPermissionGranted(webview, permission), permission).toBe(false);
		}
	});

	it('allows the tab webview clipboard writes and fullscreen', () => {
		for (const permission of ALLOWED) {
			expect(isBrowserTabPermissionGranted(webview, permission), permission).toBe(true);
		}
	});

	it('denies a kind the policy does not name', () => {
		for (const permission of UNLISTED) {
			expect(isBrowserTabPermissionGranted(webview, permission), permission).toBe(false);
		}
	});

	it('denies an allowed kind to anything but the tab webview', () => {
		for (const [label, requester] of OTHER_REQUESTERS) {
			for (const permission of ALLOWED) {
				expect(
					isBrowserTabPermissionGranted(requester, permission),
					`${label}: ${permission}`
				).toBe(false);
			}
		}
	});
});

describe('hardenBrowserTabSession', () => {
	beforeEach(() => {
		logger.warn.mockClear();
	});

	it('installs the request and check handlers once per session', () => {
		const first = fakeTabSession();
		const second = fakeTabSession();

		expect(hardenBrowserTabSession(first)).toBe(true);
		expect(hardenBrowserTabSession(first)).toBe(false);
		expect(hardenBrowserTabSession(second)).toBe(true);

		expect(first.setPermissionRequestHandler).toHaveBeenCalledTimes(1);
		expect(first.setPermissionCheckHandler).toHaveBeenCalledTimes(1);
		expect(second.setPermissionRequestHandler).toHaveBeenCalledTimes(1);
		expect(second.setPermissionCheckHandler).toHaveBeenCalledTimes(1);
	});

	it('denies every named and unlisted kind, as a request and as a check', () => {
		const ses = fakeTabSession();
		hardenBrowserTabSession(ses);
		for (const permission of [...DENIED, ...UNLISTED]) {
			expect(requestGrants(ses, webview, permission), `request ${permission}`).toBe(false);
			expect(checkGrants(ses, webview, permission), `check ${permission}`).toBe(false);
		}
	});

	it('allows clipboard writes and fullscreen to the tab webview only, as a request and as a check', () => {
		const ses = fakeTabSession();
		hardenBrowserTabSession(ses);
		for (const permission of ALLOWED) {
			expect(requestGrants(ses, webview, permission), `request ${permission}`).toBe(true);
			expect(checkGrants(ses, webview, permission), `check ${permission}`).toBe(true);
			// The offscreen relay page shares the session and keeps the deny-all it had.
			expect(requestGrants(ses, offscreenPage, permission), `offscreen ${permission}`).toBe(false);
			expect(checkGrants(ses, offscreenPage, permission), `offscreen ${permission}`).toBe(false);
			expect(checkGrants(ses, null, permission), `no webContents ${permission}`).toBe(false);
		}
	});

	it('logs a refused request and nothing for a granted one', () => {
		const ses = fakeTabSession();
		hardenBrowserTabSession(ses);

		requestGrants(ses, webview, 'fullscreen');
		checkGrants(ses, webview, 'media');
		expect(logger.warn).not.toHaveBeenCalled();

		requestGrants(ses, webview, 'media');
		expect(logger.warn).toHaveBeenCalledTimes(1);
		expect(logger.warn).toHaveBeenCalledWith(
			'Blocked browser-tab permission request: media',
			'Window',
			{ permission: 'media', type: 'webview' }
		);
	});
});

describe('the webview attach gate', () => {
	type Handler = (...args: any[]) => unknown;

	/** Wire a window and return its `will-attach-webview` as a function that answers preventDefault. */
	function wireWindow(): (partition: string, src: string) => Mock {
		const handlers = new Map<string, Handler>();
		const browserWindow = {
			webContents: {
				on: (event: string, handler: Handler) => handlers.set(event, handler),
				send: vi.fn(),
			},
		};
		attachGuestWebviewSecurity(browserWindow as never, '/dist/main/preload.js');
		return (partition, src) => {
			const preventDefault = vi.fn();
			handlers.get('will-attach-webview')!({ preventDefault }, { partition }, { src });
			return preventDefault;
		};
	}

	beforeEach(() => {
		// Fresh session objects, so the once-per-session marker never carries over between tests.
		sessions.clear();
		fromPartition.mockClear();
	});

	it.each(['persist:maestro-browser-session-sess-1', 'maestro-ephemeral-sess-1-a1b2c3d4'])(
		'installs the policy on the session of %s once, however many tabs attach to it',
		(partition) => {
			const attach = wireWindow();
			const attachInSecondWindow = wireWindow();

			expect(attach(partition, 'https://example.com/')).not.toHaveBeenCalled();
			expect(attach(partition, 'https://example.com/other')).not.toHaveBeenCalled();
			expect(attachInSecondWindow(partition, 'about:blank')).not.toHaveBeenCalled();

			expect(fromPartition).toHaveBeenCalledWith(partition);
			const ses = sessions.get(partition)!;
			expect(ses.setPermissionRequestHandler).toHaveBeenCalledTimes(1);
			expect(ses.setPermissionCheckHandler).toHaveBeenCalledTimes(1);
			expect(requestGrants(ses, webview, 'media')).toBe(false);
			expect(requestGrants(ses, webview, 'fullscreen')).toBe(true);
			expect(checkGrants(ses, webview, 'geolocation')).toBe(false);
			expect(checkGrants(ses, webview, 'clipboard-sanitized-write')).toBe(true);
		}
	);

	it('opens no session for a partition or a page the gate refuses', () => {
		const attach = wireWindow();
		for (const [partition, src] of [
			['persist:evil', 'https://example.com/'],
			['maestro-ephemeral-x', 'https://example.com/'],
			['', 'https://example.com/'],
			['persist:maestro-browser-session-sess-1', 'chrome://settings'],
			['persist:maestro-browser-session-sess-1', 'javascript:alert(1)'],
		]) {
			expect(attach(partition, src), `${partition} ${src}`).toHaveBeenCalled();
		}
		expect(fromPartition).not.toHaveBeenCalled();
	});

	it('leaves a plugin panel session with its own deny-all', () => {
		const attach = wireWindow();
		const partition = 'plugin:acme.tools';

		expect(attach(partition, 'plugin-panel://panel/acme.tools%2Fboard')).not.toHaveBeenCalled();

		const ses = sessions.get(partition)!;
		expect(ses.setPermissionRequestHandler).toHaveBeenCalledTimes(1);
		expect(ses.setPermissionCheckHandler).toHaveBeenCalledTimes(1);
		// The browser-tab policy would allow these two; the panel lockdown allows nothing.
		expect(requestGrants(ses, webview, 'fullscreen')).toBe(false);
		expect(checkGrants(ses, webview, 'clipboard-sanitized-write')).toBe(false);
	});
});

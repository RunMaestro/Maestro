/**
 * @file guest-host.test.ts
 * @description The main-process host of the DataviewJS sandbox (src/main/dataview/guest-host.ts, D4): the
 * serving check (default deny until wired), the guest document (exactly the guest URL, only while
 * DataviewJS is serving, with the D4 CSP as header and meta), the per-root session hardening, and the
 * attached guest's lockdown (popups and navigation denied, audio muted).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({ session: { fromPartition: vi.fn() } }));
const { warnSpy, errorSpy } = vi.hoisted(() => ({ warnSpy: vi.fn(), errorSpy: vi.fn() }));
vi.mock('../../../main/utils/logger', () => ({
	logger: { warn: warnSpy, info: vi.fn(), error: errorSpy, debug: vi.fn() },
}));
vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));

import {
	DATAVIEW_GUEST_DOCUMENT_FILE,
	attachDataviewGuestSecurity,
	hardenDataviewGuestSession,
	hardenDataviewGuestWebPreferences,
	isDataviewGuestSession,
	isDataviewJsServing,
	serveDataviewGuestDocument,
	setDataviewJsServingCheck,
	type DataviewGuestContents,
} from '../../../main/dataview/guest-host';
import {
	DATAVIEW_GUEST_CSP,
	DATAVIEW_GUEST_URL,
	dataviewGuestPartition,
} from '../../../shared/dataview/sandboxHost';
import { isPluginPanelSession } from '../../../main/plugins/plugin-panel-host';

const GUEST_HTML =
	'<!doctype html><html><head><meta charset="utf-8" /></head><body>guest</body></html>';

function fakeSession() {
	return {
		protocol: { handle: vi.fn() },
		webRequest: { onBeforeRequest: vi.fn() },
		setPermissionRequestHandler: vi.fn(),
		setPermissionCheckHandler: vi.fn(),
	};
}

const documentOptions = (overrides: Record<string, unknown> = {}) => ({
	documentDir: '/dist/main',
	isServing: () => true,
	readDocument: vi.fn(async () => GUEST_HTML),
	...overrides,
});

beforeEach(() => {
	warnSpy.mockClear();
	errorSpy.mockClear();
	setDataviewJsServingCheck(() => false);
});

describe('isDataviewJsServing', () => {
	it('is false until the Dataview registration wires a check (default deny)', () => {
		expect(isDataviewJsServing()).toBe(false);
	});

	it('follows the wired check, and reads a check that throws as no', () => {
		setDataviewJsServingCheck(() => true);
		expect(isDataviewJsServing()).toBe(true);
		setDataviewJsServingCheck(() => {
			throw new Error('store gone');
		});
		expect(isDataviewJsServing()).toBe(false);
	});
});

describe('serveDataviewGuestDocument', () => {
	it('serves the built guest document with the D4 CSP as header and meta', async () => {
		const options = documentOptions();
		const response = await serveDataviewGuestDocument({ url: DATAVIEW_GUEST_URL }, options);
		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Security-Policy')).toBe(DATAVIEW_GUEST_CSP);
		const body = await response.text();
		expect(body).toContain(
			`<meta http-equiv="Content-Security-Policy" content="${DATAVIEW_GUEST_CSP}">`
		);
		expect(body).toContain('<body>guest</body>');
		expect(options.readDocument).toHaveBeenCalledWith(
			expect.stringMatching(new RegExp(`${DATAVIEW_GUEST_DOCUMENT_FILE}$`))
		);
	});

	it('refuses every URL but the guest document, without reading anything', async () => {
		const options = documentOptions();
		for (const url of [
			'dataview-guest://sandbox/other.html',
			`${DATAVIEW_GUEST_URL}?x=1`,
			'dataview-guest://evil/guest.html',
			'dataview-guest://sandbox/../../etc/passwd',
		]) {
			expect((await serveDataviewGuestDocument({ url }, options)).status, url).toBe(404);
		}
		expect(options.readDocument).not.toHaveBeenCalled();
	});

	it('refuses while DataviewJS is not serving, read on every load', async () => {
		let serving = true;
		const options = documentOptions({ isServing: () => serving });
		expect((await serveDataviewGuestDocument({ url: DATAVIEW_GUEST_URL }, options)).status).toBe(
			200
		);
		serving = false;
		expect((await serveDataviewGuestDocument({ url: DATAVIEW_GUEST_URL }, options)).status).toBe(
			404
		);
	});

	it('defaults to the wired serving check', async () => {
		const options = documentOptions({ isServing: undefined });
		expect((await serveDataviewGuestDocument({ url: DATAVIEW_GUEST_URL }, options)).status).toBe(
			404
		);
		setDataviewJsServingCheck(() => true);
		expect((await serveDataviewGuestDocument({ url: DATAVIEW_GUEST_URL }, options)).status).toBe(
			200
		);
	});

	it('answers 404 and reports when the built document cannot be read', async () => {
		const options = documentOptions({
			readDocument: vi.fn(async () => {
				throw new Error('ENOENT');
			}),
		});
		expect((await serveDataviewGuestDocument({ url: DATAVIEW_GUEST_URL }, options)).status).toBe(
			404
		);
		expect(errorSpy).toHaveBeenCalled();
	});
});

describe('hardenDataviewGuestSession', () => {
	it('hardens a guest partition once, and marks it as a Dataview guest session', async () => {
		const ses = fakeSession();
		const factory = vi.fn(() => ses);
		const partition = dataviewGuestPartition('/vault', null);
		hardenDataviewGuestSession(partition, documentOptions(), factory);
		hardenDataviewGuestSession(partition, documentOptions(), factory);
		expect(ses.protocol.handle).toHaveBeenCalledTimes(1);
		expect(ses.protocol.handle).toHaveBeenCalledWith('dataview-guest', expect.any(Function));
		expect(isDataviewGuestSession(ses)).toBe(true);
		expect(isPluginPanelSession(ses)).toBe(false);

		const handler = ses.protocol.handle.mock.calls[0][1] as (request: {
			url: string;
		}) => Promise<Response>;
		expect((await handler({ url: DATAVIEW_GUEST_URL })).status).toBe(200);
	});

	it('cancels every request off the guest scheme and denies every permission', () => {
		const ses = fakeSession();
		hardenDataviewGuestSession(
			dataviewGuestPartition('/vault', null),
			documentOptions(),
			() => ses
		);
		const listener = ses.webRequest.onBeforeRequest.mock.calls[0][0] as (
			details: { url: string },
			callback: (response: { cancel: boolean }) => void
		) => void;
		const cancelled: boolean[] = [];
		for (const url of ['https://example.com/', 'file:///etc/passwd', DATAVIEW_GUEST_URL]) {
			listener({ url }, (response) => cancelled.push(response.cancel));
		}
		expect(cancelled).toEqual([true, true, false]);
		const permission = vi.fn();
		(ses.setPermissionRequestHandler.mock.calls[0][0] as (...args: unknown[]) => void)(
			{},
			'media',
			permission
		);
		expect(permission).toHaveBeenCalledWith(false);
	});

	it('does nothing for a partition that is not a guest partition', () => {
		const factory = vi.fn(() => fakeSession());
		for (const partition of [
			'plugin:acme',
			'persist:maestro-browser-session-1',
			'dataview-guest:x',
		]) {
			hardenDataviewGuestSession(partition, documentOptions(), factory);
		}
		expect(factory).not.toHaveBeenCalled();
	});
});

describe('hardenDataviewGuestWebPreferences', () => {
	it('forces the bridge-only guest preload and the isolated-guest flags', () => {
		const prefs: Record<string, unknown> = { preload: '/tmp/evil.js', nodeIntegration: true };
		hardenDataviewGuestWebPreferences(prefs, '/dist/main/dataview-guest-preload.js');
		expect(prefs.preload).toBe('/dist/main/dataview-guest-preload.js');
		expect(prefs.nodeIntegration).toBe(false);
		expect(prefs.contextIsolation).toBe(true);
		expect(prefs.sandbox).toBe(true);
		expect(prefs.webSecurity).toBe(true);
		expect(prefs.webviewTag).toBe(false);
	});
});

describe('attachDataviewGuestSecurity', () => {
	it('denies popups and every navigation, and mutes the guest', () => {
		const handlers = new Map<string, (...args: unknown[]) => void>();
		const setWindowOpenHandler = vi.fn();
		const setAudioMuted = vi.fn();
		const guest: DataviewGuestContents = {
			setWindowOpenHandler,
			setAudioMuted,
			on: (event, handler) => {
				handlers.set(event, handler as (...args: unknown[]) => void);
			},
		};
		attachDataviewGuestSecurity(guest);
		expect(setWindowOpenHandler.mock.calls[0][0]({ url: 'https://x/' })).toEqual({
			action: 'deny',
		});
		for (const eventName of ['will-navigate', 'will-redirect', 'will-frame-navigate']) {
			const preventDefault = vi.fn();
			handlers.get(eventName)!({ preventDefault, url: DATAVIEW_GUEST_URL }, DATAVIEW_GUEST_URL);
			expect(preventDefault, eventName).toHaveBeenCalled();
		}
		expect(setAudioMuted).toHaveBeenCalledWith(true);
	});
});

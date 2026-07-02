/**
 * Unit tests for the web-desktop electron shim's webFrame zoom emulation.
 *
 * In the real desktop app Electron's webFrame scales the WebFrame contents; the
 * web-desktop bundle emulates that with the document `zoom` CSS property. These
 * tests lock in the factor <-> level relation (factor = 1.2 ** level) and the
 * document side effect so Cmd+Plus / Cmd+Minus can drive zoom in the browser.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

// The shim constructs a BridgeClient (and therefore a WebSocket) at module
// load. Stub WebSocket with an inert class BEFORE importing the module so the
// test never opens a real socket or schedules reconnect timers. The dynamic
// import below evaluates the module only after this stub is in place.
class InertWebSocket {
	static readonly CONNECTING = 0;
	readyState = 0;
	send(): void {}
	close(): void {}
	addEventListener(): void {}
	removeEventListener(): void {}
	set onopen(_v: unknown) {}
	set onmessage(_v: unknown) {}
	set onclose(_v: unknown) {}
	set onerror(_v: unknown) {}
}
vi.stubGlobal('WebSocket', InertWebSocket);

const { webFrame } = await import('../../web-desktop/electron-shim');

afterAll(() => {
	vi.unstubAllGlobals();
});

describe('web-desktop electron-shim webFrame zoom', () => {
	beforeEach(() => {
		// Reset the module-level zoom singleton to a known baseline (factor 1).
		webFrame.setZoomLevel(0);
	});

	it('starts at factor 1 / level 0 and reflects that on the document', () => {
		expect(webFrame.getZoomFactor()).toBe(1);
		expect(webFrame.getZoomLevel()).toBe(0);
		expect(document.documentElement.style.zoom).toBe('1');
	});

	it('setZoomFactor stores the factor and applies it to the document', () => {
		webFrame.setZoomFactor(1.5);
		expect(webFrame.getZoomFactor()).toBe(1.5);
		expect(document.documentElement.style.zoom).toBe('1.5');
	});

	it('setZoomLevel maps level to factor via 1.2 ** level', () => {
		webFrame.setZoomLevel(2);
		expect(webFrame.getZoomFactor()).toBeCloseTo(1.2 ** 2, 10);
		expect(document.documentElement.style.zoom).toBe(String(1.2 ** 2));
	});

	it('setZoomLevel with a negative level zooms out below 1', () => {
		webFrame.setZoomLevel(-1);
		expect(webFrame.getZoomFactor()).toBeCloseTo(1.2 ** -1, 10);
	});

	it('getZoomLevel round-trips a level set via setZoomLevel', () => {
		webFrame.setZoomLevel(3);
		expect(webFrame.getZoomLevel()).toBeCloseTo(3, 10);
	});

	it('getZoomLevel derives the level from a factor set via setZoomFactor', () => {
		webFrame.setZoomFactor(1.2);
		expect(webFrame.getZoomLevel()).toBeCloseTo(1, 10);
	});
});

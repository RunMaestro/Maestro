/**
 * Unit tests for the web-desktop electron shim: webFrame zoom emulation and
 * the bridge's reconnect-resync behavior.
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
// import below evaluates the module only after this stub is in place. The stub
// records instances and listeners so the reconnect tests can drive the socket
// lifecycle (open -> close -> reopen) by hand.
class InertWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static instances: InertWebSocket[] = [];
	readyState = 0;
	readonly url: string;
	sent: string[] = [];
	private listeners = new Map<string, Set<(ev?: unknown) => void>>();
	constructor(url: string) {
		this.url = url;
		InertWebSocket.instances.push(this);
	}
	send(frame: string): void {
		this.sent.push(frame);
	}
	close(): void {}
	addEventListener(type: string, cb: (ev?: unknown) => void): void {
		let set = this.listeners.get(type);
		if (!set) {
			set = new Set();
			this.listeners.set(type, set);
		}
		set.add(cb);
	}
	removeEventListener(type: string, cb: (ev?: unknown) => void): void {
		this.listeners.get(type)?.delete(cb);
	}
	emit(type: string, ev?: unknown): void {
		for (const cb of this.listeners.get(type) ?? []) cb(ev);
	}
	set onopen(_v: unknown) {}
	set onmessage(_v: unknown) {}
	set onclose(_v: unknown) {}
	set onerror(_v: unknown) {}
}
vi.stubGlobal('WebSocket', InertWebSocket);

// jsdom's location.reload throws "not implemented"; the reconnect-resync test
// asserts the shim calls it, so swap in a spyable stand-in before import.
const originalLocation = window.location;
Object.defineProperty(window, 'location', {
	configurable: true,
	writable: true,
	value: { ...originalLocation, reload: vi.fn() },
});

const { ipcRenderer, webFrame } = await import('../../web-desktop/electron-shim');

afterAll(() => {
	vi.unstubAllGlobals();
	Object.defineProperty(window, 'location', {
		configurable: true,
		writable: true,
		value: originalLocation,
	});
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

describe('web-desktop electron-shim desktop navigation sync', () => {
	it('routes desktop active-session packets through the renderer remote-selection event', () => {
		const listener = vi.fn();
		ipcRenderer.on('remote:selectSession', listener);

		InertWebSocket.instances[0].emit('message', {
			data: JSON.stringify({ type: 'active_session_changed', sessionId: 'session-2' }),
		});

		expect(listener).toHaveBeenCalledWith({ senderFrame: null }, 'session-2');
		ipcRenderer.removeListener('remote:selectSession', listener);
	});

	it('routes desktop active-tab packets through the renderer remote-selection event', () => {
		const listener = vi.fn();
		ipcRenderer.on('remote:selectTab', listener);
		const aiTabs = [
			{
				id: 'tab-3',
				agentSessionId: 'provider-session-3',
				name: 'Synced tab',
				starred: false,
				inputValue: '',
				createdAt: 1700000000000,
				state: 'idle',
			},
		];

		InertWebSocket.instances[0].emit('message', {
			data: JSON.stringify({
				type: 'tabs_changed',
				sessionId: 'session-2',
				activeTabId: 'tab-3',
				aiTabs,
			}),
		});

		expect(listener).toHaveBeenCalledWith({ senderFrame: null }, 'session-2', 'tab-3', aiTabs);
		ipcRenderer.removeListener('remote:selectTab', listener);
	});
});

describe('web-desktop electron-shim bridge reconnect', () => {
	const frame = (msg: object) => ({ data: JSON.stringify(msg) });

	// Drop the socket and let the shim's 1s reconnect timer fire. Returns the
	// socket it opened for the retry.
	function reconnect(current: InertWebSocket): InertWebSocket {
		vi.useFakeTimers();
		try {
			current.emit('close');
			vi.advanceTimersByTime(1000);
		} finally {
			vi.useRealTimers();
		}
		const next = InertWebSocket.instances[InertWebSocket.instances.length - 1];
		expect(next).not.toBe(current);
		return next;
	}

	it('resumes in place when the server can replay the gap, and reloads only when it cannot', async () => {
		const first = InertWebSocket.instances[0];
		expect(first).toBeDefined();

		// First successful open: a normal boot, no reload. The server names its
		// run and reports where its counter stands at connect time.
		first.emit('open');
		first.emit('message', frame({ type: 'connected', bridgeEpoch: 'run-1', bridgeSeq: 5 }));
		expect(window.location.reload).not.toHaveBeenCalled();

		// Drop before a single broadcast arrived. The baseline is the counter the
		// server reported at connect time, not 0: since=0 would replay history
		// from before the tab opened, or force a reload once seq 1 was evicted.
		const second = reconnect(first);
		const url = new URL(second.url);
		expect(url.searchParams.get('since')).toBe('5');
		expect(url.searchParams.get('epoch')).toBe('run-1');

		// An invoke issued during the gap waits for the resume decision rather
		// than hanging or being dropped.
		second.readyState = InertWebSocket.OPEN;
		const invoke = ipcRenderer.invoke('some:channel');
		second.emit('open');
		expect(second.sent).toHaveLength(0);

		// The server replayed everything missed: no reload, and the queued invoke
		// goes out on the new socket. The counter on a RESUMED `connected` must
		// not move lastSeq: the replayed frames that follow carry their own seq,
		// and jumping ahead would skip any of them lost to a second drop.
		second.emit(
			'message',
			frame({ type: 'connected', bridgeEpoch: 'run-1', bridgeSeq: 99, resumed: true })
		);
		await new Promise((r) => setTimeout(r, 0));
		expect(window.location.reload).not.toHaveBeenCalled();
		const sentInvoke = second.sent
			.map((f) => JSON.parse(f))
			.find((f) => f.channel === 'some:channel');
		expect(sentInvoke).toBeDefined();
		second.emit(
			'message',
			frame({ type: 'bridge.response', requestId: sentInvoke.requestId, ok: true, result: 'ok' })
		);
		await expect(invoke).resolves.toBe('ok');
		second.emit('message', frame({ type: 'bridge.event', channel: 'noop', args: [], seq: 6 }));

		// Drop again; this time the server cannot replay the gap (it restarted).
		// The only source of truth left is the desktop's live store, so reload.
		const third = reconnect(second);
		expect(new URL(third.url).searchParams.get('since')).toBe('6');
		third.emit('open');
		third.emit('message', frame({ type: 'connected', bridgeEpoch: 'run-2', resumed: false }));
		expect(window.location.reload).toHaveBeenCalledTimes(1);

		// An older server that knows nothing about resume behaves the same way.
		const fourth = reconnect(third);
		fourth.emit('open');
		fourth.emit('message', frame({ type: 'connected' }));
		expect(window.location.reload).toHaveBeenCalledTimes(2);
	});
});

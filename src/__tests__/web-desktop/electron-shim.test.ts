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
	static instances: InertWebSocket[] = [];
	readyState = 0;
	private listeners = new Map<string, Set<(ev?: unknown) => void>>();
	constructor() {
		InertWebSocket.instances.push(this);
	}
	send(): void {}
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

describe('web-desktop electron-shim autorun_state routing', () => {
	// Auto Run is renderer-owned in-memory state. The owning client pushes it to
	// main, which fans it out to every WebSocket client as an `autorun_state`
	// packet - the only way a browser tab can learn a run exists. The router had
	// no case for it, so the frame was parsed and dropped and every Auto Run
	// surface in the browser stayed empty for the whole run.
	it('routes an autorun_state packet onto the mirror channel', () => {
		const listener = vi.fn();
		ipcRenderer.on('remote:autoRunStateMirror', listener);

		const state = {
			isRunning: true,
			totalTasks: 6,
			completedTasks: 2,
			currentTaskIndex: 2,
			documents: ['plan'],
		};

		InertWebSocket.instances[0].emit('message', {
			data: JSON.stringify({ type: 'autorun_state', sessionId: 'session-9', state }),
		});

		expect(listener).toHaveBeenCalledWith({ senderFrame: null }, 'session-9', state);
		ipcRenderer.removeListener('remote:autoRunStateMirror', listener);
	});

	it('replays the latest frame when the renderer subscribes after socket setup', () => {
		const first = { isRunning: true, totalTasks: 4, completedTasks: 1, currentTaskIndex: 1 };
		const latest = { ...first, completedTasks: 2, currentTaskIndex: 2 };

		InertWebSocket.instances[0].emit('message', {
			data: JSON.stringify({ type: 'autorun_state', sessionId: 'late-session', state: first }),
		});
		InertWebSocket.instances[0].emit('message', {
			data: JSON.stringify({ type: 'autorun_state', sessionId: 'late-session', state: latest }),
		});

		const listener = vi.fn();
		ipcRenderer.on('remote:autoRunStateMirror', listener);

		expect(listener).toHaveBeenCalledTimes(1);
		expect(listener).toHaveBeenCalledWith({ senderFrame: null }, 'late-session', latest);
		ipcRenderer.removeListener('remote:autoRunStateMirror', listener);
	});

	it('forwards a null state (run cleared) rather than dropping the frame', () => {
		const listener = vi.fn();
		ipcRenderer.on('remote:autoRunStateMirror', listener);

		InertWebSocket.instances[0].emit('message', {
			data: JSON.stringify({ type: 'autorun_state', sessionId: 'session-9', state: null }),
		});

		expect(listener).toHaveBeenCalledWith({ senderFrame: null }, 'session-9', null);
		ipcRenderer.removeListener('remote:autoRunStateMirror', listener);
	});

	it('ignores a packet with no sessionId to address it to', () => {
		const listener = vi.fn();
		ipcRenderer.on('remote:autoRunStateMirror', listener);

		InertWebSocket.instances[0].emit('message', {
			data: JSON.stringify({ type: 'autorun_state', state: { isRunning: true } }),
		});

		expect(listener).not.toHaveBeenCalled();
		ipcRenderer.removeListener('remote:autoRunStateMirror', listener);
	});
});

describe('web-desktop electron-shim bridge reconnect', () => {
	it('reloads the page on a RE-connect (drop + reopen), not on the first open', () => {
		const first = InertWebSocket.instances[0];
		expect(first).toBeDefined();

		// First successful open: a normal boot, no reload.
		first.emit('open');
		expect(window.location.reload).not.toHaveBeenCalled();

		// Drop the socket. The shim schedules a reconnect in 1s; every push
		// event during the gap is lost (no replay), so the renderer's state is
		// stale beyond repair - the reopened connection must trigger a reload
		// to re-bootstrap from the desktop's live store.
		vi.useFakeTimers();
		try {
			first.emit('close');
			vi.advanceTimersByTime(1000);
		} finally {
			vi.useRealTimers();
		}

		const second = InertWebSocket.instances[1];
		expect(second).toBeDefined();
		second.emit('open');
		expect(window.location.reload).toHaveBeenCalledTimes(1);
	});
});

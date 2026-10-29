/**
 * Unit tests for the web-desktop electron shim: webFrame zoom emulation and
 * the bridge's reconnect-resync behavior.
 *
 * In the real desktop app Electron's webFrame scales the WebFrame contents; the
 * web-desktop bundle emulates that with the document `zoom` CSS property. These
 * tests lock in the factor <-> level relation (factor = 1.2 ** level) and the
 * document side effect so Cmd+Plus / Cmd+Minus can drive zoom in the browser.
 */

import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from 'vitest';

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
	closeCalls = 0;
	close(): void {
		this.closeCalls += 1;
	}
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

// A navigation spy also proves recovery never replaces the mounted page.
const originalLocation = window.location;
Object.defineProperty(window, 'location', {
	configurable: true,
	writable: true,
	value: { ...originalLocation, reload: vi.fn() },
});

let ipcRenderer: typeof import('../../web-desktop/electron-shim').ipcRenderer;
let webFrame: typeof import('../../web-desktop/electron-shim').webFrame;
let BRIDGE_HEARTBEAT_INTERVAL_MS: number;
let BRIDGE_PONG_TIMEOUT_MS: number;
const reconcileInPlace = (event: Event) => {
	const detail = (event as CustomEvent).detail;
	if (detail?.authoritative) detail.waitUntil(Promise.resolve());
};
beforeEach(async () => {
	vi.resetModules();
	vi.useFakeTimers();
	InertWebSocket.instances = [];
	vi.stubGlobal('WebSocket', InertWebSocket);
	Object.defineProperty(window, 'location', {
		configurable: true,
		writable: true,
		value: { ...originalLocation, reload: vi.fn() },
	});
	({ ipcRenderer, webFrame, BRIDGE_HEARTBEAT_INTERVAL_MS, BRIDGE_PONG_TIMEOUT_MS } =
		await import('../../web-desktop/electron-shim'));
	window.addEventListener('maestro:webBridgeReconcile', reconcileInPlace);
});
afterEach(() => {
	InertWebSocket.instances.at(-1)?.emit('close');
	window.removeEventListener('maestro:webBridgeReconcile', reconcileInPlace);
	vi.clearAllTimers();
	vi.useRealTimers();
});

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
	it('never routes the desktop active-session packet: focus is per client', () => {
		const listener = vi.fn();
		ipcRenderer.on('remote:selectSession', listener);

		InertWebSocket.instances[0].emit('message', {
			data: JSON.stringify({ type: 'active_session_changed', sessionId: 'session-2' }),
		});

		expect(listener).not.toHaveBeenCalled();
		ipcRenderer.removeListener('remote:selectSession', listener);
	});

	it('routes tabs_changed as an inventory snapshot without the activeTabChanged flag', () => {
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
				activeTabChanged: true,
				aiTabs,
			}),
		});

		expect(listener).toHaveBeenCalledWith({ senderFrame: null }, 'session-2', 'tab-3', aiTabs);
		ipcRenderer.removeListener('remote:selectTab', listener);
	});
});

describe('web-desktop electron-shim foreground recovery', () => {
	it('probes the socket immediately when the page returns to the foreground', () => {
		const socket = InertWebSocket.instances[0];
		socket.readyState = InertWebSocket.OPEN;
		const before = socket.sent.length;

		window.dispatchEvent(new Event('pageshow'));

		expect(JSON.parse(socket.sent[before])).toEqual({ type: 'ping' });
		socket.emit('message', { data: JSON.stringify({ type: 'pong' }) });
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

	it('replays only one buffered frame to a once listener and preserves the rest', () => {
		for (const sessionId of ['first-session', 'second-session']) {
			InertWebSocket.instances[0].emit('message', {
				data: JSON.stringify({
					type: 'autorun_state',
					sessionId,
					state: { isRunning: true },
				}),
			});
		}

		const onceListener = vi.fn();
		ipcRenderer.once('remote:autoRunStateMirror', onceListener);

		expect(onceListener).toHaveBeenCalledTimes(1);
		expect(onceListener).toHaveBeenCalledWith({ senderFrame: null }, 'first-session', {
			isRunning: true,
		});

		const remainingListener = vi.fn();
		ipcRenderer.on('remote:autoRunStateMirror', remainingListener);
		expect(remainingListener).toHaveBeenCalledTimes(1);
		expect(remainingListener).toHaveBeenCalledWith({ senderFrame: null }, 'second-session', {
			isRunning: true,
		});
		ipcRenderer.removeListener('remote:autoRunStateMirror', remainingListener);
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
	const frame = (msg: object) => ({ data: JSON.stringify(msg) });

	// Drop the socket and let the shim's 1s reconnect timer fire. Returns the
	// socket it opened for the retry.
	function reconnect(current: InertWebSocket): InertWebSocket {
		current.emit('close');
		vi.advanceTimersByTime(1000);
		const next = InertWebSocket.instances[InertWebSocket.instances.length - 1];
		expect(next).not.toBe(current);
		return next;
	}

	/**
	 * Web Login. A socket refused because the browser holds no session cannot be
	 * fixed by reconnecting - it would spin against the wall once a second
	 * forever, with the page looking merely slow - so the shim goes and gets a
	 * session instead. The server sends the same code when an account is
	 * deleted, disabled, or has its password reset, which is how a revocation
	 * reaches a browser that is already connected.
	 */
	it('goes to the login page on a 4401 close instead of reconnecting', () => {
		const before = InertWebSocket.instances.length;
		const current = InertWebSocket.instances[before - 1];
		window.__MAESTRO_CONFIG__ = { securityToken: 'tok-123' } as never;

		vi.useFakeTimers();
		try {
			current.emit('close', { code: 4401 });
			vi.advanceTimersByTime(5000);
		} finally {
			vi.useRealTimers();
		}

		expect(window.location.href).toBe('/tok-123/login');
		// No retry was scheduled: a reconnect here is a loop, not a recovery.
		expect(InertWebSocket.instances.length).toBe(before);
		delete window.__MAESTRO_CONFIG__;
	});

	it('replays retained history and reconciles missing history in place', async () => {
		const first = InertWebSocket.instances[0];
		expect(first).toBeDefined();

		// First successful open: a normal boot, no reload. The server names its
		// run and reports where its counter stands at connect time.
		first.readyState = InertWebSocket.OPEN;
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

		// Actions issued during a gap fail immediately, never wait then run.
		second.readyState = InertWebSocket.OPEN;
		const invoke = ipcRenderer.invoke('process:spawn', { sessionId: 'remote' });
		await expect(invoke).rejects.toThrow('Not submitted');
		second.emit('open');
		expect(second.sent).toHaveLength(0);

		// Event replay still resumes in place without resubmitting rejected work.
		second.emit(
			'message',
			frame({ type: 'connected', bridgeEpoch: 'run-1', bridgeSeq: 99, resumed: true })
		);
		await vi.advanceTimersByTimeAsync(0);
		expect(window.location.reload).not.toHaveBeenCalled();
		expect(
			second.sent.map((data) => JSON.parse(data)).some((packet) => packet.type === 'bridge.invoke')
		).toBe(false);
		second.emit('message', frame({ type: 'bridge.event', channel: 'noop', args: [], seq: 6 }));

		// A lost epoch refreshes host state without discarding this page.
		const third = reconnect(second);
		expect(new URL(third.url).searchParams.get('since')).toBe('6');
		third.readyState = InertWebSocket.OPEN;
		third.emit('open');
		third.emit('message', frame({ type: 'connected', bridgeEpoch: 'run-2', resumed: false }));
		await vi.advanceTimersByTimeAsync(0);
		expect((window as any).__MAESTRO_BRIDGE_STATE__).toBe('connected');

		// An older server that knows nothing about resume behaves the same way.
		const fourth = reconnect(third);
		fourth.readyState = InertWebSocket.OPEN;
		fourth.emit('open');
		fourth.emit('message', frame({ type: 'connected' }));
		await vi.advanceTimersByTimeAsync(0);
		expect((window as any).__MAESTRO_BRIDGE_STATE__).toBe('connected');
		expect(window.location.reload).not.toHaveBeenCalled();
	});
	it('allows a new save after an acknowledged rejection without replaying the rejected save', async () => {
		const socket = InertWebSocket.instances.at(-1)!;
		socket.readyState = InertWebSocket.OPEN;
		socket.emit('open');
		socket.emit('message', frame({ type: 'connected', bridgeEpoch: 'run-2', resumed: true }));
		const first = ipcRenderer.invoke('sessions:setMany', [{ id: 'stale' }]);
		const refused = expect(first).rejects.toThrow('stale execution queue');
		await Promise.resolve();
		const request = JSON.parse(socket.sent.at(-1)!);
		socket.emit(
			'message',
			frame({
				type: 'bridge.response',
				requestId: request.requestId,
				ok: false,
				error: 'stale execution queue',
			})
		);
		await refused;
		const second = ipcRenderer.invoke('sessions:setMany', [{ id: 'fresh' }]);
		const accepted = expect(second).resolves.toBe(true);
		await Promise.resolve();
		const nextRequest = JSON.parse(socket.sent.at(-1)!);
		expect(nextRequest.args).toEqual([[{ id: 'fresh' }]]);
		socket.emit(
			'message',
			frame({ type: 'bridge.response', requestId: nextRequest.requestId, ok: true, result: true })
		);
		await accepted;
		expect(
			socket.sent
				.map((data) => JSON.parse(data))
				.filter(
					(packet) => packet.channel === 'sessions:setMany' && packet.args[0][0]?.id === 'stale'
				)
		).toHaveLength(1);
	});

	it('shows lost-acknowledgement uncertainty and never reissues an accepted mutation', async () => {
		const socket = InertWebSocket.instances.at(-1)!;
		socket.readyState = InertWebSocket.OPEN;
		socket.emit('open');
		socket.emit('message', frame({ type: 'connected', bridgeEpoch: 'run-2', resumed: true }));
		const submission = ipcRenderer.invoke('process:spawn', { sessionId: 'accepted-on-host' });
		const rejected = expect(submission).rejects.toThrow('Submission uncertainty');
		await Promise.resolve();
		expect(
			socket.sent
				.map((data) => JSON.parse(data))
				.filter((packet) => packet.channel === 'process:spawn')
		).toHaveLength(1);
		const next = reconnect(socket);
		await rejected;
		expect(document.getElementById('maestro-submission-notice')?.textContent).toContain(
			'host may have accepted it'
		);
		next.readyState = InertWebSocket.OPEN;
		next.emit('open');
		next.emit('message', frame({ type: 'connected', bridgeEpoch: 'run-2', resumed: true }));
		await Promise.resolve();
		expect(
			next.sent.map((data) => JSON.parse(data)).some((packet) => packet.channel === 'process:spawn')
		).toBe(false);
		expect(sessionStorage.getItem('maestro:web-desktop:uncertain-submission:v2')).toContain(
			'process:spawn'
		);
	});
	it('preserves capability-read rejection without showing a submission banner while mutation rejection remains visible', async () => {
		document.getElementById('maestro-submission-notice')?.remove();
		sessionStorage.removeItem('maestro:web-desktop:uncertain-submission:v2');
		const socket = InertWebSocket.instances.at(-1)!;
		socket.readyState = InertWebSocket.OPEN;
		socket.emit('open');
		socket.emit('message', frame({ type: 'connected', bridgeEpoch: 'run-2', resumed: true }));
		const query = ipcRenderer.invoke('plugins:contributions');
		const queryRejected = expect(query).rejects.toThrow('PluginsDisabled');
		await Promise.resolve();
		const queryRequest = JSON.parse(socket.sent.at(-1)!);
		socket.emit(
			'message',
			frame({
				type: 'bridge.response',
				requestId: queryRequest.requestId,
				ok: false,
				error: 'PluginsDisabled',
			})
		);
		await queryRejected;
		expect(document.getElementById('maestro-submission-notice')).toBeNull();
		expect(sessionStorage.getItem('maestro:web-desktop:uncertain-submission:v2')).toBeNull();
		const mutation = ipcRenderer.invoke('agentRun:event', { runId: 'rejected', type: 'note' });
		const mutationRejected = expect(mutation).rejects.toThrow('Permission denied');
		await Promise.resolve();
		const mutationRequest = JSON.parse(socket.sent.at(-1)!);
		socket.emit(
			'message',
			frame({
				type: 'bridge.response',
				requestId: mutationRequest.requestId,
				ok: false,
				error: 'Permission denied',
			})
		);
		await mutationRejected;
		expect(document.getElementById('maestro-submission-notice')?.textContent).toContain(
			'Submission rejected for agentRun:event'
		);
	});

	it('rejects a channel the web interface does not offer without a submission banner', async () => {
		document.getElementById('maestro-submission-notice')?.remove();
		sessionStorage.removeItem('maestro:web-desktop:uncertain-submission:v2');
		const socket = InertWebSocket.instances.at(-1)!;
		socket.readyState = InertWebSocket.OPEN;
		socket.emit('open');
		socket.emit('message', frame({ type: 'connected', bridgeEpoch: 'run-2', resumed: true }));
		const denied = 'Channel "web:takeOrphanedAutoRuns" is not available over the web interface';
		const call = ipcRenderer.invoke('web:takeOrphanedAutoRuns', 'client-1');
		const rejected = expect(call).rejects.toThrow(denied);
		await Promise.resolve();
		const request = JSON.parse(socket.sent.at(-1)!);
		socket.emit(
			'message',
			frame({ type: 'bridge.response', requestId: request.requestId, ok: false, error: denied })
		);
		await rejected;
		expect(document.getElementById('maestro-submission-notice')).toBeNull();
		expect(sessionStorage.getItem('maestro:web-desktop:uncertain-submission:v2')).toBeNull();
	});

	it('restores state after a lost autosave acknowledgement without a submission banner', async () => {
		document.getElementById('maestro-submission-notice')?.remove();
		sessionStorage.removeItem('maestro:web-desktop:uncertain-submission:v2');
		const socket = InertWebSocket.instances.at(-1)!;
		socket.readyState = InertWebSocket.OPEN;
		socket.emit('open');
		socket.emit('message', frame({ type: 'connected', bridgeEpoch: 'run-2', resumed: true }));
		const save = ipcRenderer.invoke('sessions:setMany', [{ id: 'autosave' }], [], []);
		const uncertain = expect(save).rejects.toThrow('Submission uncertainty');
		await Promise.resolve();
		const next = reconnect(socket);
		await uncertain;
		expect(document.getElementById('maestro-submission-notice')).toBeNull();
		expect(sessionStorage.getItem('maestro:web-desktop:uncertain-submission:v2')).toBeNull();
		next.readyState = InertWebSocket.OPEN;
		next.emit('open');
		next.emit('message', frame({ type: 'connected', bridgeEpoch: 'run-2', resumed: true }));
		await Promise.resolve();
		// Uncertain persistence still forces an authoritative read instead of trusting the resume.
		expect(
			next.sent
				.map((data) => JSON.parse(data))
				.some((packet) => packet.channel === 'sessions:setMany')
		).toBe(false);
		expect((window as any).__MAESTRO_BRIDGE_STATE__).not.toBe('connected');
	});

	it('does not replay a banner an older build stored, and still replays its own', async () => {
		document.getElementById('maestro-submission-notice')?.remove();
		sessionStorage.setItem(
			'maestro:web-desktop:uncertain-submission',
			'Submission rejected for web:takeOrphanedAutoRuns: Channel "web:takeOrphanedAutoRuns" is not available over the web interface.'
		);
		vi.resetModules();
		await import('../../web-desktop/electron-shim');
		expect(document.getElementById('maestro-submission-notice')).toBeNull();

		sessionStorage.setItem(
			'maestro:web-desktop:uncertain-submission:v2',
			'Submission uncertainty: connection lost before acknowledgement of process:spawn.'
		);
		vi.resetModules();
		await import('../../web-desktop/electron-shim');
		expect(document.getElementById('maestro-submission-notice')?.textContent).toContain(
			'process:spawn'
		);
		document.getElementById('maestro-submission-notice')?.remove();
		sessionStorage.removeItem('maestro:web-desktop:uncertain-submission');
		sessionStorage.removeItem('maestro:web-desktop:uncertain-submission:v2');
	});

	it('rejects disconnected reads without claiming a submission was lost and without replaying them', async () => {
		document.getElementById('maestro-submission-notice')?.remove();
		sessionStorage.removeItem('maestro:web-desktop:uncertain-submission:v2');
		const socket = InertWebSocket.instances.at(-1)!;
		socket.readyState = InertWebSocket.OPEN;
		socket.emit('open');
		const query = ipcRenderer.invoke('sessions:getBootstrap');
		const queryRejected = expect(query).rejects.toThrow('bridge disconnected');
		await Promise.resolve();
		const next = reconnect(socket);
		await queryRejected;
		expect(document.getElementById('maestro-submission-notice')).toBeNull();
		expect(sessionStorage.getItem('maestro:web-desktop:uncertain-submission:v2')).toBeNull();
		await expect(ipcRenderer.invoke('plugins:contributions')).rejects.toThrow(/reconnect/i);
		expect(document.getElementById('maestro-submission-notice')).toBeNull();
		next.readyState = InertWebSocket.OPEN;
		next.emit('open');
		next.emit('message', frame({ type: 'connected', bridgeEpoch: 'run-2', resumed: true }));
		expect(
			next.sent.map((data) => JSON.parse(data)).some((packet) => packet.type === 'bridge.invoke')
		).toBe(false);
	});
	it('records disconnected diagnostics locally without rejection, replay, or a submission warning', async () => {
		document.getElementById('maestro-submission-notice')?.remove();
		sessionStorage.removeItem('maestro:web-desktop:uncertain-submission:v2');
		const socket = InertWebSocket.instances.at(-1)!;
		socket.readyState = InertWebSocket.OPEN;
		socket.emit('open');
		socket.emit('message', frame({ type: 'connected', bridgeEpoch: 'run-2', resumed: true }));
		const next = reconnect(socket);
		const localLog = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			await expect(
				ipcRenderer.invoke('logger:log', 'error', 'Disconnected diagnostic', 'OfflineSmoke')
			).resolves.toBeUndefined();
			expect(localLog.mock.calls.some((args) => args.includes('Disconnected diagnostic'))).toBe(
				true
			);
			expect(document.getElementById('maestro-submission-notice')).toBeNull();
			expect(sessionStorage.getItem('maestro:web-desktop:uncertain-submission:v2')).toBeNull();
			next.readyState = InertWebSocket.OPEN;
			next.emit('open');
			next.emit('message', frame({ type: 'connected', bridgeEpoch: 'run-2', resumed: true }));
			expect(
				next.sent.map((data) => JSON.parse(data)).some((packet) => packet.channel === 'logger:log')
			).toBe(false);
		} finally {
			localLog.mockRestore();
		}
	});
});

/**
 * Liveness.
 *
 * A suspended mobile socket does not reliably fire `close`: iOS freezes the
 * connection on app switch and screen lock, and the tab can come back with
 * `readyState === OPEN` on a socket whose peer is gone. Every invoke then parks
 * in `pending` forever - no resolve, no reject, no error - so the caller's
 * button silently does nothing. The heartbeat turns that into a `close`, which
 * is the one path that already rejects pending invokes and reconnects.
 */
describe('web-desktop electron-shim bridge heartbeat', () => {
	function liveSocket(): InertWebSocket {
		const ws = InertWebSocket.instances[InertWebSocket.instances.length - 1];
		ws.readyState = InertWebSocket.OPEN;
		ws.emit('open');
		return ws;
	}

	it('probes an open socket with the ping the server already answers', () => {
		const ws = liveSocket();
		const before = ws.sent.length;

		vi.advanceTimersByTime(BRIDGE_HEARTBEAT_INTERVAL_MS);

		const probes = ws.sent.slice(before).filter((f) => JSON.parse(f).type === 'ping');
		expect(probes).toHaveLength(1);
	});

	it('closes a socket that stops answering, so pending invokes are rejected', () => {
		const ws = liveSocket();
		const closesBefore = ws.closeCalls;

		vi.advanceTimersByTime(BRIDGE_HEARTBEAT_INTERVAL_MS);
		expect(ws.closeCalls).toBe(closesBefore);

		// No reply within the budget: whatever readyState claims, nothing is
		// listening on the far end.
		vi.advanceTimersByTime(BRIDGE_PONG_TIMEOUT_MS + 1);
		expect(ws.closeCalls).toBe(closesBefore + 1);
	});

	it('treats ANY inbound frame as proof of life, not just a pong', () => {
		// Making liveness depend on one message type would close a healthy socket
		// whenever a `pong` lost a race with a burst of transcript frames.
		const ws = liveSocket();
		const closesBefore = ws.closeCalls;

		vi.advanceTimersByTime(BRIDGE_HEARTBEAT_INTERVAL_MS);
		ws.emit('message', { data: JSON.stringify({ type: 'agent_output', text: 'hi' }) });
		vi.advanceTimersByTime(BRIDGE_PONG_TIMEOUT_MS + 1);

		expect(ws.closeCalls).toBe(closesBefore);
	});

	it('does not probe a socket that is not open', () => {
		const ws = liveSocket();
		ws.readyState = InertWebSocket.CONNECTING;
		const before = ws.sent.length;

		vi.advanceTimersByTime(BRIDGE_HEARTBEAT_INTERVAL_MS * 2);

		expect(ws.sent.slice(before).filter((f) => JSON.parse(f).type === 'ping')).toHaveLength(0);
	});

	it('reconciles a lost save acknowledgement even when retained events resume', async () => {
		const frame = (packet: Record<string, unknown>) => ({ data: JSON.stringify(packet) });
		const socket = InertWebSocket.instances.at(-1)!;
		socket.readyState = InertWebSocket.OPEN;
		socket.emit('open');
		socket.emit('message', frame({ type: 'connected', bridgeEpoch: 'run-2', resumed: true }));
		const save = ipcRenderer.invoke('sessions:setMany', [{ id: 'accepted-without-ack' }]);
		const uncertain = expect(save).rejects.toThrow('Submission uncertainty');
		await Promise.resolve();
		socket.emit('close');
		await vi.advanceTimersByTimeAsync(1000);
		await uncertain;
		const next = InertWebSocket.instances.at(-1)!;
		expect(next).not.toBe(socket);
		next.readyState = InertWebSocket.OPEN;
		next.emit('open');
		next.emit('message', frame({ type: 'connected', bridgeEpoch: 'run-2', resumed: true }));
		expect(window.location.reload).not.toHaveBeenCalled();
		await expect(
			ipcRenderer.invoke('sessions:setMany', [{ id: 'unsafe-overwrite' }])
		).rejects.toBeInstanceOf(Error);
		expect(
			next.sent
				.map((data) => JSON.parse(data))
				.filter((packet) => packet.channel === 'sessions:setMany')
		).toEqual([]);
		await vi.advanceTimersByTimeAsync(0);
		expect((window as any).__MAESTRO_BRIDGE_STATE__).toBe('connected');
	});
});

/**
 * Web-side stand-in for the `electron` module.
 *
 * Vite aliases `import ... from 'electron'` to this file when building the
 * web-desktop bundle. It re-exports two surfaces the renderer-side code uses:
 *
 *   • ipcRenderer - calls become WS bridge.invoke messages, events become
 *     bridge.event subscriptions. Uses the same channel naming as Electron so
 *     existing preload factories work unchanged.
 *
 *   • contextBridge - exposeInMainWorld writes directly to globalThis. This
 *     lets src/main/preload/index.ts execute in the browser and populate
 *     window.maestro with the same factory output the desktop gets.
 */

import { captureException } from './sentry-shim';
// Side-effect import: declares `window.__MAESTRO_CONFIG__` once for every
// bundle that reads it. See the note in that file about the two rival shapes
// this replaced.
import { WEB_BRIDGE_RECONCILE_EVENT } from '../shared/webClientConfig';

type Listener = (event: { senderFrame: null }, ...args: unknown[]) => void;

/**
 * How often the client probes the socket with the server's `ping` message.
 *
 * Slow enough to be free (one tiny frame per interval), fast enough that a
 * phone coming back from a lock screen recovers before the user has finished
 * deciding the app is broken.
 */
export const BRIDGE_HEARTBEAT_INTERVAL_MS = 15000;

/**
 * How long a `pong` may take before the socket is declared dead.
 *
 * Comfortably longer than any real round trip on a LAN or over Tailscale, and
 * short enough that the reconnect lands within a few seconds of the user
 * returning to the tab.
 */
export const BRIDGE_PONG_TIMEOUT_MS = 8000;

interface PendingInvoke {
	resolve: (value: unknown) => void;
	reject: (reason: unknown) => void;
}

interface BridgeConfig {
	wsUrl: string;
}

function getWsUrl(): string {
	const cfg = window.__MAESTRO_CONFIG__;
	if (cfg && typeof cfg.wsUrl === 'string') {
		const u = cfg.wsUrl;
		if (u.startsWith('ws://') || u.startsWith('wss://')) return u;
		// Server hands us "/<token>/ws" - turn it into an absolute URL.
		const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
		return `${proto}//${window.location.host}${u.startsWith('/') ? u : `/${u}`}`;
	}
	// Fallback: derive from current URL path /$TOKEN/desktop/...
	const parts = window.location.pathname.split('/').filter(Boolean);
	const token = parts[0] || '';
	const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
	return `${proto}//${window.location.host}/${token}/ws`;
}

class BridgeClient {
	private ws: WebSocket | null = null;
	private ready: Promise<void>;
	private resolveReady!: () => void;
	private pending = new Map<string | number, PendingInvoke>();
	private listeners = new Map<string, Set<Listener>>();
	// The server replays live Auto Runs as soon as the socket connects, before
	// React effects have necessarily subscribed. Retain only frames that have no
	// listener yet; the first subscriber drains the latest frame per session.
	private pendingAutoRunFrames = new Map<string, unknown>();
	private nextRequestId = 1;
	private queue: string[] = [];
	// True once any connection has been established, so a later open is known
	// to be a RE-connect. Mobile browsers suspend the socket on every app switch
	// and screen lock, which makes reconnecting the common case.
	private hadOpenConnection = false;
	// Resume bookkeeping. Every frame the server broadcasts carries a `seq`; on
	// reconnect the client reports the last one it saw and the server run it
	// came from. The server replays what was missed if it still has it, and
	// only when it cannot is the page reloaded - the bridge has no other way to
	// recover pushes it never received, and the renderer's in-memory state
	// (transcripts, busy pills, tabs) would otherwise stay stale for good.
	private lastSeq = 0;
	private epoch: string | undefined;
	private resumePending = false;
	// Liveness. A suspended mobile socket does NOT reliably fire `close`: iOS
	// freezes the connection on app switch and screen lock, and the tab can come
	// back with `readyState === OPEN` on a socket whose peer is long gone. Every
	// invoke then parks in `pending` forever - no resolve, no reject, no error -
	// so the caller's button silently does nothing. That is one root cause behind
	// every "I pressed it and nothing happened" report on the phone, not a
	// property of any one channel, so it is fixed HERE rather than per caller.
	//
	// The probe is the server's existing `ping` -> `pong`. A missed reply means
	// the socket is dead however healthy `readyState` claims to be, and closing
	// it routes recovery through the ONE path that already knows how to do it:
	// `close` rejects every pending invoke and schedules the resuming reconnect.
	private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
	private pongDeadline: ReturnType<typeof setTimeout> | undefined;

	constructor(config: BridgeConfig) {
		this.ready = new Promise((r) => (this.resolveReady = r));
		this.connect(config.wsUrl);
		document.addEventListener('visibilitychange', () => {
			if (!document.hidden) this.probeHeartbeat();
		});
		window.addEventListener('pageshow', () => this.probeHeartbeat());
		window.addEventListener('online', () => this.probeHeartbeat());
	}

	private resumeUrl(url: string): string {
		const u = new URL(url);
		u.searchParams.set('since', String(this.lastSeq));
		if (this.epoch) u.searchParams.set('epoch', this.epoch);
		return u.toString();
	}

	private markReady(): void {
		this.resolveReady();
		for (const frame of this.queue.splice(0)) this.ws?.send(frame);
		window.dispatchEvent(new Event(WEB_BRIDGE_RECONCILE_EVENT));
	}

	private connect(url: string): void {
		try {
			this.ws = new WebSocket(this.hadOpenConnection ? this.resumeUrl(url) : url);
		} catch (err) {
			// SyntaxError on a malformed URL or SECURITY_ERR from a blocked
			// port can throw synchronously. Without scheduling the same retry
			// the close path uses, this.ready would never resolve and every
			// subsequent invoke() would hang on `await this.ready`.
			console.error('[bridge] WebSocket construction failed - retrying in 1s', err);
			setTimeout(() => this.connect(url), 1000);
			return;
		}
		this.ws.addEventListener('open', () => {
			// Probe from the moment the socket is up, on a first connect and a
			// reconnect alike - a resumed socket can be suspended again a second
			// later, and it is the one the user is about to press a button on.
			this.startHeartbeat();
			if (this.hadOpenConnection) {
				// Reconnected after a drop. Whether we can carry on is decided by
				// the `connected` frame the server sends first (see below).
				this.resumePending = true;
				return;
			}
			this.hadOpenConnection = true;
			this.markReady();
		});
		this.ws.addEventListener('message', (ev: MessageEvent) => {
			// Bytes arrived, so the peer is alive - clear any probe deadline before
			// parsing. Deliberately ANY frame rather than only `pong`: a busy socket
			// streaming agent output is obviously healthy, and making liveness
			// depend on one message type would close a working connection whenever
			// a `pong` lost a race with a burst of transcript frames.
			this.notePong();
			let msg: { type?: string; [k: string]: unknown };
			try {
				msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
			} catch (err) {
				const raw = typeof ev.data === 'string' ? ev.data : String(ev.data);
				const preview = raw.length > 200 ? `${raw.slice(0, 200)}…` : raw;
				captureException(err, {
					extra: {
						component: 'BridgeClient',
						action: 'message.parse',
						preview,
					},
				});
				this.ws?.close(1003, 'invalid bridge frame');
				return;
			}
			if (typeof msg.seq === 'number') this.lastSeq = msg.seq;
			if (msg.type === 'connected') {
				if (typeof msg.bridgeEpoch === 'string') this.epoch = msg.bridgeEpoch;
				// A fresh connection's baseline is the server's counter at the moment
				// it accepted us: nothing broadcast before that is ours to replay.
				// On a resumed connection the replayed frames carry their own seq,
				// so lastSeq stays where the gap actually starts.
				if (msg.resumed !== true && typeof msg.bridgeSeq === 'number') {
					this.lastSeq = msg.bridgeSeq;
				}
				if (!this.resumePending) return;
				this.resumePending = false;
				if (msg.resumed === true) {
					// Every frame missed during the gap follows on this socket, so the
					// renderer converges as if the connection had never dropped.
					this.markReady();
					return;
				}
				// The server could not replay the gap (it restarted, or the gap
				// outran its buffer). The desktop's live store is the only source of
				// truth left, and reloading re-bootstraps from it.
				window.location.reload();
				return;
			}
			if (msg.type === 'bridge.response') {
				const requestId = msg.requestId as string | number;
				const pending = this.pending.get(requestId);
				if (!pending) return;
				this.pending.delete(requestId);
				if (msg.ok) pending.resolve(msg.result);
				else pending.reject(new Error(String(msg.error ?? 'bridge error')));
				return;
			}
			let channel: string | undefined;
			let args: unknown[] = [];
			if (msg.type === 'bridge.event') {
				channel = msg.channel as string;
				args = (msg.args as unknown[]) ?? [];
			} else if (
				msg.type === 'tabs_changed' &&
				typeof msg.sessionId === 'string' &&
				typeof msg.activeTabId === 'string'
			) {
				channel = 'remote:selectTab';
				args = [
					msg.sessionId,
					msg.activeTabId,
					Array.isArray(msg.aiTabs) ? msg.aiTabs : undefined,
					msg.activeTabChanged === true,
				];
			} else if (msg.type === 'autorun_state' && typeof msg.sessionId === 'string') {
				// Auto Run is renderer-owned in-memory state, so it never crosses the
				// bridge as a `bridge.event` the way `process:*` does - the owning
				// client hands it to main, which fans it out as this packet. Route it
				// into a channel so `useAutoRunStateMirror` can render the run. The
				// server also replays the current state for every active run when a
				// client connects (wsRoute), so a browser tab opened mid-run catches
				// up rather than waiting for the next progress tick.
				channel = 'remote:autoRunStateMirror';
				args = [msg.sessionId, msg.state ?? null];
			}
			if (channel) {
				const set = this.listeners.get(channel);
				if (!set || set.size === 0) {
					if (channel === 'remote:autoRunStateMirror') {
						this.pendingAutoRunFrames.set(args[0] as string, args[1]);
					}
					return;
				}
				const fakeEvent = { senderFrame: null };
				for (const cb of set) {
					this.notifyListener(channel, cb, fakeEvent, args);
				}
			}
		});
		this.ws.addEventListener('close', () => {
			console.warn('[bridge] WebSocket closed - reconnecting in 1s');
			// Stop probing a socket that is gone; `open` restarts it. Without this
			// the interval outlives every socket it was started for and a long
			// session accumulates one probe loop per reconnect.
			this.stopHeartbeat();
			// Reject every in-flight invoke. After reconnect the new server has
			// no memory of these request IDs, so the promises would otherwise
			// hang forever and freeze any React component awaiting them.
			const disconnected = new Error('bridge disconnected');
			for (const pending of this.pending.values()) pending.reject(disconnected);
			this.pending.clear();
			// Queued frames belong to a dead session - drop them so we don't
			// replay invokes the caller has already given up on.
			this.queue.length = 0;
			this.ready = new Promise((r) => (this.resolveReady = r));
			setTimeout(() => this.connect(url), 1000);
		});
		this.ws.addEventListener('error', (err: Event) => {
			console.error('[bridge] WebSocket error', err);
		});
	}

	private notifyListener(
		channel: string,
		listener: Listener,
		event: { senderFrame: null },
		args: unknown[]
	): void {
		try {
			listener(event, ...args);
		} catch (err) {
			console.error(`[bridge] listener for ${channel} threw`, err);
			captureException(err, {
				extra: {
					component: 'BridgeClient',
					action: 'listener',
					channel,
				},
			});
		}
	}

	/**
	 * Start probing the socket. Safe to call on every open - it clears any
	 * previous timers first, so a reconnect never leaves two heartbeats running.
	 */
	private startHeartbeat(): void {
		this.stopHeartbeat();
		this.heartbeatTimer = setInterval(() => this.probeHeartbeat(), BRIDGE_HEARTBEAT_INTERVAL_MS);
	}

	private probeHeartbeat(): void {
		// Only probe a socket that CLAIMS to be open; anything else is already
		// being handled by the close/reconnect path.
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
		// A probe already in flight: let its deadline settle rather than
		// stacking a second one and shortening the budget.
		if (this.pongDeadline !== undefined) return;
		this.pongDeadline = setTimeout(() => {
			this.pongDeadline = undefined;
			// No `pong`. Whatever `readyState` says, nothing is listening. Close
			// so the existing handler rejects the pending invokes and reconnects;
			// closing a socket that is genuinely dead is a no-op beyond that.
			try {
				this.ws?.close();
			} catch {
				// A socket in a bad state can throw here. The reconnect is already
				// scheduled by the close handler, or by the next heartbeat tick.
			}
		}, BRIDGE_PONG_TIMEOUT_MS);
		try {
			this.ws.send(JSON.stringify({ type: 'ping' }));
		} catch {
			// Send threw: the socket is dead now rather than in 8s. Let the
			// deadline above fire and take the same recovery path.
		}
	}

	private stopHeartbeat(): void {
		if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer);
		this.heartbeatTimer = undefined;
		this.notePong();
	}

	/** Any frame from the server proves the socket is alive, not just a `pong`. */
	private notePong(): void {
		if (this.pongDeadline !== undefined) clearTimeout(this.pongDeadline);
		this.pongDeadline = undefined;
	}

	private sendFrame(frame: object): void {
		const json = JSON.stringify(frame);
		if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(json);
		else this.queue.push(json);
	}

	async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
		await this.ready;
		const requestId = this.nextRequestId++;
		return new Promise((resolve, reject) => {
			this.pending.set(requestId, { resolve, reject });
			this.sendFrame({ type: 'bridge.invoke', requestId, channel, args });
		});
	}

	on(channel: string, listener: Listener): void {
		let set = this.listeners.get(channel);
		if (!set) {
			set = new Set();
			this.listeners.set(channel, set);
		}
		set.add(listener);
		if (channel === 'remote:autoRunStateMirror' && this.pendingAutoRunFrames.size > 0) {
			const fakeEvent = { senderFrame: null };
			for (const [sessionId, state] of this.pendingAutoRunFrames) {
				// `once()` unregisters its wrapper during the first callback. Honor
				// that removal instead of invoking the stale wrapper for every
				// buffered session, and preserve frames it did not consume.
				if (!set.has(listener)) break;
				this.pendingAutoRunFrames.delete(sessionId);
				this.notifyListener(channel, listener, fakeEvent, [sessionId, state]);
			}
		}
	}

	off(channel: string, listener: Listener): void {
		this.listeners.get(channel)?.delete(listener);
	}

	removeAllListeners(channel?: string): void {
		if (typeof channel === 'string') this.listeners.delete(channel);
		else this.listeners.clear();
	}

	once(channel: string, listener: Listener): void {
		const wrapped: Listener = (event, ...args) => {
			this.off(channel, wrapped);
			listener(event, ...args);
		};
		this.on(channel, wrapped);
	}
}

const bridge = new BridgeClient({ wsUrl: getWsUrl() });

export const ipcRenderer = {
	invoke: (channel: string, ...args: unknown[]) => bridge.invoke(channel, ...args),
	send: (channel: string, ...args: unknown[]) => {
		// ipcRenderer.send is fire-and-forget by contract, but on the WS bridge
		// we still get a rejection if the channel is unknown or the server-side
		// handler throws. Log it so the failure is debuggable - don't rethrow,
		// callers don't expect a Promise here.
		void bridge.invoke(channel, ...args).catch((err) => {
			console.error(`[bridge] send(${channel}) failed`, err);
		});
	},
	on: (channel: string, listener: Listener) => {
		bridge.on(channel, listener);
		return ipcRenderer;
	},
	off: (channel: string, listener: Listener) => {
		bridge.off(channel, listener);
		return ipcRenderer;
	},
	once: (channel: string, listener: Listener) => {
		bridge.once(channel, listener);
		return ipcRenderer;
	},
	removeListener: (channel: string, listener: Listener) => {
		bridge.off(channel, listener);
		return ipcRenderer;
	},
	removeAllListeners: (channel?: string) => {
		bridge.removeAllListeners(channel);
		return ipcRenderer;
	},
	// Synchronous IPC can't be tunneled over a WebSocket; failing loudly here
	// is safer than returning undefined and letting callers miscompute on a
	// silent null. Real desktop code paths only use invoke/send/on.
	sendSync: () => {
		throw new Error(
			'ipcRenderer.sendSync is not supported in the web-desktop bridge - use invoke() instead'
		);
	},
	// Intentional no-ops: postMessage (MessagePort transfer), sendTo and
	// sendToHost (cross-window/host IPC) have no callers in this codebase and
	// no meaningful translation to the WS bridge. Kept for API parity so
	// duck-typed renderer code that probes for these methods doesn't crash.
	postMessage: () => {},
	sendTo: () => {},
	sendToHost: () => {},
};

export const contextBridge = {
	exposeInMainWorld(apiKey: string, api: unknown): void {
		(globalThis as Record<string, unknown>)[apiKey] = api;
	},
};

export const shell = {
	openExternal: async (url: string) => {
		window.open(url, '_blank', 'noopener,noreferrer');
	},
};

// Browser zoom. In Electron, webFrame scales the WebFrame's contents; here we
// emulate it by scaling the whole document via the CSS `zoom` property, which
// Chromium (the web-desktop target) honors. The factor <-> level relation
// mirrors Electron's: each level step is 20% larger/smaller, so
// factor = 1.2 ** level and level = log(factor) / log(1.2).
let zoomFactor = 1;

function applyZoomFactor(factor: number): void {
	zoomFactor = factor;
	if (typeof document !== 'undefined') {
		document.documentElement.style.zoom = String(factor);
	}
}

export const webFrame = {
	setZoomFactor: (factor: number): void => {
		applyZoomFactor(factor);
	},
	getZoomFactor: (): number => zoomFactor,
	setZoomLevel: (level: number): void => {
		applyZoomFactor(1.2 ** level);
	},
	getZoomLevel: (): number => Math.log(zoomFactor) / Math.log(1.2),
};

export const webUtils = {
	getPathForFile: (file: File): string => {
		const maybePath = (file as File & { path?: unknown }).path;
		return typeof maybePath === 'string' ? maybePath : '';
	},
};

export default { ipcRenderer, contextBridge, shell, webFrame, webUtils };

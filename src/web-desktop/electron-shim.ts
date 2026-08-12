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

type Listener = (event: { senderFrame: null }, ...args: unknown[]) => void;

interface PendingInvoke {
	resolve: (value: unknown) => void;
	reject: (reason: unknown) => void;
}

interface BridgeConfig {
	wsUrl: string;
}

declare global {
	interface Window {
		__MAESTRO_CONFIG__?: { wsUrl: string; apiBase: string; securityToken: string };
	}
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
	private nextRequestId = 1;
	private queue: string[] = [];
	// True once any connection has been established. A LATER successful open is
	// a RE-connect: every push event during the gap is gone for good (the
	// bridge has no replay), so the renderer's in-memory state - transcripts,
	// busy pills, tabs - is stale beyond repair. Mobile Safari makes this the
	// common case: it suspends the socket on every app switch / screen lock.
	private hadOpenConnection = false;

	constructor(config: BridgeConfig) {
		this.ready = new Promise((r) => (this.resolveReady = r));
		this.connect(config.wsUrl);
	}

	private connect(url: string): void {
		try {
			this.ws = new WebSocket(url);
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
			if (this.hadOpenConnection) {
				// Reconnected after a drop: resync by reloading the page. The app
				// re-bootstraps from the desktop's live store, which is the only
				// source of truth for whatever happened while we were away.
				window.location.reload();
				return;
			}
			this.hadOpenConnection = true;
			this.resolveReady();
			for (const frame of this.queue.splice(0)) this.ws?.send(frame);
		});
		this.ws.addEventListener('message', (ev: MessageEvent) => {
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
			if (msg.type === 'bridge.response') {
				const requestId = msg.requestId as string | number;
				const pending = this.pending.get(requestId);
				if (!pending) return;
				this.pending.delete(requestId);
				if (msg.ok) pending.resolve(msg.result);
				else pending.reject(new Error(String(msg.error ?? 'bridge error')));
				return;
			}
			if (msg.type === 'bridge.event') {
				const channel = msg.channel as string;
				const args = (msg.args as unknown[]) ?? [];
				const set = this.listeners.get(channel);
				if (!set) return;
				const fakeEvent = { senderFrame: null };
				for (const cb of set) {
					try {
						cb(fakeEvent, ...args);
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
			}
		});
		this.ws.addEventListener('close', () => {
			console.warn('[bridge] WebSocket closed - reconnecting in 1s');
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

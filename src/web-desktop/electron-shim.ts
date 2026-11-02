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
import {
	BridgeTransportError,
	isExpectedBridgeError,
	isUnsupportedInvokeError,
	WEB_BRIDGE_STATE_EVENT,
} from '../shared/bridgeError';
// Also a side-effect import: the module declares `window.__MAESTRO_CONFIG__`
// once for every bundle that reads it. See the note in that file about the two
// rival shapes this replaced.
import {
	WEB_BRIDGE_RECONCILE_EVENT,
	type WebBridgeReconcileDetail,
} from '../shared/webClientConfig';
import { WEB_LOGIN_PATHS, WEB_LOGIN_WS_CLOSE_CODE } from '../shared/webLogin';
import { selectHostFolder, selectHostSaveFile } from './remote-file-dialog';
import {
	readClientViewState,
	writeClientViewState,
} from '../renderer/utils/activeSessionPersistence';

// v2: earlier builds stored alerts for refused channels and lost autosaves,
// which this build no longer raises. A phone tab still holding one would show
// it again on every reload until dismissed, so the old key is not read.
const UNCERTAIN_SUBMISSION_KEY = 'maestro:web-desktop:uncertain-submission:v2';

// IPC queries follow the preload getter/list/read naming convention. The
// non-prefixed query methods below are explicit exceptions, not error filters.
const READ_ONLY_CHANNELS = new Set([
	'plugins:contributions',
	'agentRun:events',
	'agentRun:show',
	'campaign:show',
	'attachments:load',
	'fs:directoryInfo',
	'fs:directorySize',
	'fs:homeDir',
	'fs:stat',
	'fs:fetchImageAsBase64',
	'git:branch',
	'git:branches',
	'git:commitCount',
	'git:diff',
	'git:graph',
	'git:info',
	'git:log',
	'git:numstat',
	'git:remote',
	'git:scanWorktreeDirectory',
	'git:show',
	'git:showFile',
	'git:status',
	'git:tags',
	'git:worktreeInfo',
	'groupChat:load',
	'history:reload',
	'images:resolve',
	'journey:path',
	'memory:orphans',
	'pianola:supervisor-list',
	'feedback:drafts:list',
	'feedback:gh-login-command',
	'feedback:issues:list',
	'feedback:search-issues',
	'parquet:open',
	'ssh-remote:test',
	'cue:validateYaml',
	'cue:loadPipelineLayout',
	'dataview:status',
]);

function isSubmissionChannel(channel: string): boolean {
	// Diagnostics are not user work and must never create submission alerts.
	// Nor is the User Journey log, which records in the background on every
	// file open and page load.
	if (channel === 'logger:log' || channel === 'journey:append') return false;
	const operation = channel.slice(channel.indexOf(':') + 1);
	return (
		!READ_ONLY_CHANNELS.has(channel) &&
		!/^(?:get|list|read|has|is|detect|discover|search|check|count|inspect|query)(?:$|[A-Z:-])/.test(
			operation
		)
	);
}
function showSubmissionNotice(message: string): void {
	writeClientViewState(UNCERTAIN_SUBMISSION_KEY, message);
	const render = () => {
		let notice = document.getElementById('maestro-submission-notice');
		if (!notice) {
			notice = document.createElement('div');
			notice.id = 'maestro-submission-notice';
			notice.setAttribute('role', 'alert');
			notice.style.cssText =
				'position:fixed;bottom:12px;left:12px;right:12px;z-index:100000;background:#713f12;color:white;padding:12px;border:1px solid #facc15;border-radius:6px';
			document.body.appendChild(notice);
		}
		notice.replaceChildren(document.createTextNode(message + ' '));
		const dismiss = document.createElement('button');
		dismiss.textContent = 'Dismiss';
		dismiss.onclick = () => {
			writeClientViewState(UNCERTAIN_SUBMISSION_KEY, '');
			notice?.remove();
		};
		notice.appendChild(dismiss);
	};
	if (document.body) render();
	else document.addEventListener('DOMContentLoaded', render, { once: true });
}

function setConnectionState(
	state: 'connecting' | 'connected' | 'reconnecting' | 'disconnected'
): void {
	if ((window as unknown as Record<string, unknown>).__MAESTRO_BRIDGE_STATE__ === state) return;
	(window as unknown as Record<string, unknown>).__MAESTRO_BRIDGE_STATE__ = state;
	window.dispatchEvent(new CustomEvent(WEB_BRIDGE_STATE_EVENT, { detail: { state } }));
}

type Listener = (event: { senderFrame: null }, ...args: unknown[]) => unknown;

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
export const BRIDGE_CONNECT_TIMEOUT_MS = 10000;
export const BRIDGE_RECOVERY_TIMEOUT_MS = 30000;

const BRIDGE_RECONNECT_BASE_MS = 1000;
const BRIDGE_RECONNECT_MAX_MS = 30000;
const BRIDGE_READ_TIMEOUT_MS = 30_000;
const BRIDGE_MUTATION_TIMEOUT_MS = 120_000;
function isPersistenceChannel(channel: string): boolean {
	return (
		channel === 'sessions:setMany' || channel === 'sessions:setAll' || channel === 'groups:setAll'
	);
}
/**
 * Whether a lost acknowledgement needs the user's attention. Autosaves do not:
 * the bridge marks persistence uncertain and restores host state on reconnect,
 * and the user never submitted them. A phone suspends the socket on every lock
 * and app switch, so alerting on them put the banner up constantly.
 */
function alertsOnUncertainty(channel: string): boolean {
	return isSubmissionChannel(channel) && !isPersistenceChannel(channel);
}
function requestTimeoutMs(channel: string): number {
	// Repository transfers and recursive filesystem reads legitimately outlast ordinary UI requests.
	if (channel.startsWith('git:') || channel === 'fs:directorySize') return 600_000;
	return isSubmissionChannel(channel) ? BRIDGE_MUTATION_TIMEOUT_MS : BRIDGE_READ_TIMEOUT_MS;
}

interface PendingInvoke {
	resolve: (value: unknown) => void;
	reject: (reason: unknown) => void;
	channel: string;
	timer: ReturnType<typeof setTimeout>;
	recoveryController?: AbortController;
}

interface BridgeConfig {
	wsUrl: string;
}

/**
 * The path token this page was served under.
 *
 * Read live rather than captured at module load: the config object is injected
 * by the server just above the bundle's own script, but the fallback has to
 * work for a page loaded without it (dev, a file:// load), and `pathname`'s
 * first segment IS the token for every URL the server serves.
 */
function currentToken(): string {
	const fromConfig = window.__MAESTRO_CONFIG__?.securityToken;
	if (typeof fromConfig === 'string' && fromConfig) return fromConfig;
	const parts = String(window.location?.pathname ?? '')
		.split('/')
		.filter(Boolean);
	return parts[0] ?? '';
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
	private connected = false;
	private uncertainPersistence = false;
	private invalidState = false;
	private recoveryController: AbortController | undefined;
	private recoveryTimer: ReturnType<typeof setTimeout> | undefined;
	private recoveryEvents: Array<{ channel: string; args: unknown[] }> = [];
	private recoveryEventBytes = 0;
	private recoveryWarnings = new Map<string, number>();
	// True once any connection has been established, so a later open is known
	// to be a RE-connect. Mobile browsers suspend the socket on every app switch
	// and screen lock, which makes reconnecting the common case.
	private hadOpenConnection = false;
	// Resume bookkeeping. Every frame the server broadcasts carries a `seq`; on
	// reconnect the client reports the last one it saw and the server run it
	// came from. A missing replay requires in-place authoritative reconciliation.
	private lastSeq = 0;
	private epoch: string | undefined;
	private resumePending = false;
	// Heartbeats detect dead peers, but renderer suspension is not a peer failure.
	private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
	private pongDeadline: ReturnType<typeof setTimeout> | undefined;
	private connectDeadline: ReturnType<typeof setTimeout> | undefined;
	private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	private reconnectAttempt = 0;
	private terminalDisconnect = false;
	constructor(private readonly config: BridgeConfig) {
		this.ready = new Promise((r) => (this.resolveReady = r));
		setConnectionState('connecting');
		try {
			const notice = readClientViewState(UNCERTAIN_SUBMISSION_KEY);
			if (notice) showSubmissionNotice(notice);
		} catch {
			/* Storage may be disabled. */
		}
		this.connect(config.wsUrl);
		document.addEventListener('visibilitychange', () => {
			if (!document.hidden) this.recoverConnection();
		});
		window.addEventListener('pageshow', () => this.recoverConnection());
		window.addEventListener('online', () => this.recoverConnection());
	}

	private recoverConnection(): void {
		if (this.terminalDisconnect) return;
		const socket = this.ws;
		if (socket?.readyState === WebSocket.OPEN) {
			this.probeHeartbeat();
			return;
		}
		if (socket?.readyState === WebSocket.CONNECTING) {
			this.disconnect(socket, 4000);
			try {
				socket.close(4000, 'connection superseded');
			} catch {
				/* Already retired locally. */
			}
			return;
		}
		if (socket) return;
		this.scheduleReconnect(true);
	}

	private scheduleReconnect(immediate = false): void {
		if (this.terminalDisconnect) return;
		clearTimeout(this.reconnectTimer);
		const ceiling = Math.min(
			BRIDGE_RECONNECT_MAX_MS,
			BRIDGE_RECONNECT_BASE_MS * 2 ** this.reconnectAttempt
		);
		const delay = immediate ? 0 : Math.max(250, Math.floor(Math.random() * (ceiling + 1)));
		if (!immediate) this.reconnectAttempt++;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = undefined;
			this.connect(this.config.wsUrl);
		}, delay);
	}

	private resumeUrl(url: string): string {
		const u = new URL(url);
		u.searchParams.set('since', String(this.lastSeq));
		if (this.epoch) u.searchParams.set('epoch', this.epoch);
		return u.toString();
	}

	private markReady(reconciled = false): void {
		this.invalidState = false;
		this.uncertainPersistence = false;
		this.connected = true;
		this.reconnectAttempt = 0;
		this.recoveryWarnings.clear();
		setConnectionState('connected');
		this.resolveReady();
		if (!reconciled) window.dispatchEvent(new Event(WEB_BRIDGE_RECONCILE_EVENT));
	}

	private connect(url: string): void {
		let socket: WebSocket;
		try {
			socket = new WebSocket(this.hadOpenConnection ? this.resumeUrl(url) : url);
			this.ws = socket;
		} catch (error) {
			console.error('[bridge] WebSocket construction failed - scheduling recovery', error);
			this.scheduleReconnect();
			return;
		}
		clearTimeout(this.connectDeadline);
		this.connectDeadline = setTimeout(() => {
			if (this.ws !== socket || socket.readyState !== WebSocket.CONNECTING) return;
			console.warn('[bridge] WebSocket connection timed out');
			this.disconnect(socket, 4000);
			try {
				socket.close(4000, 'connection timed out');
			} catch {
				/* Already retired locally. */
			}
		}, BRIDGE_CONNECT_TIMEOUT_MS);
		socket.addEventListener('open', () => {
			if (this.ws !== socket) return;
			clearTimeout(this.connectDeadline);
			this.connectDeadline = undefined;
			this.startHeartbeat();
			if (this.hadOpenConnection) {
				this.resumePending = true;
				return;
			}
			this.hadOpenConnection = true;
			this.markReady();
		});
		socket.addEventListener('message', (ev: MessageEvent) => {
			if (this.ws !== socket) return;
			this.notePong();
			let msg: { type?: string; [key: string]: unknown };
			try {
				msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
			} catch (error) {
				captureException(error, { extra: { component: 'BridgeClient', action: 'message.parse' } });
				this.disconnect(socket, 1003);
				socket.close(1003, 'invalid bridge frame');
				return;
			}
			if (typeof msg.seq === 'number') {
				if (msg.seq <= this.lastSeq) return;
				this.lastSeq = msg.seq;
			}
			if (msg.type === 'connected') {
				if (typeof msg.bridgeEpoch === 'string') this.epoch = msg.bridgeEpoch;
				if (msg.resumed !== true && typeof msg.bridgeSeq === 'number') this.lastSeq = msg.bridgeSeq;
				if (!this.resumePending) return;
				this.resumePending = false;
				if (msg.resumed === true && !this.uncertainPersistence && !this.invalidState) {
					this.markReady();
				} else {
					this.invalidState = true;
					this.recoverState();
				}
				return;
			}
			if (msg.type === 'bridge.response') {
				const requestId = msg.requestId as string | number;
				const pending = this.pending.get(requestId);
				if (!pending) return;
				this.pending.delete(requestId);
				clearTimeout(pending.timer);
				if (msg.ok) pending.resolve(msg.result);
				else {
					const error = String(msg.error ?? 'bridge error');
					// A channel this interface does not offer never ran on the host. The
					// caller gets the rejection; there is no submission to warn about.
					if (isSubmissionChannel(pending.channel) && !isUnsupportedInvokeError(error))
						showSubmissionNotice(
							'Submission rejected for ' +
								pending.channel +
								': ' +
								error +
								'. It was not automatically retried.'
						);
					pending.reject(new Error(error));
				}
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
				// Inventory is shared, navigation is client-local.
				channel = 'remote:selectTab';
				args = [msg.sessionId, msg.activeTabId, Array.isArray(msg.aiTabs) ? msg.aiTabs : undefined];
			} else if (msg.type === 'autorun_state' && typeof msg.sessionId === 'string') {
				channel = 'remote:autoRunStateMirror';
				args = [msg.sessionId, msg.state ?? null];
			}
			if (!channel) return;
			if (this.invalidState) {
				// Snapshot first, then events that arrived while it was being read.
				this.recoveryEventBytes += String(ev.data).length * 2;
				if (this.recoveryEventBytes > 8 * 1024 * 1024) {
					this.invalidateState('recovery event backlog exceeded');
					return;
				}
				this.recoveryEvents.push({ channel, args });
				return;
			}
			this.dispatchEvent(channel, args);
		});
		socket.addEventListener('close', (event: CloseEvent) => this.disconnect(socket, event?.code));
		socket.addEventListener('error', () => {
			if (this.ws === socket) console.warn('[bridge] WebSocket transport error');
		});
	}

	private rejectPending(reason: string): void {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			const submission = isSubmissionChannel(pending.channel);
			const message = submission
				? 'Submission uncertainty: ' +
					reason +
					' before acknowledgement of ' +
					pending.channel +
					'. The host may have accepted it. Check host state before submitting again; it was not automatically retried.'
				: reason + ' before response to ' + pending.channel;
			if (alertsOnUncertainty(pending.channel)) showSubmissionNotice(message);
			if (isPersistenceChannel(pending.channel)) this.uncertainPersistence = true;
			pending.reject(
				new BridgeTransportError(
					'bridge disconnected: ' + message,
					submission ? 'BRIDGE_SUBMISSION_UNCERTAIN' : 'BRIDGE_DISCONNECTED',
					submission ? 'unknown' : 'read-only',
					pending.channel
				)
			);
		}
		this.pending.clear();
	}

	private disconnect(socket: WebSocket, code?: number): void {
		if (this.ws !== socket) return;
		// Retire locally. A dead peer can leave close() hanging for many seconds;
		// neither that handshake nor late events may hold the next socket hostage.
		this.ws = null;
		this.connected = false;
		this.resumePending = false;
		this.recoveryController?.abort();
		this.recoveryController = undefined;
		this.recoveryEvents = [];
		this.recoveryEventBytes = 0;
		clearTimeout(this.recoveryTimer);
		clearTimeout(this.connectDeadline);
		this.connectDeadline = undefined;
		this.stopHeartbeat();
		this.rejectPending('connection lost');
		if (this.hadOpenConnection)
			this.ready = new Promise((resolve) => (this.resolveReady = resolve));
		if (code === WEB_LOGIN_WS_CLOSE_CODE) {
			this.terminalDisconnect = true;
			setConnectionState('disconnected');
			window.location.href = '/' + currentToken() + '/' + WEB_LOGIN_PATHS.page;
			return;
		}
		if (code === 4403 || code === 1008) {
			this.terminalDisconnect = true;
			setConnectionState('disconnected');
			return;
		}
		setConnectionState('reconnecting');
		console.warn('[bridge] WebSocket closed (code ' + (code ?? 'unavailable') + ')');
		this.scheduleReconnect();
	}

	private dispatchEvent(channel: string, args: unknown[]): Promise<void> {
		const listeners = this.listeners.get(channel);
		if (!listeners?.size) {
			if (channel === 'remote:autoRunStateMirror')
				this.pendingAutoRunFrames.set(args[0] as string, args[1]);
			return Promise.resolve();
		}
		const work: Promise<unknown>[] = [];
		const socket = this.ws;
		for (const listener of listeners) {
			try {
				const result = listener({ senderFrame: null }, ...args);
				if (result && typeof (result as PromiseLike<unknown>).then === 'function')
					work.push(Promise.resolve(result));
			} catch (error) {
				if (this.ws === socket) this.listenerFailed(channel, error);
				return Promise.resolve();
			}
		}
		return Promise.all(work).then(
			() => {},
			(error) => {
				if (this.ws === socket) this.listenerFailed(channel, error);
			}
		);
	}

	private recoverState(): void {
		if (
			!this.invalidState ||
			this.recoveryController ||
			!this.ws ||
			this.ws.readyState !== WebSocket.OPEN ||
			this.resumePending
		)
			return;
		this.connected = false;
		setConnectionState('reconnecting');
		clearTimeout(this.recoveryTimer);
		this.recoveryEvents = [];
		this.recoveryEventBytes = 0;
		const controller = new AbortController();
		const socket = this.ws;
		this.recoveryController = controller;
		const work: Promise<void>[] = [];
		window.dispatchEvent(
			new CustomEvent<WebBridgeReconcileDetail>(WEB_BRIDGE_RECONCILE_EVENT, {
				detail: {
					authoritative: true,
					signal: controller.signal,
					waitUntil: (promise) => work.push(promise),
				},
			})
		);
		const deadline = setTimeout(() => controller.abort(), BRIDGE_RECOVERY_TIMEOUT_MS);
		const interrupted = Promise.withResolvers<void>();
		controller.signal.addEventListener(
			'abort',
			() =>
				interrupted.reject(
					new BridgeTransportError(
						'Host state restoration timed out',
						'BRIDGE_RECOVERY_PENDING',
						'read-only'
					)
				),
			{ once: true }
		);
		void (async () => {
			let recovered = false;
			try {
				// Observe cancellation even when no participant has mounted yet:
				// cleanup aborts this attempt and must not create an unhandled rejection.
				await Promise.race([
					work.length
						? Promise.all(work)
						: Promise.reject(
								new BridgeTransportError(
									'Host state restoration is not mounted yet',
									'BRIDGE_RECOVERY_PENDING',
									'read-only'
								)
							),
					interrupted.promise,
				]);
				while (!controller.signal.aborted && this.recoveryEvents.length) {
					const event = this.recoveryEvents.shift()!;
					await Promise.race([this.dispatchEvent(event.channel, event.args), interrupted.promise]);
				}
				if (
					!controller.signal.aborted &&
					this.ws === socket &&
					this.recoveryController === controller
				) {
					this.recoveryEventBytes = 0;
					this.markReady(true);
					recovered = true;
				}
			} catch (error) {
				if (this.ws === socket && this.recoveryController === controller) {
					const key = error instanceof Error ? error.message : String(error);
					const previous = this.recoveryWarnings.get(key);
					if (previous === undefined || Date.now() - previous >= 30_000) {
						if (this.recoveryWarnings.size >= 20) this.recoveryWarnings.clear();
						this.recoveryWarnings.set(key, Date.now());
						console.warn(
							'[bridge] In-place host recovery failed; retrying',
							isExpectedBridgeError(error) ? key : error
						);
					}
				}
			} finally {
				clearTimeout(deadline);
				if (!recovered) controller.abort();
				// Reads from an abandoned attempt must not outlive its budget or be
				// mistaken for the next snapshot when their late replies arrive.
				for (const [requestId, pending] of this.pending) {
					if (recovered || pending.recoveryController !== controller) continue;
					this.pending.delete(requestId);
					clearTimeout(pending.timer);
					pending.reject(
						new BridgeTransportError(
							'Host state restoration attempt ended',
							'BRIDGE_RECOVERY_PENDING',
							'read-only',
							pending.channel
						)
					);
				}
				const current = this.recoveryController === controller;
				if (current) this.recoveryController = undefined;
				if (
					current &&
					this.invalidState &&
					this.ws === socket &&
					socket.readyState === WebSocket.OPEN
				) {
					const ceiling = Math.min(
						BRIDGE_RECONNECT_MAX_MS,
						BRIDGE_RECONNECT_BASE_MS * 2 ** this.reconnectAttempt
					);
					this.reconnectAttempt++;
					this.recoveryTimer = setTimeout(
						() => this.recoverState(),
						BRIDGE_RECONNECT_BASE_MS +
							Math.floor(Math.random() * (ceiling - BRIDGE_RECONNECT_BASE_MS + 1))
					);
				}
			}
		})();
	}
	private notifyListener(
		channel: string,
		listener: Listener,
		event: { senderFrame: null },
		args: unknown[]
	): void {
		if (this.invalidState) return;
		const socket = this.ws;
		try {
			const result = listener(event, ...args);
			if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
				void Promise.resolve(result).catch((error) => {
					if (this.ws === socket) this.listenerFailed(channel, error);
				});
			}
		} catch (error) {
			if (this.ws === socket) this.listenerFailed(channel, error);
		}
	}

	private listenerFailed(channel: string, error: unknown): void {
		this.invalidateState('failed to apply host event ' + channel);
		if (isExpectedBridgeError(error)) return;
		console.error(`[bridge] listener for ${channel} failed`, error);
		captureException(error, { extra: { component: 'BridgeClient', action: 'listener', channel } });
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
		const socket = this.ws;
		if (!socket || socket.readyState !== WebSocket.OPEN || this.pongDeadline !== undefined) return;
		const started = Date.now();
		this.pongDeadline = setTimeout(() => {
			this.pongDeadline = undefined;
			if (this.ws !== socket) return;
			// A suspended/blocked renderer has not been observing the peer. Give a
			// fresh probe its full deadline instead of closing before queued pongs run.
			const elapsed = Date.now() - started;
			if (elapsed < 0 || elapsed > BRIDGE_PONG_TIMEOUT_MS + 1000) {
				this.probeHeartbeat();
				return;
			}
			console.warn('[bridge] Heartbeat deadline expired');
			this.disconnect(socket, 4000);
			try {
				socket.close(4000, 'heartbeat deadline expired');
			} catch {
				/* Already retired locally. */
			}
		}, BRIDGE_PONG_TIMEOUT_MS);
		try {
			socket.send(JSON.stringify({ type: 'ping' }));
		} catch {
			/* Deadline retires the socket. */
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

	private invalidateState(reason: string): void {
		this.invalidState = true;
		this.connected = false;
		this.recoveryController?.abort();
		this.recoveryEvents = [];
		this.recoveryEventBytes = 0;
		this.rejectPending(reason);
		setConnectionState('reconnecting');
		this.recoverState();
	}

	async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
		const submission = isSubmissionChannel(channel);
		if (submission && this.invalidState) {
			throw new BridgeTransportError(
				'Not submitted: restoring authoritative host state. Your current work is retained.',
				'BRIDGE_RESTORING',
				'not-sent',
				channel
			);
		}
		if (
			this.hadOpenConnection &&
			(!this.ws ||
				this.ws.readyState !== WebSocket.OPEN ||
				this.resumePending ||
				(!this.connected && !this.invalidState))
		) {
			throw new BridgeTransportError(
				'Not submitted: reconnecting to the host. Your current work is retained.',
				'BRIDGE_RECONNECTING',
				'not-sent',
				channel
			);
		}
		if (!this.connected && !this.invalidState) {
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(
					() =>
						reject(
							new BridgeTransportError(
								'Bridge connection timed out; request was not submitted',
								'BRIDGE_TIMEOUT',
								'not-sent',
								channel
							)
						),
					BRIDGE_READ_TIMEOUT_MS
				);
				this.ready.then(() => {
					clearTimeout(timer);
					resolve();
				});
			});
		}
		if (
			(isSubmissionChannel(channel) && !this.connected) ||
			!this.ws ||
			this.ws.readyState !== WebSocket.OPEN ||
			this.resumePending
		) {
			throw new BridgeTransportError(
				'bridge disconnected: request was not submitted',
				'BRIDGE_DISCONNECTED',
				'not-sent',
				channel
			);
		}
		const requestId = this.nextRequestId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				if (!this.pending.delete(requestId)) return;
				const submission = isSubmissionChannel(channel);
				const message = submission
					? 'Submission uncertainty: ' +
						channel +
						' timed out before acknowledgement. Check host state before submitting again; it was not automatically retried.'
					: 'Bridge request timed out: ' + channel;
				if (alertsOnUncertainty(channel)) showSubmissionNotice(message);
				reject(
					new BridgeTransportError(
						message,
						submission ? 'BRIDGE_SUBMISSION_UNCERTAIN' : 'BRIDGE_TIMEOUT',
						submission ? 'unknown' : 'read-only',
						channel
					)
				);
				if (isPersistenceChannel(channel)) {
					this.uncertainPersistence = true;
					this.invalidateState('persistence acknowledgement timed out');
				}
			}, requestTimeoutMs(channel));
			this.pending.set(requestId, {
				resolve,
				reject,
				channel,
				timer,
				recoveryController: this.invalidState ? this.recoveryController : undefined,
			});
			try {
				this.ws!.send(JSON.stringify({ type: 'bridge.invoke', requestId, channel, args }));
			} catch (error) {
				this.pending.delete(requestId);
				clearTimeout(timer);
				if (alertsOnUncertainty(channel))
					showSubmissionNotice(
						'Submission uncertainty: transport failed while sending ' +
							channel +
							'. Check host state before submitting again.'
					);
				if (isPersistenceChannel(channel)) this.uncertainPersistence = true;
				reject(
					new BridgeTransportError(
						error instanceof Error ? error.message : String(error),
						submission ? 'BRIDGE_SUBMISSION_UNCERTAIN' : 'BRIDGE_DISCONNECTED',
						submission ? 'unknown' : 'not-sent',
						channel
					)
				);
				if (isPersistenceChannel(channel)) this.invalidateState('persistence send failed');
			}
		});
	}

	canLogToHost(): boolean {
		return (
			this.connected &&
			!this.invalidState &&
			!this.resumePending &&
			this.ws?.readyState === WebSocket.OPEN
		);
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
			return listener(event, ...args);
		};
		this.on(channel, wrapped);
	}
}

const bridge = new BridgeClient({ wsUrl: getWsUrl() });

// Keep a bounded local diagnostic history while the host logger is unavailable.
// Debug/info stay out of the console; real warnings retain their original level.
const localDiagnostics = new Map<string, { count: number; lastPrinted?: number }>();
/** Deduplicate outage diagnostics locally without making another bridge logging request. */
function recordLocalDiagnostic(args: unknown[]): void {
	const [level, message, context, data] = args;
	const key = `${String(level)}:${String(context ?? '')}:${String(message)}:${data instanceof Error ? data.message : ''}`;
	let record = localDiagnostics.get(key);
	if (!record) {
		if (localDiagnostics.size >= 100)
			localDiagnostics.delete(localDiagnostics.keys().next().value!);
		record = { count: 0 };
		localDiagnostics.set(key, record);
	}
	record.count++;
	if (level !== 'warn' && level !== 'error') return;
	if (args.some(isExpectedBridgeError)) return;
	if (record.lastPrinted !== undefined && Date.now() - record.lastPrinted < 30_000) return;
	record.lastPrinted = Date.now();
	console[level]('[bridge:local]', message, context, data);
}

export const ipcRenderer = {
	invoke: (channel: string, ...args: unknown[]) => {
		if (channel === 'logger:log') {
			if (!bridge.canLogToHost() || args.some(isExpectedBridgeError)) {
				recordLocalDiagnostic(args);
				return Promise.resolve();
			}
			return bridge.invoke(channel, ...args).catch(() => {
				recordLocalDiagnostic(args);
			});
		}
		if (channel === 'dialog:selectFolder')
			return selectHostFolder((name, ...values) => bridge.invoke(name, ...values));
		if (channel === 'dialog:saveFile')
			return selectHostSaveFile(
				(name, ...values) => bridge.invoke(name, ...values),
				args[0] as Parameters<typeof selectHostSaveFile>[1]
			);
		return bridge.invoke(channel, ...args);
	},
	send: (channel: string, ...args: unknown[]) => {
		// ipcRenderer.send is fire-and-forget by contract, but on the WS bridge
		// we still get a rejection if the channel is unknown or the server-side
		// handler throws. Log it so the failure is debuggable - don't rethrow,
		// callers don't expect a Promise here.
		void bridge.invoke(channel, ...args).catch((err) => {
			if (isExpectedBridgeError(err)) return;
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
	getPathForFile: (_file: File): string => '',
};

export default { ipcRenderer, contextBridge, shell, webFrame, webUtils };

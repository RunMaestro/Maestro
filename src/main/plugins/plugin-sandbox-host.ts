/**
 * Plugin sandbox host (main process).
 *
 * Forks one Electron utilityProcess per running tier-1 plugin (process + crash
 * isolation), ships the plugin's entry code into the confined child, and is the
 * ONLY path the child can affect the host: every HostRequest is authorized by
 * the permission broker (default deny) before an injected handler executes it.
 *
 * The host treats the child as hostile: it validates the method and request
 * shape, caps message size, and never evaluates anything the child sends. A
 * crashed or misbehaving child is isolated to itself; stop()/stopAll() tear
 * children down (graceful shutdown message, then hard kill after a grace).
 */

import { utilityProcess, type UtilityProcess } from 'electron';
import * as path from 'path';
import { logger } from '../utils/logger';
import { PermissionBroker } from './permission-broker';
import type { PluginActivationIdentity } from './plugin-activation-identity';
import {
	isHostMethod,
	type HostMethod,
	type HostRequest,
	type HostResponse,
	type SandboxSurfaceFlags,
	type ToolResult,
} from '../../shared/plugins/rpc-protocol';
import type { PluginEvent } from '../../shared/plugins/events';

export interface SandboxControlEvent {
	topic: string;
	at: string;
	payload: unknown;
}

/** An injected implementation of one host method. Receives the calling plugin
 * id (for per-plugin scoping) and the validated params. */
export type HostCallHandler = (pluginId: string, params: unknown) => Promise<unknown>;
export type HostCallHandlers = Partial<Record<HostMethod, HostCallHandler>>;

export interface PluginSandboxHostDeps {
	broker: PermissionBroker;
	handlers: HostCallHandlers;
	/** Forward plugin console/log lines somewhere visible. */
	onLog?: (pluginId: string, level: string, message: string) => void;
	/** Notified when a child exits unexpectedly (non-zero / crash). */
	onCrash?: (pluginId: string, code: number) => void;
	/** Notified when a plugin is stopped ON PURPOSE (disable/uninstall/reload/
	 * quit), BEFORE the shutdown message is posted — so intentional stops can
	 * be distinguished from crashes by exit-time observers (e.g. the background
	 * supervisor clears registrations here and never restarts on the exit). */
	onStop?: (pluginId: string) => void;
	/** Host-authoritative startup posture. The sandbox receives only these
	 * booleans and never derives optional capability surfaces from its manifest. */
	surfaceFlagsFor?: (pluginId: string) => SandboxSurfaceFlags;
}

/** One bounded recent-log entry observed for a running plugin. */
export interface ActivityLogLine {
	level: string;
	message: string;
	/** Epoch ms when the line was observed. */
	at: number;
}

/**
 * Read-only observability snapshot for one plugin (running tier-1). Pure data,
 * safe to serialize across IPC; produced by {@link PluginSandboxHost.getActivity}.
 */
export interface ActivitySnapshot {
	/** Total host calls dispatched to a handler for this plugin (cumulative). */
	totalCalls: number;
	/** Host calls currently executing. */
	inFlight: number;
	/** Highest concurrent in-flight count observed. */
	peakInFlight: number;
	/** Epoch ms of the last observed activity (host call or log line). */
	lastActivity: number;
	/** Times this plugin's child exited non-zero since the host started. */
	crashCount: number;
	/** Bounded ring buffer (oldest first) of the most recent log lines. */
	recentLogs: ActivityLogLine[];
}

/** Hard cap on a single RPC message to bound memory from a hostile child. */
const MAX_MESSAGE_BYTES = 1_000_000;
/** Grace period between a graceful shutdown message and a hard kill. */
const SHUTDOWN_GRACE_MS = 2000;
/** Max concurrent in-flight host calls per plugin (backpressure). */
const MAX_IN_FLIGHT = 32;
/** Sliding-window rate limit: max requests per window per plugin. */
const RATE_WINDOW_MS = 1000;
const RATE_MAX_PER_WINDOW = 200;
/** Bounded ring-buffer size for per-plugin recent log lines (observability). */
const ACTIVITY_LOG_LIMIT = 50;
/** How long the host waits for a child's `toolResult` before rejecting. */
const TOOL_INVOKE_TIMEOUT_MS = 30_000;
/** Max concurrent in-flight tool invocations per plugin (bounds the pending map
 *  against a stuck/hostile child that never replies). */
const MAX_PENDING_TOOLS = 64;

/** One outstanding `invokeTool` round-trip awaiting the child's `toolResult`. */
interface PendingTool {
	resolve: (value: unknown) => void;
	reject: (err: Error) => void;
	timer: NodeJS.Timeout;
}

interface RunningPlugin {
	proc: UtilityProcess;
	identity: PluginActivationIdentity;
	shutdownTimer?: NodeJS.Timeout;
	inFlight: number;
	windowStart: number;
	windowCount: number;
	/** Outstanding tool invocations keyed by correlation id. */
	pendingTools: Map<number, PendingTool>;
	/** Monotonic correlation id for the next tool invocation. */
	nextToolId: number;
}

/** Mutable per-plugin observability accumulator. Kept separate from `running`
 *  so a crash count outlives the child that produced it. */
interface Activity {
	totalCalls: number;
	inFlight: number;
	peakInFlight: number;
	lastActivity: number;
	crashCount: number;
	recentLogs: ActivityLogLine[];
}

/** Project a mutable accumulator into a serializable read-only snapshot. */
function toActivitySnapshot(a: Activity): ActivitySnapshot {
	return {
		totalCalls: a.totalCalls,
		inFlight: a.inFlight,
		peakInFlight: a.peakInFlight,
		lastActivity: a.lastActivity,
		crashCount: a.crashCount,
		recentLogs: a.recentLogs.map((l) => ({ ...l })),
	};
}

export class PluginSandboxHost {
	private running = new Map<string, RunningPlugin>();
	/** Per-plugin observability, keyed by plugin id. Separate from `running` so
	 *  it survives a crashed child (crash counts must persist). */
	private activity = new Map<string, Activity>();

	constructor(private readonly deps: PluginSandboxHostDeps) {}

	isRunning(pluginId: string): boolean {
		return this.running.has(pluginId);
	}

	runningIds(): string[] {
		return [...this.running.keys()];
	}

	getActivationIdentity(pluginId: string): PluginActivationIdentity | null {
		const identity = this.running.get(pluginId)?.identity;
		return identity ? { ...identity } : null;
	}

	/**
	 * Read-only observability for plugins (running tier-1). With no argument,
	 * returns a snapshot map keyed by plugin id; with an id, returns that
	 * plugin's snapshot (or undefined). Snapshots are copies, so mutating them
	 * never affects host state and the ring buffer is safe to serialize.
	 */
	getActivity(): Record<string, ActivitySnapshot>;
	getActivity(pluginId: string): ActivitySnapshot | undefined;
	getActivity(pluginId?: string): Record<string, ActivitySnapshot> | ActivitySnapshot | undefined {
		if (typeof pluginId === 'string') {
			const a = this.activity.get(pluginId);
			return a ? toActivitySnapshot(a) : undefined;
		}
		const out: Record<string, ActivitySnapshot> = {};
		for (const [id, a] of this.activity) out[id] = toActivitySnapshot(a);
		return out;
	}

	/** Get-or-create the observability accumulator for a plugin. */
	private activityFor(pluginId: string): Activity {
		let a = this.activity.get(pluginId);
		if (!a) {
			a = {
				totalCalls: 0,
				inFlight: 0,
				peakInFlight: 0,
				lastActivity: Date.now(),
				crashCount: 0,
				recentLogs: [],
			};
			this.activity.set(pluginId, a);
		}
		return a;
	}

	/** Append a log line to a plugin's bounded ring buffer and bump activity. */
	private recordLog(pluginId: string, level: string, message: string): void {
		const a = this.activityFor(pluginId);
		const now = Date.now();
		a.recentLogs.push({ level, message, at: now });
		if (a.recentLogs.length > ACTIVITY_LOG_LIMIT) a.recentLogs.shift();
		a.lastActivity = now;
	}

	/**
	 * Start a plugin from a manager-captured verified source snapshot. No mutable
	 * installed path is accepted or read after signature verification.
	 */
	start(pluginId: string, entryCode: string, identity: PluginActivationIdentity): void {
		if (this.running.has(pluginId)) return;
		if (
			identity.ownerPluginId !== pluginId ||
			!Number.isSafeInteger(identity.generation) ||
			identity.generation < 1 ||
			!/^[a-f0-9]{64}$/i.test(identity.artifactDigest) ||
			identity.signerKeyId.length === 0
		) {
			throw new Error('invalid plugin activation identity');
		}
		const sandboxModule = path.join(__dirname, 'plugin-sandbox-entry.js');
		const proc = utilityProcess.fork(sandboxModule, [], {
			serviceName: `maestro-plugin-${pluginId}`,
			// No extra env: the child should not inherit Maestro secrets.
			env: {},
		});

		const record: RunningPlugin = {
			proc,
			identity: Object.freeze({ ...identity }),
			inFlight: 0,
			windowStart: Date.now(),
			windowCount: 0,
			pendingTools: new Map(),
			nextToolId: 1,
		};
		this.running.set(pluginId, record);
		// Ensure an observability record exists so a freshly started plugin shows
		// up in getActivity() even before it makes its first host call.
		this.activityFor(pluginId).lastActivity = Date.now();

		proc.on('message', (data: unknown) => {
			void this.handleChildMessage(pluginId, proc, data);
		});
		proc.on('exit', (code: number) => {
			const existing = this.running.get(pluginId);
			if (existing?.shutdownTimer) clearTimeout(existing.shutdownTimer);
			// Fail every outstanding tool round-trip: the child that owed a reply
			// is gone, so the awaiting caller must reject rather than hang.
			if (existing)
				this.rejectPendingTools(existing, 'plugin exited before returning a tool result');
			this.running.delete(pluginId);
			const act = this.activity.get(pluginId);
			if (act) act.inFlight = 0;
			if (code !== 0) {
				if (act) act.crashCount += 1;
				logger.warn(`[Plugins] sandbox "${pluginId}" exited with code ${code}`, '[Plugins]');
				this.deps.onCrash?.(pluginId, code);
			}
		});

		proc.postMessage({
			kind: 'init',
			pluginId,
			entryCode,
			surfaceFlags: this.deps.surfaceFlagsFor?.(pluginId) ?? {},
		});
	}

	/**
	 * Dispatch a command into a running plugin's sandbox. The local command id
	 * (the part after `<pluginId>/`) is sent; the plugin's registered handler
	 * runs. No-op (returns false) if the plugin is not running.
	 */
	invokeCommand(pluginId: string, commandId: string, args?: unknown): boolean {
		const record = this.running.get(pluginId);
		if (!record) return false;
		// Cap the host->child payload the same way HostRequest params are bounded:
		// a non-serializable or oversized args object is dropped, never posted.
		let serialized: string;
		try {
			serialized = JSON.stringify(args ?? null);
		} catch {
			return false;
		}
		if (serialized.length > MAX_MESSAGE_BYTES) return false;
		try {
			record.proc.postMessage({ kind: 'invokeCommand', commandId, args });
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Invoke a tool in a running plugin's sandbox and await its result. Unlike
	 * {@link invokeCommand} (fire-and-forget), this is a brokered request/response
	 * round-trip: a correlation id is assigned, an `invokeTool` control message is
	 * posted to the child, and the returned promise settles when the matching
	 * `toolResult` arrives (resolve `result` / reject `error`). Rejects if the
	 * plugin is not running, the args cannot be serialized or exceed the size cap,
	 * too many tool calls are already in flight, the round-trip exceeds
	 * {@link TOOL_INVOKE_TIMEOUT_MS}, or the child exits before replying.
	 */
	invokeTool(pluginId: string, commandId: string, args?: unknown): Promise<unknown> {
		const record = this.running.get(pluginId);
		if (!record) return Promise.reject(new Error(`plugin "${pluginId}" is not running`));
		// Bound the host->child payload exactly like invokeCommand / HostRequest.
		let serialized: string;
		try {
			serialized = JSON.stringify(args ?? null);
		} catch {
			return Promise.reject(new Error('tool args are not serializable'));
		}
		if (serialized.length > MAX_MESSAGE_BYTES) {
			return Promise.reject(new Error('tool args exceed size limit'));
		}
		if (record.pendingTools.size >= MAX_PENDING_TOOLS) {
			return Promise.reject(new Error('too many concurrent tool invocations'));
		}
		const id = record.nextToolId++;
		return new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				record.pendingTools.delete(id);
				reject(new Error(`tool "${commandId}" timed out after ${TOOL_INVOKE_TIMEOUT_MS}ms`));
			}, TOOL_INVOKE_TIMEOUT_MS);
			// Never let a pending tool timer keep the process alive on shutdown.
			if (typeof timer.unref === 'function') timer.unref();
			record.pendingTools.set(id, { resolve, reject, timer });
			try {
				record.proc.postMessage({ kind: 'invokeTool', id, commandId, args });
			} catch (err) {
				record.pendingTools.delete(id);
				clearTimeout(timer);
				reject(
					new Error(
						`failed to post tool invocation: ${err instanceof Error ? err.message : String(err)}`
					)
				);
			}
		});
	}

	/** Reject and clear every outstanding tool round-trip for a plugin (called
	 *  when the child exits so awaiting callers never hang). */
	private rejectPendingTools(record: RunningPlugin, reason: string): void {
		for (const pending of record.pendingTools.values()) {
			clearTimeout(pending.timer);
			pending.reject(new Error(reason));
		}
		record.pendingTools.clear();
	}

	/**
	 * Push a host event into a running plugin's sandbox (the event-bus sink).
	 * Sends the metadata-only `{ kind:'event', topic, at, payload }` control
	 * message and applies the SAME hostile-child posture as every other path:
	 * it never hands the child a handle, only a structured-clone message, and
	 * swallows post failures (a dead/gone child just yields false so the bus can
	 * prune the subscription). No-op (returns false) when the plugin is not
	 * running. Re-authorization happens in the bus BEFORE this is ever called.
	 */
	pushEvent(pluginId: string, event: PluginEvent | SandboxControlEvent): boolean {
		const record = this.running.get(pluginId);
		if (!record) return false;
		try {
			record.proc.postMessage({
				kind: 'event',
				topic: event.topic,
				at: event.at,
				payload: event.payload,
			});
			return true;
		} catch {
			return false;
		}
	}

	/** Stop a plugin: ask it to shut down, then hard-kill after a grace period. */
	stop(pluginId: string): void {
		const record = this.running.get(pluginId);
		if (!record) return;
		this.deps.onStop?.(pluginId);
		try {
			record.proc.postMessage({ kind: 'shutdown' });
		} catch {
			// Child may already be gone; fall through to kill.
		}
		record.shutdownTimer = setTimeout(() => {
			try {
				record.proc.kill();
			} catch {
				// Already dead.
			}
		}, SHUTDOWN_GRACE_MS);
	}

	/** Stop every running plugin (app shutdown / feature disable). */
	stopAll(): void {
		for (const id of this.runningIds()) this.stop(id);
	}

	/** Authorize and execute one host request from a child. */
	private async handleChildMessage(
		pluginId: string,
		proc: UtilityProcess,
		data: unknown
	): Promise<void> {
		if (typeof data !== 'object' || data === null) return;
		const msg = data as Record<string, unknown>;

		// Child log line (not a host call).
		if (msg.kind === 'log') {
			const level = String(msg.level ?? 'info');
			const message = String(msg.message ?? '');
			this.recordLog(pluginId, level, message);
			this.deps.onLog?.(pluginId, level, message);
			return;
		}

		// Child reply to one of our outstanding invokeTool round-trips.
		if (msg.kind === 'toolResult') {
			this.handleToolResult(pluginId, msg as unknown as ToolResult);
			return;
		}

		// Must be a HostRequest.
		if (typeof msg.id !== 'number' || !isHostMethod(msg.method)) return;
		const request = msg as unknown as HostRequest;

		const respond = (res: Omit<HostResponse, 'id'>): void => {
			try {
				proc.postMessage({ id: request.id, ...res });
			} catch {
				// Child gone; nothing to do.
			}
		};

		// Backpressure + rate limiting against a flooding child.
		const record = this.running.get(pluginId);
		if (record) {
			const now = Date.now();
			if (now - record.windowStart > RATE_WINDOW_MS) {
				record.windowStart = now;
				record.windowCount = 0;
			}
			record.windowCount += 1;
			if (record.inFlight >= MAX_IN_FLIGHT) {
				respond({ ok: false, error: 'too many concurrent host calls' });
				return;
			}
			if (record.windowCount > RATE_MAX_PER_WINDOW) {
				respond({ ok: false, error: 'host call rate limit exceeded' });
				return;
			}
		}

		// Bound message size from a hostile child.
		let serializedSize = 0;
		try {
			serializedSize = JSON.stringify(request.params ?? null).length;
		} catch {
			respond({ ok: false, error: 'params are not serializable' });
			return;
		}
		if (serializedSize > MAX_MESSAGE_BYTES) {
			respond({ ok: false, error: 'request params exceed size limit' });
			return;
		}

		const method = request.method;
		if (!record) {
			respond({ ok: false, error: 'plugin activation is no longer current' });
			return;
		}
		const decision = this.deps.broker.authorizeInvocation(record.identity, method, request.params);
		if (!decision.allowed) {
			respond({ ok: false, error: decision.reason ?? 'permission denied' });
			return;
		}

		const handler = this.deps.handlers[method];
		if (!handler) {
			respond({ ok: false, error: `host method ${method} is not implemented` });
			return;
		}

		if (record) record.inFlight += 1;
		const act = this.activityFor(pluginId);
		act.totalCalls += 1;
		act.inFlight += 1;
		act.lastActivity = Date.now();
		if (act.inFlight > act.peakInFlight) act.peakInFlight = act.inFlight;
		try {
			const result = await handler(pluginId, request.params);
			respond({ ok: true, result });
		} catch (err) {
			respond({ ok: false, error: err instanceof Error ? err.message : String(err) });
		} finally {
			if (record) record.inFlight = Math.max(0, record.inFlight - 1);
			act.inFlight = Math.max(0, act.inFlight - 1);
		}
	}

	/** Correlate a child's `toolResult` to its pending round-trip and settle it.
	 *  Ignored when the plugin/id is unknown (late reply after timeout/exit). */
	private handleToolResult(pluginId: string, res: ToolResult): void {
		const record = this.running.get(pluginId);
		if (!record) return;
		if (typeof res.id !== 'number') return;
		const pending = record.pendingTools.get(res.id);
		if (!pending) return;
		record.pendingTools.delete(res.id);
		clearTimeout(pending.timer);
		if (res.ok === true) {
			pending.resolve(res.result);
		} else {
			pending.reject(
				new Error(typeof res.error === 'string' ? res.error : 'tool invocation failed')
			);
		}
	}
}

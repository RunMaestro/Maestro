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
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';
import { PermissionBroker } from './permission-broker';
import {
	isHostMethod,
	type HostMethod,
	type HostRequest,
	type HostResponse,
} from '../../shared/plugins/rpc-protocol';

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

interface RunningPlugin {
	proc: UtilityProcess;
	shutdownTimer?: NodeJS.Timeout;
	inFlight: number;
	windowStart: number;
	windowCount: number;
}

export class PluginSandboxHost {
	private running = new Map<string, RunningPlugin>();

	constructor(private readonly deps: PluginSandboxHostDeps) {}

	isRunning(pluginId: string): boolean {
		return this.running.has(pluginId);
	}

	runningIds(): string[] {
		return [...this.running.keys()];
	}

	/**
	 * Start a plugin: read its entry code from disk and fork the confined sandbox
	 * child with that code. No-op if already running. Throws if the entry file
	 * cannot be read (caller decides how to surface it).
	 */
	start(pluginId: string, pluginDir: string, entryRelPath: string): void {
		if (this.running.has(pluginId)) return;

		// Resolve and confine the entry path inside the plugin dir (defense in
		// depth; the manifest validator already rejects traversal).
		const resolvedDir = path.resolve(pluginDir);
		const entryAbs = path.resolve(resolvedDir, entryRelPath);
		if (entryAbs !== resolvedDir && !entryAbs.startsWith(resolvedDir + path.sep)) {
			throw new Error(`entry path escapes plugin directory: ${entryRelPath}`);
		}
		const entryCode = fs.readFileSync(entryAbs, 'utf-8');

		const sandboxModule = path.join(__dirname, 'plugin-sandbox-entry.js');
		const proc = utilityProcess.fork(sandboxModule, [], {
			serviceName: `maestro-plugin-${pluginId}`,
			// No extra env: the child should not inherit Maestro secrets.
			env: {},
		});

		const record: RunningPlugin = { proc, inFlight: 0, windowStart: Date.now(), windowCount: 0 };
		this.running.set(pluginId, record);

		proc.on('message', (data: unknown) => {
			void this.handleChildMessage(pluginId, proc, data);
		});
		proc.on('exit', (code: number) => {
			const existing = this.running.get(pluginId);
			if (existing?.shutdownTimer) clearTimeout(existing.shutdownTimer);
			this.running.delete(pluginId);
			if (code !== 0) {
				logger.warn(`[Plugins] sandbox "${pluginId}" exited with code ${code}`, '[Plugins]');
				this.deps.onCrash?.(pluginId, code);
			}
		});

		proc.postMessage({ kind: 'init', pluginId, entryCode });
	}

	/** Stop a plugin: ask it to shut down, then hard-kill after a grace period. */
	stop(pluginId: string): void {
		const record = this.running.get(pluginId);
		if (!record) return;
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
			this.deps.onLog?.(pluginId, String(msg.level ?? 'info'), String(msg.message ?? ''));
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
		const decision = this.deps.broker.authorize(pluginId, method, request.params);
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
		try {
			const result = await handler(pluginId, request.params);
			respond({ ok: true, result });
		} catch (err) {
			respond({ ok: false, error: err instanceof Error ? err.message : String(err) });
		} finally {
			if (record) record.inFlight = Math.max(0, record.inFlight - 1);
		}
	}
}

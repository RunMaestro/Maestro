/**
 * Plugin sandbox child bootstrap (runs inside an Electron utilityProcess).
 *
 * THREAT MODEL (read before changing anything here):
 * A utilityProcess child has full Node by default - process isolation is NOT a
 * capability sandbox on its own. So plugin code is NOT `require`d into this
 * module's scope. Instead it is compiled and run inside a `vm` context whose
 * global is a frozen, minimal surface: the `maestro` SDK (which only does
 * broker-gated RPC back to the host) plus a curated set of pure ECMAScript
 * globals. `require`, `process`, `module`, `Buffer`, `globalThis`, and the Node
 * builtins are deliberately absent.
 *
 * `vm` is NOT a hard security boundary (a determined attacker can attempt realm
 * escapes), so it is defense-in-depth, not the primary defense. The primary
 * defenses are: (1) signature trust + explicit install-time consent gating which
 * code runs at all, and (2) the permission broker, which default-denies every
 * brokered host effect. IMPORTANT: a successful realm escape that reaches this
 * child's real `process`/`require` gets full Node in THIS utilityProcess and can
 * call fs/net/child_process DIRECTLY, bypassing the broker - so we work to make
 * escape hard (no host intrinsics, no require/process in the context, wrapped
 * timers, codeGeneration disabled). The child is launched with an empty env and
 * holds no Maestro secrets or handles, which bounds the damage of an escape to
 * the user's ambient OS permissions, but escape is not "harmless". Treat closing
 * escape vectors here as load-bearing, not cosmetic.
 *
 * The host (plugin-sandbox-host.ts) treats every message from here as hostile:
 * it validates the method, size, and shape, and authorizes via the broker before
 * doing anything.
 */

import * as vm from 'vm';
import {
	isHostMethod,
	type HostMethod,
	type HostRequest,
	type HostResponse,
	type HostControlMessage,
	type ToolResult,
} from '../../shared/plugins/rpc-protocol';

// utilityProcess exposes a message channel on process.parentPort (not in the
// standard Node Process type), so narrow access without redeclaring the global.
interface ParentPort {
	postMessage: (message: unknown) => void;
	on: (event: 'message', listener: (event: { data: unknown }) => void) => void;
}

const parentPort = (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort;

interface PendingCall {
	resolve: (value: unknown) => void;
	reject: (reason: Error) => void;
}

const pending = new Map<number, PendingCall>();
let nextId = 1;
let deactivate: (() => void | Promise<void>) | undefined;
/** Command handlers the plugin registered via maestro.commands.register. */
const commandHandlers = new Map<string, (args: unknown) => unknown>();
/** A plugin's local handler for a delivered host event (metadata-only payload). */
type PluginEventHandler = (payload: unknown, meta: { topic: string; at: string }) => void;
/** Per-topic event handlers the plugin registered via maestro.events.on. */
const eventHandlers = new Map<string, Set<PluginEventHandler>>();

/** Send a brokered host call and await its response. */
function hostCall(method: HostMethod, params: unknown): Promise<unknown> {
	if (!parentPort) return Promise.reject(new Error('sandbox has no parent port'));
	const id = nextId++;
	const request: HostRequest = { id, method, params };
	let resolve!: (value: unknown) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<unknown>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	pending.set(id, { resolve, reject });
	parentPort.postMessage(request);
	return promise;
}

/** Build the `maestro` SDK object exposed to plugin code. Every method is a
 * thin broker-gated RPC; there is no direct host access. */
function buildSdk(pluginId: string) {
	const call = (method: HostMethod, params: unknown): Promise<unknown> => hostCall(method, params);
	return Object.freeze({
		pluginId,
		fs: Object.freeze({
			read: (path: string): Promise<string> => call('fs.read', { path }) as Promise<string>,
			write: (path: string, contents: string): Promise<void> =>
				call('fs.write', { path, contents }) as Promise<void>,
			watch: (path: string, opts?: unknown): Promise<unknown> => call('fs.watch', { path, opts }),
		}),
		net: Object.freeze({
			fetch: (url: string, init?: unknown): Promise<unknown> => call('net.fetch', { url, init }),
		}),
		agents: Object.freeze({
			list: (): Promise<unknown> => call('agents.list', {}),
			get: (agentId: string): Promise<unknown> => call('agents.get', { agentId }),
			dispatch: (agentId: string, prompt: string, opts?: unknown): Promise<unknown> =>
				call('agents.dispatch', { agentId, prompt, opts }),
		}),
		history: Object.freeze({
			list: (params?: unknown): Promise<unknown> => call('history.list', params ?? {}),
			get: (entryId: string): Promise<unknown> => call('history.get', { entryId }),
		}),
		notifications: Object.freeze({
			toast: (message: string, opts?: unknown): Promise<void> =>
				call('notifications.toast', { message, opts }) as Promise<void>,
		}),
		settings: Object.freeze({
			get: (key: string): Promise<unknown> => call('settings.get', { key }),
			/** Write the plugin's OWN namespaced (plugins.<id>.*) non-secret setting. */
			set: (key: string, value: unknown): Promise<void> =>
				call('settings.set', { key, value }) as Promise<void>,
		}),
		sessions: Object.freeze({
			/** List session METADATA (never message content). */
			list: (): Promise<unknown> => call('sessions.list', {}),
			get: (sessionId: string): Promise<unknown> => call('sessions.get', { sessionId }),
			create: (params?: unknown): Promise<unknown> => call('sessions.create', params ?? {}),
			update: (sessionId: string, patch: unknown): Promise<unknown> =>
				call('sessions.update', { sessionId, patch }),
			delete: (sessionId: string): Promise<void> =>
				call('sessions.delete', { sessionId }) as Promise<void>,
		}),
		transcripts: Object.freeze({
			/** Read PROJECTED conversation content for a session visible via
			 * sessions.list. Declare exactly the `fields` you need; only those are
			 * returned. Requires the high-risk `transcripts:read` capability and is
			 * project-scoped + audited. Pass `projectPath` (from session metadata)
			 * so a project-scoped grant authorizes; omit it only with an unscoped
			 * grant. */
			read: (params: {
				sessionId: string;
				fields: readonly string[];
				projectPath?: string;
				limit?: number;
				since?: number;
			}): Promise<unknown> => call('transcripts.read', params),
			append: (params: {
				sessionId: string;
				projectPath?: string;
				entries: Array<Record<string, unknown>>;
			}): Promise<unknown> => call('transcripts.append', params),
		}),
		storage: Object.freeze({
			get: (key: string): Promise<unknown> => call('storage.get', { key }),
			set: (key: string, value: string): Promise<void> =>
				call('storage.set', { key, value }) as Promise<void>,
			delete: (key: string): Promise<unknown> => call('storage.delete', { key }),
			keys: (): Promise<unknown> => call('storage.keys', {}),
			sql: (query: string, params?: readonly unknown[]): Promise<unknown> =>
				call('storage.sql', { query, params }),
		}),
		ui: Object.freeze({
			/** Invoke a registered command-palette command. */
			runCommand: (commandId: string, args?: unknown): Promise<unknown> =>
				call('ui.runCommand', { commandId, args }),
		}),
		tabs: Object.freeze({
			list: (): Promise<unknown> => call('tabs.list', {}),
			create: (params?: unknown): Promise<unknown> => call('tabs.create', params ?? {}),
			focus: (tabId: string): Promise<void> => call('tabs.focus', { tabId }) as Promise<void>,
			close: (tabId: string): Promise<void> => call('tabs.close', { tabId }) as Promise<void>,
		}),
		events: Object.freeze({
			/** Register a local handler for a host event topic (call subscribe to
			 * start delivery). Payloads are metadata-only. */
			on: (topic: string, handler: PluginEventHandler): void => {
				if (typeof topic !== 'string' || typeof handler !== 'function') return;
				let set = eventHandlers.get(topic);
				if (!set) {
					set = new Set<PluginEventHandler>();
					eventHandlers.set(topic, set);
				}
				set.add(handler);
			},
			/** Ask the host to start delivering the given topics to this plugin. */
			subscribe: (topics: readonly string[]): Promise<unknown> =>
				call('events.subscribe', { topics }),
			/** Stop delivery for the given topics, or all topics when omitted. */
			unsubscribe: (topics?: readonly string[]): Promise<unknown> =>
				call('events.unsubscribe', topics ? { topics } : {}),
		}),
		commands: Object.freeze({
			/** Register a handler invoked when the host dispatches this command. */
			register: (commandId: string, handler: (args: unknown) => unknown): void => {
				if (typeof commandId === 'string' && typeof handler === 'function') {
					commandHandlers.set(commandId, handler);
				}
			},
		}),
		tools: Object.freeze({
			/** Register a tool handler. A tool IS a command-with-result: the host
			 * invokes it via a brokered request/response round-trip and resolves the
			 * caller with the awaited return value. Delegates to the same handler map
			 * as commands, so a single local id can be both a command and a tool. */
			register: (localId: string, handler: (args: unknown) => unknown): void => {
				if (typeof localId === 'string' && typeof handler === 'function') {
					commandHandlers.set(localId, handler);
				}
			},
		}),
		shell: Object.freeze({
			openExternal: (url: string, opts?: unknown): Promise<void> =>
				call('shell.openExternal', { url, opts }) as Promise<void>,
		}),
		process: Object.freeze({
			spawn: (command: string, opts?: unknown): Promise<unknown> =>
				call('process.spawn', { command, opts }),
		}),
		decisions: Object.freeze({
			record: (decision: unknown): Promise<unknown> => call('decisions.record', { decision }),
		}),
		power: Object.freeze({
			preventSleep: (reason: string, opts?: unknown): Promise<unknown> =>
				call('power.preventSleep', { reason, opts }),
			releaseSleep: (handleId: string): Promise<void> =>
				call('power.releaseSleep', { handleId }) as Promise<void>,
		}),
		background: Object.freeze({
			register: (service: unknown): Promise<unknown> => call('background.register', { service }),
			unregister: (serviceId: string): Promise<void> =>
				call('background.unregister', { serviceId }) as Promise<void>,
		}),
	});
}

/**
 * Run the plugin's code in a confined vm context. The plugin module is expected
 * to assign an object with optional `activate(maestro)` / `deactivate()` to
 * `module.exports` (CommonJS-ish), which we expose as a bare `module` object in
 * the sandbox. No Node `require` is provided.
 */
function runPluginCode(pluginId: string, code: string): void {
	const sdk = buildSdk(pluginId);
	const moduleShim: { exports: Record<string, unknown> } = { exports: {} };

	// Curated globals. We deliberately do NOT inject host intrinsics (Object, Array,
	// Promise, URL, ...): doing so would share the HOST's prototype chain with plugin
	// code (prototype pollution of this process). vm.createContext gives the context
	// its OWN native intrinsics, isolated from the host realm.
	//
	// HONEST THREAT MODEL: the values we DO inject (the maestro SDK, console,
	// setTimeout/clearTimeout) are host-realm functions, so `someInjected.constructor`
	// is the HOST `Function` constructor, and `codeGeneration.strings:false` only
	// disables code-gen for the CONTEXT's own Function - NOT the host's. A determined
	// plugin can therefore still realm-escape (e.g. `console.log.constructor("return
	// process")()` reaches the real `process`). vm is DEFENSE-IN-DEPTH, never the
	// boundary: the real isolation is the separate utilityProcess + the default-deny
	// broker + signature/consent gating on which code runs at all. Closing the escape
	// fully (an OS-level sandbox dropping ambient fs/net/exec authority) is the
	// documented Phase-3 decision; until then, enabling a tier-1 code plugin is a
	// full-trust decision. require/process/Buffer/module-loading/globalThis are absent.
	const sandboxGlobal: Record<string, unknown> = {
		maestro: sdk,
		module: moduleShim,
		exports: moduleShim.exports,
		console: makeSandboxConsole(),
		setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
		clearTimeout: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
	};

	const context = vm.createContext(sandboxGlobal, {
		codeGeneration: { strings: false, wasm: false },
	});
	const script = new vm.Script(code, { filename: `plugin:${pluginId}` });
	script.runInContext(context, { timeout: 5000 });

	const exported = moduleShim.exports as {
		activate?: (m: unknown) => void | Promise<void>;
		deactivate?: () => void | Promise<void>;
	};
	deactivate = typeof exported.deactivate === 'function' ? exported.deactivate : undefined;
	if (typeof exported.activate === 'function') {
		void Promise.resolve(exported.activate(sdk)).catch((err) => {
			log('error', `activate() threw: ${String(err)}`);
		});
	}
}

function makeSandboxConsole() {
	return {
		log: (...args: unknown[]) => log('info', args.map(String).join(' ')),
		info: (...args: unknown[]) => log('info', args.map(String).join(' ')),
		warn: (...args: unknown[]) => log('warn', args.map(String).join(' ')),
		error: (...args: unknown[]) => log('error', args.map(String).join(' ')),
	};
}

function log(level: 'info' | 'warn' | 'error', message: string): void {
	parentPort?.postMessage({ kind: 'log', level, message });
}

/** Handle a response to one of our outstanding host calls. */
function handleResponse(res: HostResponse): void {
	const call = pending.get(res.id);
	if (!call) return;
	pending.delete(res.id);
	if (res.ok) call.resolve(res.result);
	else call.reject(new Error(res.error ?? 'host call failed'));
}

if (parentPort) {
	parentPort.on('message', (event) => {
		const data = event.data;
		if (typeof data !== 'object' || data === null) return;
		const msg = data as Record<string, unknown>;

		// Control messages from the host.
		if (msg.kind === 'init') {
			const control = msg as unknown as Extract<HostControlMessage, { kind: 'init' }>;
			if (typeof control.entryCode === 'string') {
				try {
					runPluginCode(control.pluginId, control.entryCode);
				} catch (err) {
					log('error', `failed to start plugin: ${String(err)}`);
				}
			}
			return;
		}
		if (msg.kind === 'invokeCommand') {
			const commandId = typeof msg.commandId === 'string' ? msg.commandId : '';
			const handler = commandHandlers.get(commandId);
			if (handler) {
				try {
					void Promise.resolve(handler(msg.args)).catch((err) =>
						log('error', `command "${commandId}" threw: ${String(err)}`)
					);
				} catch (err) {
					log('error', `command "${commandId}" threw: ${String(err)}`);
				}
			} else {
				log('warn', `no handler registered for command "${commandId}"`);
			}
			return;
		}
		if (msg.kind === 'invokeTool') {
			const id = typeof msg.id === 'number' ? msg.id : -1;
			const commandId = typeof msg.commandId === 'string' ? msg.commandId : '';
			const reply = (res: Omit<ToolResult, 'kind' | 'id'>): void => {
				parentPort?.postMessage({ kind: 'toolResult', id, ...res });
			};
			const handler = commandHandlers.get(commandId);
			if (!handler) {
				log('warn', `no handler registered for tool "${commandId}"`);
				reply({ ok: false, error: `no handler registered for tool "${commandId}"` });
				return;
			}
			try {
				void Promise.resolve(handler(msg.args)).then(
					(result) => reply({ ok: true, result }),
					(err) => {
						log('error', `tool "${commandId}" threw: ${String(err)}`);
						reply({ ok: false, error: err instanceof Error ? err.message : String(err) });
					}
				);
			} catch (err) {
				log('error', `tool "${commandId}" threw: ${String(err)}`);
				reply({ ok: false, error: err instanceof Error ? err.message : String(err) });
			}
			return;
		}
		if (msg.kind === 'event') {
			const topic = typeof msg.topic === 'string' ? msg.topic : '';
			const handlers = eventHandlers.get(topic);
			if (handlers) {
				const meta = { topic, at: typeof msg.at === 'string' ? msg.at : '' };
				for (const handler of handlers) {
					try {
						void Promise.resolve(handler(msg.payload, meta)).catch((err) =>
							log('error', `event "${topic}" handler threw: ${String(err)}`)
						);
					} catch (err) {
						log('error', `event "${topic}" handler threw: ${String(err)}`);
					}
				}
			}
			return;
		}
		if (msg.kind === 'shutdown') {
			void Promise.resolve(deactivate?.()).finally(() => process.exit(0));
			return;
		}

		// Otherwise it must be a HostResponse to one of our calls.
		if (typeof msg.id === 'number' && typeof msg.ok === 'boolean' && !isHostMethod(msg.method)) {
			handleResponse(msg as unknown as HostResponse);
		}
	});
}

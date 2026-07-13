/**
 * Plugin sandbox child bootstrap (runs inside an Electron utilityProcess).
 *
 * Two isolation layers apply to plugin code, and it is critical to be honest
 * about what each one is:
 *
 * 1. The utilityProcess is PROCESS isolation (crash + env separation), not an
 *    OS sandbox: this child still runs with the user's ambient OS privileges.
 * 2. The vm context is REALM isolation and is defense-in-depth only. The real
 *    boundary is (1) plus the signature/consent gate on which code runs at all,
 *    and the permission broker, which default-denies every brokered host effect.
 *
 * REALM CONSTRUCTION INVARIANT (the load-bearing part of this file): nothing
 * reachable from plugin code may be a host-realm value. Every function and
 * object the plugin can touch (the maestro SDK, console, timers, module /
 * exports, and everything transitively reachable from them) is constructed
 * INSIDE the vm context by a precompiled bootstrap script, from JSON-only
 * data. Host bridge functions are captured in bootstrap closures — never
 * assigned to any property plugin code can read — so the canonical escape
 * `reachable.constructor.constructor('return process')()` resolves to the
 * CONTEXT Function constructor, which `codeGeneration: { strings: false }`
 * makes throw. The regression test in
 * `src/__tests__/main/plugins/plugin-sandbox-realm.test.ts` walks the entire
 * reachable graph and fails the build if any host intrinsic leaks back in.
 *
 * IMPORTANT: a successful realm escape that reaches this child's real
 * `process`/`require` gets full Node in THIS utilityProcess and can call
 * fs/net/child_process DIRECTLY, bypassing the broker — so treat every change
 * to the bootstrap surface as security-sensitive, not cosmetic.
 */

import * as vm from 'vm';
import {
	isHostMethod,
	type HostControlMessage,
	type HostResponse,
	type ToolResult,
} from '../../shared/plugins/rpc-protocol';

// utilityProcess exposes a message channel on process.parentPort (not in the
// standard Node Process type), so narrow access without redeclaring the global.
interface ParentPort {
	on(event: 'message', listener: (event: { data: unknown }) => void): void;
	postMessage(message: unknown): void;
}

const parentPort = (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort;

/** Host-realm callbacks handed to the bootstrap factory. They are captured in
 * context closures and must NEVER be reachable as properties from plugin code.
 * Every argument crossing this boundary is a primitive (string/number). */
export interface RealmBridge {
	/** Fire a brokered host RPC request; `json` is `{id, method, params}`. */
	send(json: string): void;
	/** Sink for sandbox console output and internal error reporting. */
	log(level: 'info' | 'warn' | 'error', message: string): void;
	/** Start a host timer that must call `SandboxRealm.fireTimer(id)` on expiry. */
	timerStart(id: number, ms: number): void;
	/** Cancel a host timer started via `timerStart`. */
	timerClear(id: number): void;
}

/** Context-realm entry points returned by the bootstrap factory. All `json`
 * parameters are serialized by the host and parsed INSIDE the context so the
 * data plugin handlers observe is context-realm. */
/** Flags derived by the authoritative host at sandbox startup. A false or
 * absent field means that optional surface is not installed in the realm. */
export interface SandboxSurfaceFlags {
	readonly workspace?: boolean;
	readonly interactivePanel?: boolean;
	readonly interactiveRuntime?: boolean;
}

export interface SandboxRealm {
	/** Install the SDK + curated globals for `pluginId`. Call once, first. */
	init(pluginId: string, surfaceFlags?: SandboxSurfaceFlags): void;
	runScript(code: string, filename: string, timeoutMs?: number): void;
	/** Resolve/reject a pending SDK call; `json` is a HostResponse. */
	deliverResponse(json: string): void;
	/** Fan an event out to registered handlers; `json` is `{topic, at, payload}`. */
	deliverEvent(json: string): void;
	/** Fire-and-forget a registered command; `json` is `{commandId, args}`. */
	invokeCommand(json: string): void;
	/** Invoke a registered tool; resolves to a JSON string of
	 * `{ok: true, result}` or `{ok: false, error}`. */
	invokeTool(json: string): Promise<string>;
	/** Run the context callback registered for host timer `id`. */
	fireTimer(id: number): void;
	/** Call the plugin's `activate(maestro)` export, if present. */
	activate(): Promise<void>;
	/** Call the plugin's `deactivate()` export, if present. */
	deactivate(): Promise<void>;
}

/**
 * Bootstrap source, compiled once and evaluated inside the context; its
 * completion value is a factory the HOST calls with the bridge. Plain JS by
 * necessity (it executes in the plugin realm, not through the TS build).
 *
 * Rules for editing this string:
 * - No host value may be assigned to `globalThis` or any reachable property.
 * - Data from the host arrives ONLY as JSON strings, parsed here.
 * - Values returned to the host are primitives or context promises thereof.
 */
const BOOTSTRAP_SOURCE = String.raw`(function bootstrap(bridge) {
	'use strict';
	var bridgeSend = bridge.send;
	var bridgeLog = bridge.log;
	var bridgeTimerStart = bridge.timerStart;
	var bridgeTimerClear = bridge.timerClear;
	bridge = null; // drop the only direct reference to the host object

	function safeLog(level, message) {
		try { bridgeLog(level, message); } catch (e) { /* host gone; nothing to do */ }
	}

	// ---- brokered host calls -------------------------------------------------
	var pending = new Map();
	var nextCallId = 1;
	function hostCall(method, params) {
		var d = Promise.withResolvers();
		var id = nextCallId++;
		pending.set(id, d);
		try {
			bridgeSend(JSON.stringify({ id: id, method: method, params: params }));
		} catch (e) {
			pending.delete(id);
			d.reject(new Error('sandbox bridge unavailable'));
		}
		return d.promise;
	}
	function deliverResponse(json) {
		var res;
		try { res = JSON.parse(json); } catch (e) { return; }
		if (!res || typeof res.id !== 'number') return;
		var call = pending.get(res.id);
		if (!call) return;
		pending.delete(res.id);
		if (res.ok) call.resolve(res.result);
		else call.reject(new Error(typeof res.error === 'string' ? res.error : 'host call failed'));
	}

	// ---- curated globals -----------------------------------------------------
	var sandboxConsole = Object.freeze({
		log: function () { safeLog('info', Array.prototype.map.call(arguments, String).join(' ')); },
		info: function () { safeLog('info', Array.prototype.map.call(arguments, String).join(' ')); },
		warn: function () { safeLog('warn', Array.prototype.map.call(arguments, String).join(' ')); },
		error: function () { safeLog('error', Array.prototype.map.call(arguments, String).join(' ')); }
	});

	var timers = new Map();
	var nextTimerId = 1;
	function sandboxSetTimeout(fn, ms) {
		if (typeof fn !== 'function') return 0;
		var id = nextTimerId++;
		timers.set(id, fn);
		try { bridgeTimerStart(id, typeof ms === 'number' && ms >= 0 ? ms : 0); } catch (e) { timers.delete(id); return 0; }
		return id;
	}
	function sandboxClearTimeout(id) {
		if (!timers.delete(id)) return;
		try { bridgeTimerClear(id); } catch (e) { /* already fired host-side */ }
	}
	function fireTimer(id) {
		var fn = timers.get(id);
		timers.delete(id);
		if (typeof fn !== 'function') return;
		// Log-and-RETHROW: a throwing timer callback must keep its pre-realm
		// semantics — the throw escapes to the host setTimeout callback, becomes
		// an uncaughtException, and CRASHES the child. That crash is load-bearing:
		// the FC5 background supervisor's crash-restart path (and its e2e) detect
		// exactly this. Swallowing it here would leave a wedged plugin running.
		try {
			fn();
		} catch (e) {
			safeLog('error', 'timer callback threw: ' + String(e));
			throw e;
		}
	}

	// ---- plugin registries ---------------------------------------------------
	var commandHandlers = new Map();
	var eventHandlers = new Map();

	function deliverEvent(json) {
		var msg;
		try { msg = JSON.parse(json); } catch (e) { return; }
		if (!msg || typeof msg.topic !== 'string') return;
		var handlers = eventHandlers.get(msg.topic);
		if (!handlers) return;
		var meta = Object.freeze({ topic: msg.topic, at: typeof msg.at === 'string' ? msg.at : '' });
		handlers.forEach(function (handler) {
			try {
				Promise.resolve(handler(msg.payload, meta)).catch(function (err) {
					safeLog('error', 'event "' + msg.topic + '" handler threw: ' + String(err));
				});
			} catch (err) {
				safeLog('error', 'event "' + msg.topic + '" handler threw: ' + String(err));
			}
		});
	}

	function invokeCommand(json) {
		var msg;
		try { msg = JSON.parse(json); } catch (e) { return; }
		if (!msg || typeof msg.commandId !== 'string') return;
		var handler = commandHandlers.get(msg.commandId);
		if (!handler) { safeLog('warn', 'no handler registered for command "' + msg.commandId + '"'); return; }
		try {
			Promise.resolve(handler(msg.args)).catch(function (err) {
				safeLog('error', 'command "' + msg.commandId + '" threw: ' + String(err));
			});
		} catch (err) {
			safeLog('error', 'command "' + msg.commandId + '" threw: ' + String(err));
		}
	}

	function invokeTool(json) {
		var msg;
		try { msg = JSON.parse(json); } catch (e) { return Promise.resolve(JSON.stringify({ ok: false, error: 'malformed tool invocation' })); }
		var commandId = msg && typeof msg.commandId === 'string' ? msg.commandId : '';
		var handler = commandHandlers.get(commandId);
		if (!handler) {
			safeLog('warn', 'no handler registered for tool "' + commandId + '"');
			return Promise.resolve(JSON.stringify({ ok: false, error: 'no handler registered for tool "' + commandId + '"' }));
		}
		return new Promise(function (resolve) {
			try {
				Promise.resolve(handler(msg.args)).then(
					function (result) {
						var body;
						try { body = JSON.stringify({ ok: true, result: result === undefined ? null : result }); }
						catch (e) { body = JSON.stringify({ ok: false, error: 'tool result is not JSON-serializable' }); }
						resolve(body);
					},
					function (err) {
						safeLog('error', 'tool "' + commandId + '" threw: ' + String(err));
						resolve(JSON.stringify({ ok: false, error: err && err.message ? String(err.message) : String(err) }));
					}
				);
			} catch (err) {
				safeLog('error', 'tool "' + commandId + '" threw: ' + String(err));
				resolve(JSON.stringify({ ok: false, error: err && err.message ? String(err.message) : String(err) }));
			}
		});
	}

	// ---- the maestro SDK (broker-gated RPC only; frozen with CONTEXT
	// intrinsics so plugin code cannot mutate or extend the surface) ----------
	function buildSdk(pluginId, surfaceFlags) {
		var sdk = {
			pluginId: pluginId,
			fs: Object.freeze({
				read: function (path) { return hostCall('fs.read', { path: path }); },
				write: function (path, contents) { return hostCall('fs.write', { path: path, contents: contents }); },
				watch: function (path, opts) { return hostCall('fs.watch', { path: path, opts: opts }); }
			}),
			net: Object.freeze({
				fetch: function (url, init) { return hostCall('net.fetch', { url: url, init: init }); },
				connect: function (url, opts) { return hostCall('net.connect', { url: url, protocols: opts && opts.protocols, headers: opts && opts.headers }); },
				send: function (socketId, data) { return hostCall('net.send', { socketId: socketId, data: data }); },
				close: function (socketId, opts) { return hostCall('net.close', { socketId: socketId, code: opts && opts.code, reason: opts && opts.reason }); }
			}),
			agents: Object.freeze({
				list: function () { return hostCall('agents.list', {}); },
				get: function (agentId) { return hostCall('agents.get', { agentId: agentId }); },
				dispatch: function (agentId, prompt, opts) { return hostCall('agents.dispatch', { agentId: agentId, prompt: prompt, opts: opts }); }
			}),
			history: Object.freeze({
				list: function (params) { return hostCall('history.list', params || {}); },
				get: function (entryId) { return hostCall('history.get', { entryId: entryId }); }
			}),
			notifications: Object.freeze({
				toast: function (message, opts) { return hostCall('notifications.toast', { message: message, opts: opts }); }
			}),
			settings: Object.freeze({
				get: function (key) { return hostCall('settings.get', { key: key }); },
				set: function (key, value) { return hostCall('settings.set', { key: key, value: value }); }
			}),
			sessions: Object.freeze({
				list: function () { return hostCall('sessions.list', {}); },
				get: function (sessionId) { return hostCall('sessions.get', { sessionId: sessionId }); },
				create: function (params) { return hostCall('sessions.create', params || {}); },
				update: function (sessionId, patch) { return hostCall('sessions.update', { sessionId: sessionId, patch: patch }); },
				delete: function (sessionId) { return hostCall('sessions.delete', { sessionId: sessionId }); }
			}),
			transcripts: Object.freeze({
				read: function (params) { return hostCall('transcripts.read', params); },
				append: function (params) { return hostCall('transcripts.append', params); }
			}),
			storage: Object.freeze({
				get: function (key) { return hostCall('storage.get', { key: key }); },
				set: function (key, value) { return hostCall('storage.set', { key: key, value: value }); },
				delete: function (key) { return hostCall('storage.delete', { key: key }); },
				keys: function () { return hostCall('storage.keys', {}); },
				sql: function (query, params) { return hostCall('storage.sql', { query: query, params: params }); }
			}),
			ui: Object.freeze({
				runCommand: function (commandId, args) { return hostCall('ui.runCommand', { commandId: commandId, args: args }); },
				hostView: Object.freeze({
					update: function (id, blocks) { return hostCall('ui.hostViewUpdate', { id: id, blocks: blocks }); },
					remove: function (id) { return hostCall('ui.hostViewRemove', { id: id }); }
				}),
				grouping: Object.freeze({
					publish: function (params) { return hostCall('ui.groupingPublish', params); },
					clear: function (id) { return hostCall('ui.groupingClear', { id: id }); }
				})
			}),
			tabs: Object.freeze({
				list: function () { return hostCall('tabs.list', {}); },
				create: function (params) { return hostCall('tabs.create', params || {}); },
				focus: function (tabId) { return hostCall('tabs.focus', { tabId: tabId }); },
				close: function (tabId) { return hostCall('tabs.close', { tabId: tabId }); }
			}),
			events: Object.freeze({
				on: function (topic, handler) {
					if (typeof topic !== 'string' || typeof handler !== 'function') return;
					var set = eventHandlers.get(topic);
					if (!set) { set = new Set(); eventHandlers.set(topic, set); }
					set.add(handler);
				},
				subscribe: function (topics) { return hostCall('events.subscribe', { topics: topics }); },
				unsubscribe: function (topics) { return hostCall('events.unsubscribe', topics ? { topics: topics } : {}); }
			}),
			commands: Object.freeze({
				register: function (commandId, handler) {
					if (typeof commandId === 'string' && typeof handler === 'function') {
						commandHandlers.set(commandId, handler);
					}
				}
			}),
			tools: Object.freeze({
				register: function (localId, handler) {
					if (typeof localId === 'string' && typeof handler === 'function') {
						commandHandlers.set(localId, handler);
					}
				}
			}),
			shell: Object.freeze({
				openExternal: function (url, opts) { return hostCall('shell.openExternal', { url: url, opts: opts }); }
			}),
			process: Object.freeze({
				spawn: function (command, opts) { return hostCall('process.spawn', { command: command, opts: opts }); }
			}),
			decisions: Object.freeze({
				record: function (decision) { return hostCall('decisions.record', { decision: decision }); }
			}),
			power: Object.freeze({
				preventSleep: function (reason, opts) { return hostCall('power.preventSleep', { reason: reason, opts: opts }); },
				releaseSleep: function (handleId) { return hostCall('power.releaseSleep', { handleId: handleId }); }
			}),
			background: Object.freeze({
				register: function (service) { return hostCall('background.register', { service: service }); },
				unregister: function (serviceId) { return hostCall('background.unregister', { serviceId: serviceId }); },
				list: function () { return hostCall('background.list', {}); }
			})
		};
		if (surfaceFlags.workspace === true) {
			sdk.workspace = Object.freeze({
				publishExternalSessions: function (revision, sessions) { return hostCall('workspace.publishExternalSessions', { revision: revision, sessions: sessions }); },
				setStatus: function (status) { return hostCall('workspace.setStatus', { status: status }); },
				setBadge: function (value) { return hostCall('workspace.setBadge', { value: value }); },
				reveal: function (snapshotToken) { return hostCall('workspace.reveal', { snapshotToken: snapshotToken }); },
				onDidChangeContext: function (listener) {
					if (typeof listener !== 'function') return function () {};
					var topic = '__workspaceContext';
					var set = eventHandlers.get(topic);
					if (!set) { set = new Set(); eventHandlers.set(topic, set); }
					set.add(listener);
					return function () { set.delete(listener); };
				}
			});
		}
		if (surfaceFlags.interactivePanel === true) {
			sdk.interactivePanel = Object.freeze({
				onRequest: function (listener) {
					if (typeof listener !== 'function') return function () {};
					var topic = '__interactivePanelRequest';
					var set = eventHandlers.get(topic);
					if (!set) { set = new Set(); eventHandlers.set(topic, set); }
					set.add(listener);
					return function () { set.delete(listener); };
				},
				resolve: function (requestId, kind, payload) { return hostCall('interactivePanel.resolve', { requestId: requestId, kind: kind, payload: payload }); },
				reject: function (requestId, code) { return hostCall('interactivePanel.reject', { requestId: requestId, code: code }); },
				emit: function (kind, payload, eventSequence) { return hostCall('interactivePanel.emit', { kind: kind, payload: payload, eventSequence: eventSequence }); }
			});
		}
		if (surfaceFlags.interactiveRuntime === true) {
			sdk.interactiveRuntime = Object.freeze({
				requestWorkspaceRoot: function () { return hostCall('interactiveRuntime.requestWorkspaceRoot', {}); },
				startOmpRuntime: function (input) {
					return hostCall('interactiveRuntime.startOmpRuntime', input || {}).then(function (runtime) {
						if (!runtime || typeof runtime.runtimeId !== 'string' || typeof runtime.generation !== 'string') {
							throw new Error('malformed interactive runtime handle');
						}
						var runtimeId = runtime.runtimeId;
						var eventTopic = '__interactiveRuntimeEvent:' + runtimeId;
						return Object.freeze({
							runtimeId: runtimeId,
							generation: BigInt(runtime.generation),
							writeCanonicalJson: function (request) {
								return hostCall('interactiveRuntime.write', { runtimeId: runtimeId, request: request });
							},
							onEvent: function (listener) {
								if (typeof listener !== 'function') return function () {};
								var set = eventHandlers.get(eventTopic);
								if (!set) { set = new Set(); eventHandlers.set(eventTopic, set); }
								var wrapped = function (event) {
									if (event && typeof event === 'object' && typeof event.sequence === 'string' && /^[0-9]+$/.test(event.sequence)) {
										event = Object.freeze({ kind: event.kind, sequence: BigInt(event.sequence), code: event.code, class: event.class });
									}
									listener(event);
								};
								set.add(wrapped);
								return function () { set.delete(wrapped); };
							},
							stop: function (reason) {
								return hostCall('interactiveRuntime.stop', { runtimeId: runtimeId, reason: reason });
							}
						});
					});
				}
			});
		}
		return Object.freeze(sdk);
	}

	// ---- lifecycle -------------------------------------------------------------
	var moduleShim = { exports: {} };
	var sdk = null;

	function init(pluginId, surfaceFlagsJson) {
		var surfaceFlags = {};
		try {
			var parsed = JSON.parse(typeof surfaceFlagsJson === 'string' ? surfaceFlagsJson : '{}');
			if (parsed && typeof parsed === 'object') {
				surfaceFlags.workspace = parsed.workspace === true;
				surfaceFlags.interactivePanel = parsed.interactivePanel === true;
				surfaceFlags.interactiveRuntime = parsed.interactiveRuntime === true;
			}
		} catch (e) {}
		sdk = buildSdk(String(pluginId), surfaceFlags);
		globalThis.maestro = sdk;
		globalThis.module = moduleShim;
		globalThis.exports = moduleShim.exports;
		globalThis.console = sandboxConsole;
		globalThis.setTimeout = sandboxSetTimeout;
		globalThis.clearTimeout = sandboxClearTimeout;
	}

	function activate() {
		var ex = moduleShim.exports;
		if (ex && typeof ex.activate === 'function') {
			try {
				return Promise.resolve(ex.activate(sdk)).catch(function (err) {
					safeLog('error', 'activate() threw: ' + String(err));
				});
			} catch (err) {
				safeLog('error', 'activate() threw: ' + String(err));
			}
		}
		return Promise.resolve();
	}

	function deactivate() {
		var ex = moduleShim.exports;
		if (ex && typeof ex.deactivate === 'function') {
			try {
				return Promise.resolve(ex.deactivate()).catch(function () {});
			} catch (err) { /* deactivate errors are non-fatal */ }
		}
		return Promise.resolve();
	}

	return {
		init: init,
		deliverResponse: deliverResponse,
		deliverEvent: deliverEvent,
		invokeCommand: invokeCommand,
		invokeTool: invokeTool,
		fireTimer: fireTimer,
		activate: activate,
		deactivate: deactivate
	};
})`;

const bootstrapScript = new vm.Script(BOOTSTRAP_SOURCE, {
	filename: 'maestro-sandbox-bootstrap',
});

/** The factory shape the bootstrap script evaluates to inside the context. */
type BootstrapRealm = Omit<SandboxRealm, 'init' | 'runScript'> & {
	init(pluginId: string, surfaceFlagsJson: string): void;
};
type BootstrapFactory = (bridge: RealmBridge) => BootstrapRealm;

/**
 * Create a confined vm realm. Everything plugin code can reach is built inside
 * the context by the bootstrap; `bridge` is closure-captured only.
 */
export function createSandboxRealm(bridge: RealmBridge): SandboxRealm {
	// The context global starts EMPTY: every curated global is assigned by the
	// bootstrap's init() from inside the realm, so nothing on it is host-realm.
	const context = vm.createContext(Object.create(null) as Record<string, unknown>, {
		codeGeneration: { strings: false, wasm: false },
	});
	const factory = bootstrapScript.runInContext(context) as BootstrapFactory;
	const realm = factory(bridge);
	return {
		...realm,
		init(pluginId: string, surfaceFlags: SandboxSurfaceFlags = {}): void {
			realm.init(pluginId, JSON.stringify(surfaceFlags));
		},
		runScript(code: string, filename: string, timeoutMs = 5000): void {
			const script = new vm.Script(code, { filename });
			script.runInContext(context, { timeout: timeoutMs });
		},
	};
}

// ---------------------------------------------------------------------------
// utilityProcess wiring (inert under test: parentPort is absent there)
// ---------------------------------------------------------------------------

let activeRealm: SandboxRealm | undefined;
/** Host-side timer registry backing the realm's numeric-id timer bridge. */
const hostTimers = new Map<number, ReturnType<typeof setTimeout>>();

function log(level: 'info' | 'warn' | 'error', message: string): void {
	parentPort?.postMessage({ kind: 'log', level, message });
}

function makeParentPortBridge(): RealmBridge {
	return {
		send(json: string): void {
			if (!parentPort) throw new Error('sandbox has no parent port');
			parentPort.postMessage(JSON.parse(json));
		},
		log(level, message): void {
			log(level === 'warn' ? 'warn' : level === 'error' ? 'error' : 'info', String(message));
		},
		timerStart(id: number, ms: number): void {
			hostTimers.set(
				id,
				setTimeout(() => {
					hostTimers.delete(id);
					activeRealm?.fireTimer(id);
				}, ms)
			);
		},
		timerClear(id: number): void {
			const handle = hostTimers.get(id);
			hostTimers.delete(id);
			if (handle !== undefined) clearTimeout(handle);
		},
	};
}

/** Boot the plugin: build the realm, install globals, run its code, activate. */
function runPluginCode(
	pluginId: string,
	code: string,
	surfaceFlags: SandboxSurfaceFlags = {}
): void {
	const realm = createSandboxRealm(makeParentPortBridge());
	activeRealm = realm;
	realm.init(pluginId, surfaceFlags);
	realm.runScript(code, `plugin:${pluginId}`);
	void realm.activate();
}

if (parentPort) {
	parentPort.on('message', (event) => {
		const data = event.data;
		if (typeof data !== 'object' || data === null) return;
		const msg = data as Record<string, unknown>;

		// Control messages from the host.
		if (msg.kind === 'init') {
			const control = msg as Extract<HostControlMessage, { kind: 'init' }>;
			if (typeof control.entryCode === 'string') {
				try {
					runPluginCode(control.pluginId, control.entryCode, control.surfaceFlags);
				} catch (err) {
					log('error', `failed to start plugin: ${String(err)}`);
				}
			}
			return;
		}
		if (msg.kind === 'invokeCommand') {
			activeRealm?.invokeCommand(JSON.stringify({ commandId: msg.commandId, args: msg.args }));
			return;
		}
		if (msg.kind === 'invokeTool') {
			const id = typeof msg.id === 'number' ? msg.id : -1;
			const reply = (res: Omit<ToolResult, 'kind' | 'id'>): void => {
				parentPort?.postMessage({ kind: 'toolResult', id, ...res });
			};
			if (!activeRealm) {
				reply({ ok: false, error: 'plugin is not running' });
				return;
			}
			void activeRealm
				.invokeTool(JSON.stringify({ commandId: msg.commandId, args: msg.args }))
				.then((json) => {
					try {
						reply(JSON.parse(json) as Omit<ToolResult, 'kind' | 'id'>);
					} catch {
						reply({ ok: false, error: 'malformed tool result' });
					}
				});
			return;
		}
		if (msg.kind === 'event') {
			activeRealm?.deliverEvent(
				JSON.stringify({ topic: msg.topic, at: msg.at, payload: msg.payload })
			);
			return;
		}
		if (msg.kind === 'shutdown') {
			const done = activeRealm ? activeRealm.deactivate() : Promise.resolve();
			void done.finally(() => process.exit(0));
			return;
		}

		// Otherwise it must be a HostResponse to one of our calls.
		if (typeof msg.id === 'number' && typeof msg.ok === 'boolean' && !isHostMethod(msg.method)) {
			activeRealm?.deliverResponse(JSON.stringify(msg as unknown as HostResponse));
		}
	});
}

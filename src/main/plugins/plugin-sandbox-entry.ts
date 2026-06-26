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
 * host effect regardless of what the plugin code manages to call. This child
 * holds no secrets and no privileged handles; the worst a realm escape buys is
 * the (already untrusted) utilityProcess's own Node context, still firewalled
 * from the host by the broker for anything that touches the user's data.
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

/** Send a brokered host call and await its response. */
function hostCall(method: HostMethod, params: unknown): Promise<unknown> {
	if (!parentPort) return Promise.reject(new Error('sandbox has no parent port'));
	const id = nextId++;
	const request: HostRequest = { id, method, params };
	return new Promise<unknown>((resolve, reject) => {
		pending.set(id, { resolve, reject });
		parentPort.postMessage(request);
	});
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
		notifications: Object.freeze({
			toast: (message: string, opts?: unknown): Promise<void> =>
				call('notifications.toast', { message, opts }) as Promise<void>,
		}),
		settings: Object.freeze({
			get: (key: string): Promise<unknown> => call('settings.get', { key }),
		}),
		process: Object.freeze({
			spawn: (command: string, opts?: unknown): Promise<unknown> =>
				call('process.spawn', { command, opts }),
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

	// Curated globals: pure ECMAScript + a console routed to the host log, the
	// SDK, and the module shim. Everything else (require, process, Buffer,
	// globalThis, setImmediate, etc.) is intentionally omitted.
	const sandboxGlobal: Record<string, unknown> = {
		maestro: sdk,
		module: moduleShim,
		exports: moduleShim.exports,
		console: makeSandboxConsole(),
		setTimeout,
		clearTimeout,
		Promise,
		JSON,
		Math,
		Date,
		Object,
		Array,
		String,
		Number,
		Boolean,
		RegExp,
		Map,
		Set,
		Symbol,
		Error,
		TypeError,
		URL,
		URLSearchParams,
		TextEncoder,
		TextDecoder,
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

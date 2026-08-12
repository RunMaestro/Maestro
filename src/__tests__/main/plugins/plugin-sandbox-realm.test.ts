/**
 * Realm-escape regression suite for the plugin sandbox (FC1 / Option-B gate).
 *
 * INVARIANT UNDER TEST: nothing reachable from plugin code is a host-realm
 * value, so the canonical escape primitive
 *
 *     (reachable).constructor.constructor('return process')()
 *
 * MUST throw for EVERY value reachable on the plugin global - because every
 * reachable function is a CONTEXT function whose Function constructor has
 * string code-generation disabled (`codeGeneration: { strings: false }`).
 * If any host intrinsic leaks onto the plugin surface, its `constructor`
 * chain reaches the HOST Function constructor (which vm cannot disable) and
 * the escape succeeds - this suite then fails the build.
 *
 * The walker runs INSIDE the realm as plugin code - the true attacker
 * position - so the assertion covers the SDK object graph, module/exports,
 * console, timers, globalThis itself, and everything transitively reachable
 * from them (prototypes and property getters included).
 */
import { describe, expect, it, vi } from 'vitest';
import {
	createSandboxRealm,
	type RealmBridge,
	type SandboxRealm,
} from '../../../main/plugins/plugin-sandbox-entry';

function makeBridge(overrides: Partial<RealmBridge> = {}): RealmBridge {
	return {
		send: vi.fn(),
		log: vi.fn(),
		timerStart: vi.fn(),
		timerClear: vi.fn(),
		...overrides,
	};
}

function bootRealm(bridge: RealmBridge = makeBridge()): SandboxRealm {
	const realm = createSandboxRealm(bridge);
	realm.init('escape-probe');
	return realm;
}

/** Plugin-side graph walker. Records every escape success into
 * `globalThis.__findings` (an array of path strings); empty array = safe. */
const WALKER_SOURCE = String.raw`
	var findings = [];
	var visited = new Set();

	function attemptEscape(value, path) {
		try {
			var proc = value.constructor.constructor('return process')();
			if (proc !== undefined && proc !== null) {
				findings.push(path + ' => escaped (got host process)');
			}
		} catch (e) {
			// expected: context Function constructor throws (code generation disabled)
		}
	}

	function walk(value, path, depth) {
		if (value === null || value === undefined) return;
		var t = typeof value;
		if (t !== 'object' && t !== 'function') return;
		if (visited.has(value)) return;
		visited.add(value);
		if (depth > 8) return;

		attemptEscape(value, path);

		var names = [];
		try { names = Object.getOwnPropertyNames(value); } catch (e) { /* opaque */ }
		for (var i = 0; i < names.length; i++) {
			var name = names[i];
			var child;
			try { child = value[name]; } catch (e) { continue; } // throwing getter: unreachable value
			walk(child, path + '.' + name, depth + 1);
		}
		var proto;
		try { proto = Object.getPrototypeOf(value); } catch (e) { proto = null; }
		if (proto) walk(proto, path + '.[[Prototype]]', depth + 1);
	}

	walk(globalThis, 'globalThis', 0);
	walk(globalThis.maestro, 'maestro', 0);
	walk(globalThis.module, 'module', 0);
	walk(globalThis.exports, 'exports', 0);
	walk(globalThis.console, 'console', 0);
	walk(globalThis.setTimeout, 'setTimeout', 0);
	walk(globalThis.clearTimeout, 'clearTimeout', 0);

	globalThis.__findings = findings;
`;

describe('plugin sandbox realm - escape regression (FC1)', () => {
	it('constructor-chain escape throws for every value reachable from plugin code', () => {
		const bridge = makeBridge();
		const realm = bootRealm(bridge);
		realm.runScript(WALKER_SOURCE, 'escape-walker');
		realm.runScript(
			String.raw`console.log(JSON.stringify(globalThis.__findings));`,
			'escape-report'
		);
		const logged = (bridge.log as ReturnType<typeof vi.fn>).mock.calls
			.filter(([level]) => level === 'info')
			.map(([, message]) => String(message));
		expect(logged).toHaveLength(1);
		expect(JSON.parse(logged[0])).toEqual([]);
	});

	it('in-realm eval and Function(string) compilation throw (codeGeneration.strings=false)', () => {
		const bridge = makeBridge();
		const realm = bootRealm(bridge);
		realm.runScript(
			String.raw`
				var results = [];
				try { eval('1 + 1'); results.push('eval allowed'); } catch (e) { }
				try { new Function('return 1')(); results.push('Function allowed'); } catch (e) { }
				try {
					var F = (function () {}).constructor;
					new F('return 1')();
					results.push('fn.constructor allowed');
				} catch (e) { }
				console.log(JSON.stringify(results));
			`,
			'codegen-probe'
		);
		const logged = (bridge.log as ReturnType<typeof vi.fn>).mock.calls
			.filter(([level]) => level === 'info')
			.map(([, message]) => String(message));
		expect(JSON.parse(logged[0])).toEqual([]);
	});

	it('WASM compilation is unavailable or throws (codeGeneration.wasm=false)', () => {
		const bridge = makeBridge();
		const realm = bootRealm(bridge);
		realm.runScript(
			String.raw`
				var blocked = true;
				if (typeof WebAssembly !== 'undefined') {
					try {
						// Smallest valid wasm module header; compilation must be denied.
						new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
						blocked = false;
					} catch (e) { }
				}
				console.log(JSON.stringify({ blocked: blocked }));
			`,
			'wasm-probe'
		);
		const logged = (bridge.log as ReturnType<typeof vi.fn>).mock.calls
			.filter(([level]) => level === 'info')
			.map(([, message]) => String(message));
		expect(JSON.parse(logged[0])).toEqual({ blocked: true });
	});

	it('host bridge functions are not reachable as properties from plugin code', () => {
		const bridge = makeBridge();
		const realm = bootRealm(bridge);
		realm.runScript(
			String.raw`
				var hits = [];
				['bridge', 'bridgeSend', 'bridgeLog', 'send', 'hostCall', '__host'].forEach(function (name) {
					if (name in globalThis) hits.push(name);
				});
				console.log(JSON.stringify(hits));
			`,
			'bridge-probe'
		);
		const logged = (bridge.log as ReturnType<typeof vi.fn>).mock.calls
			.filter(([level]) => level === 'info')
			.map(([, message]) => String(message));
		expect(JSON.parse(logged[0])).toEqual([]);
	});

	it('require/process/Buffer/globalThis-host are absent from the realm', () => {
		const bridge = makeBridge();
		const realm = bootRealm(bridge);
		realm.runScript(
			String.raw`
				var present = [];
				['require', 'process', 'Buffer', 'global'].forEach(function (name) {
					if (typeof globalThis[name] !== 'undefined') present.push(name);
				});
				console.log(JSON.stringify(present));
			`,
			'node-globals-probe'
		);
		const logged = (bridge.log as ReturnType<typeof vi.fn>).mock.calls
			.filter(([level]) => level === 'info')
			.map(([, message]) => String(message));
		expect(JSON.parse(logged[0])).toEqual([]);
	});
});

describe('plugin sandbox realm - behavioral parity', () => {
	it('SDK calls round-trip through the bridge as JSON and resolve in-realm', async () => {
		const sent: string[] = [];
		const bridge = makeBridge({ send: vi.fn((json: string) => sent.push(json)) });
		const realm = bootRealm(bridge);
		realm.runScript(
			String.raw`
				module.exports = {
					activate: function (maestro) {
						return maestro.storage.get('greeting').then(function (value) {
							console.log('got:' + value);
						});
					}
				};
			`,
			'sdk-roundtrip'
		);
		const activated = realm.activate();
		expect(sent).toHaveLength(1);
		const request = JSON.parse(sent[0]) as { id: number; method: string; params: unknown };
		expect(request.method).toBe('storage.get');
		expect(request.params).toEqual({ key: 'greeting' });
		realm.deliverResponse(JSON.stringify({ id: request.id, ok: true, result: 'hello' }));
		await activated;
		await vi.waitFor(() => {
			const infos = (bridge.log as ReturnType<typeof vi.fn>).mock.calls.filter(
				([level]) => level === 'info'
			);
			expect(infos.map(([, m]) => String(m))).toContain('got:hello');
		});
	});

	it('rejected host responses surface as in-realm Errors with the host message', async () => {
		const sent: string[] = [];
		const bridge = makeBridge({ send: vi.fn((json: string) => sent.push(json)) });
		const realm = bootRealm(bridge);
		realm.runScript(
			String.raw`
				module.exports = {
					activate: function (maestro) {
						return maestro.fs.read('/etc/passwd').catch(function (err) {
							console.log('denied:' + err.message);
						});
					}
				};
			`,
			'denial-roundtrip'
		);
		const activated = realm.activate();
		const request = JSON.parse(sent[0]) as { id: number };
		realm.deliverResponse(
			JSON.stringify({ id: request.id, ok: false, error: 'capability denied' })
		);
		await activated;
		await vi.waitFor(() => {
			const infos = (bridge.log as ReturnType<typeof vi.fn>).mock.calls.filter(
				([level]) => level === 'info'
			);
			expect(infos.map(([, m]) => String(m))).toContain('denied:capability denied');
		});
	});

	it('commands registered in-realm are invocable and tools resolve JSON results', async () => {
		const realm = bootRealm();
		realm.runScript(
			String.raw`
				module.exports = { activate: function (maestro) {
					maestro.commands.register('ping', function (args) { return { pong: args }; });
				} };
			`,
			'tool-registration'
		);
		await realm.activate();
		const result = await realm.invokeTool(JSON.stringify({ commandId: 'ping', args: { n: 7 } }));
		expect(JSON.parse(result)).toEqual({ ok: true, result: { pong: { n: 7 } } });
		const missing = await realm.invokeTool(JSON.stringify({ commandId: 'nope', args: null }));
		expect(JSON.parse(missing).ok).toBe(false);
	});

	it('events fan out to in-realm handlers with parsed context-realm payloads', async () => {
		const bridge = makeBridge();
		const realm = bootRealm(bridge);
		realm.runScript(
			String.raw`
				module.exports = { activate: function (maestro) {
					maestro.events.on('agent.completed', function (payload, meta) {
						console.log('evt:' + meta.topic + ':' + payload.sessionId);
					});
				} };
			`,
			'event-handlers'
		);
		await realm.activate();
		realm.deliverEvent(
			JSON.stringify({
				topic: 'agent.completed',
				at: '2026-07-01T00:00:00Z',
				payload: { sessionId: 's-1' },
			})
		);
		await vi.waitFor(() => {
			const infos = (bridge.log as ReturnType<typeof vi.fn>).mock.calls.filter(
				([level]) => level === 'info'
			);
			expect(infos.map(([, m]) => String(m))).toContain('evt:agent.completed:s-1');
		});
	});

	it('timers allocate numeric ids via the bridge and fire in-realm callbacks', () => {
		const bridge = makeBridge();
		const realm = bootRealm(bridge);
		realm.runScript(
			String.raw`
				var id = setTimeout(function () { console.log('timer fired'); }, 50);
				console.log('timer id type:' + typeof id);
			`,
			'timer-probe'
		);
		expect(bridge.timerStart).toHaveBeenCalledWith(expect.any(Number), 50);
		const [id] = (bridge.timerStart as ReturnType<typeof vi.fn>).mock.calls[0] as [number, number];
		realm.fireTimer(id);
		const infos = (bridge.log as ReturnType<typeof vi.fn>).mock.calls
			.filter(([level]) => level === 'info')
			.map(([, m]) => String(m));
		expect(infos).toContain('timer id type:number');
		expect(infos).toContain('timer fired');
	});

	it('the SDK surface is frozen - plugin code cannot mutate or extend it', () => {
		const bridge = makeBridge();
		const realm = bootRealm(bridge);
		realm.runScript(
			String.raw`
				var mutations = [];
				try { maestro.fs.read = function () { return 'pwned'; }; } catch (e) { }
				if (String(maestro.fs.read).indexOf('pwned') !== -1) mutations.push('fs.read replaced');
				try { maestro.evil = true; } catch (e) { }
				if (maestro.evil) mutations.push('property added');
				console.log(JSON.stringify(mutations));
			`,
			'freeze-probe'
		);
		const logged = (bridge.log as ReturnType<typeof vi.fn>).mock.calls
			.filter(([level]) => level === 'info')
			.map(([, message]) => String(message));
		expect(JSON.parse(logged[0])).toEqual([]);
	});

	it('maestro.background.list is exposed and routes to background.list', () => {
		const sent: string[] = [];
		const bridge = makeBridge({ send: vi.fn((json: string) => sent.push(json)) });
		const realm = bootRealm(bridge);
		realm.runScript(String.raw`void maestro.background.list();`, 'bg-list-probe');
		expect(sent).toHaveLength(1);
		expect(JSON.parse(sent[0]).method).toBe('background.list');
	});

	it('maestro.ui.hostView exposes frozen update/remove forwarders', () => {
		const sent: string[] = [];
		const bridge = makeBridge({ send: vi.fn((json: string) => sent.push(json)) });
		const realm = bootRealm(bridge);
		realm.runScript(
			String.raw`
				void maestro.ui.hostView.update('status', [{ kind: 'text', text: 'Ready' }]);
				void maestro.ui.hostView.remove('status');
			`,
			'host-view-probe'
		);
		expect(sent.map((json) => JSON.parse(json))).toMatchObject([
			{
				method: 'ui.hostViewUpdate',
				params: { id: 'status', blocks: [{ kind: 'text', text: 'Ready' }] },
			},
			{ method: 'ui.hostViewRemove', params: { id: 'status' } },
		]);
	});
});

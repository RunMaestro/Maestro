/**
 * Realm-escape regression suite for the plugin sandbox (FC1 / Option-B gate).
 *
 * INVARIANT UNDER TEST: nothing reachable from plugin code is a host-realm
 * value, so the canonical escape primitive
 *
 *     (reachable).constructor.constructor('return process')()
 *
 * MUST throw for EVERY value reachable on the plugin global — because every
 * reachable function is a CONTEXT function whose Function constructor has
 * string code-generation disabled (`codeGeneration: { strings: false }`).
 * If any host intrinsic leaks onto the plugin surface, its `constructor`
 * chain reaches the HOST Function constructor (which vm cannot disable) and
 * the escape succeeds — this suite then fails the build.
 *
 * The walker runs INSIDE the realm as plugin code — the true attacker
 * position — so the assertion covers the SDK object graph, module/exports,
 * console, timers, globalThis itself, and everything transitively reachable
 * from them (prototypes and property getters included).
 */
import { describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { bundleOmpPlugin } from '../../../main/omp-distribution/bundle-plugin';
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

function runtimeWriteRequest(params: unknown): { readonly id: string; readonly type: string } {
	if (!isRecord(params) || !isRecord(params.request))
		throw new Error('invalid runtime write request');
	if (typeof params.request.id !== 'string' || typeof params.request.type !== 'string')
		throw new Error('runtime write request lacks id or type');
	return { id: params.request.id, type: params.request.type };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function createBundledOmpFixture(): Promise<{ readonly runtimeSource: string }> {
	const bundle = await bundleOmpPlugin(resolve(process.cwd(), 'plugins/com.maestro.omp'));
	const runtime = bundle.files.find((file) => file.path === 'dist/runtime.js');
	const panel = bundle.files.find((file) => file.path === 'dist/panel.html');
	if (!runtime || !panel) throw new Error('OMP bundle omitted a sandbox entry');
	const runtimeSource = new TextDecoder().decode(runtime.content);
	const panelSource = new TextDecoder().decode(panel.content);
	for (const source of [runtimeSource, panelSource]) {
		expect(source).not.toMatch(/["']node:/);
		expect(source).not.toMatch(/\brequire\s*\(/);
		expect(source).not.toMatch(/\bBuffer(?:\.|\()/);
		expect(source).not.toMatch(/\bprocess(?:\.|\[)/);
		expect(source).not.toMatch(/\bmodule\.require\b/);
	}
	return { runtimeSource };
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

describe('plugin sandbox realm — escape regression (FC1)', () => {
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

	it('exposes each optional workspace surface only when host-derived flags allow it', () => {
		const bridge = makeBridge();
		const realm = createSandboxRealm(bridge);
		realm.init('surface-probe', {
			workspace: true,
			interactivePanel: true,
			interactiveRuntime: true,
		});
		realm.runScript(
			String.raw`
				console.log(JSON.stringify({
					workspace: typeof maestro.workspace,
					panel: typeof maestro.interactivePanel,
					runtime: typeof maestro.interactiveRuntime,
					frozen: Object.isFrozen(maestro.workspace) &&
						Object.isFrozen(maestro.interactivePanel) &&
						Object.isFrozen(maestro.interactiveRuntime)
				}));
			`,
			'optional-surface-probe'
		);
		const logged = (bridge.log as ReturnType<typeof vi.fn>).mock.calls
			.filter(([level]) => level === 'info')
			.map(([, message]) => String(message));
		expect(JSON.parse(logged[0])).toEqual({
			workspace: 'object',
			panel: 'object',
			runtime: 'object',
			frozen: true,
		});
	});
});

describe('plugin sandbox realm — behavioral parity', () => {
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
	it('retains an initial interactive panel get_snapshot request until activation registers its listener', async () => {
		const sent: Array<{ id: number; method: string; params: unknown }> = [];
		const bridge = makeBridge({
			send: vi.fn((json: string) =>
				sent.push(JSON.parse(json) as { id: number; method: string; params: unknown })
			),
		});
		const realm = createSandboxRealm(bridge);
		realm.init('panel-race', { workspace: true, interactivePanel: true });
		realm.runScript(
			String.raw`
				module.exports = {
					activate: async function (maestro) {
						await maestro.workspace.setBadge(null);
						maestro.interactivePanel.onRequest(function (request) {
							return maestro.interactivePanel.resolve(request.requestId, request.kind, { ready: true });
						});
					}
				};
			`,
			'panel-race.js'
		);
		const activation = realm.activate();
		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]).toMatchObject({ method: 'workspace.setBadge', params: { value: null } });

		realm.deliverEvent(
			JSON.stringify({
				topic: '__interactivePanelRequest',
				at: '2026-07-13T00:00:00.000Z',
				payload: { requestId: 'request-1', kind: 'get_snapshot', payload: {} },
			})
		);
		realm.deliverResponse(JSON.stringify({ id: sent[0]!.id, ok: true, result: null }));
		await activation;

		await vi.waitFor(() => expect(sent).toHaveLength(2));
		expect(sent[1]).toMatchObject({
			method: 'interactivePanel.resolve',
			params: { requestId: 'request-1', kind: 'get_snapshot', payload: { ready: true } },
		});
	});

	it('delivers pre-listener interactive panel requests once in FIFO order', async () => {
		const bridge = makeBridge();
		const realm = createSandboxRealm(bridge);
		realm.init('panel-queue', { interactivePanel: true });
		for (const requestId of ['request-1', 'request-2']) {
			realm.deliverEvent(
				JSON.stringify({
					topic: '__interactivePanelRequest',
					at: '2026-07-13T00:00:00.000Z',
					payload: { requestId, kind: 'get_snapshot', payload: {} },
				})
			);
		}
		realm.runScript(
			String.raw`
				maestro.interactivePanel.onRequest(function (request) {
					console.log('request:' + request.requestId);
				});
			`,
			'panel-queue.js'
		);
		await vi.waitFor(() =>
			expect(vi.mocked(bridge.log).mock.calls).toEqual(
				expect.arrayContaining([
					['info', 'request:request-1'],
					['info', 'request:request-2'],
				])
			)
		);
		expect(vi.mocked(bridge.log).mock.calls.filter(([level]) => level === 'info')).toEqual([
			['info', 'request:request-1'],
			['info', 'request:request-2'],
		]);
	});

	it('rejects overflowed pre-listener interactive panel requests instead of dropping them', async () => {
		const sent: Array<{ id: number; method: string; params: Record<string, unknown> }> = [];
		const bridge = makeBridge({
			send: vi.fn((json: string) =>
				sent.push(
					JSON.parse(json) as { id: number; method: string; params: Record<string, unknown> }
				)
			),
		});
		const realm = createSandboxRealm(bridge);
		realm.init('panel-overflow', { interactivePanel: true });
		for (let index = 1; index <= 33; index += 1) {
			realm.deliverEvent(
				JSON.stringify({
					topic: '__interactivePanelRequest',
					at: '2026-07-13T00:00:00.000Z',
					payload: { requestId: `request-${index}`, kind: 'get_snapshot', payload: {} },
				})
			);
		}
		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]).toMatchObject({
			method: 'interactivePanel.reject',
			params: { requestId: 'request-33', code: 'backpressure' },
		});
	});

	it('rejects panel requests after the first listener is revoked rather than retaining them again', async () => {
		const sent: Array<{ id: number; method: string; params: Record<string, unknown> }> = [];
		const bridge = makeBridge({
			send: vi.fn((json: string) =>
				sent.push(
					JSON.parse(json) as { id: number; method: string; params: Record<string, unknown> }
				)
			),
		});
		const realm = createSandboxRealm(bridge);
		realm.init('panel-revoke', { interactivePanel: true });
		realm.runScript(
			String.raw`
				var revoke = maestro.interactivePanel.onRequest(function () {});
				revoke();
			`,
			'panel-revoke.js'
		);
		realm.deliverEvent(
			JSON.stringify({
				topic: '__interactivePanelRequest',
				at: '2026-07-13T00:00:00.000Z',
				payload: { requestId: 'request-after-revoke', kind: 'get_snapshot', payload: {} },
			})
		);
		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]).toMatchObject({
			method: 'interactivePanel.reject',
			params: { requestId: 'request-after-revoke', code: 'capability_unavailable' },
		});
	});

	it('rejects retained interactive panel requests when the sandbox tears down', async () => {
		const sent: Array<{ id: number; method: string; params: Record<string, unknown> }> = [];
		const bridge = makeBridge({
			send: vi.fn((json: string) =>
				sent.push(
					JSON.parse(json) as { id: number; method: string; params: Record<string, unknown> }
				)
			),
		});
		const realm = createSandboxRealm(bridge);
		realm.init('panel-teardown', { interactivePanel: true });
		realm.deliverEvent(
			JSON.stringify({
				topic: '__interactivePanelRequest',
				at: '2026-07-13T00:00:00.000Z',
				payload: { requestId: 'request-1', kind: 'get_snapshot', payload: {} },
			})
		);
		await realm.deactivate();
		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]).toMatchObject({
			method: 'interactivePanel.reject',
			params: { requestId: 'request-1', code: 'capability_unavailable' },
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

	it('the SDK surface is frozen — plugin code cannot mutate or extend it', () => {
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
	it('exposes owner-bound interactive runtime stdout messages without accepting a mismatched generation', async () => {
		const sent: string[] = [];
		const bridge = makeBridge({ send: vi.fn((json: string) => sent.push(json)) });
		const realm = createSandboxRealm(bridge);
		realm.init('plugin-a', { interactiveRuntime: true });
		realm.runScript(
			[
				'maestro.interactiveRuntime.startOmpRuntime({}).then(function (runtime) {',
				'  runtime.onMessage(function (message) { console.log("message:" + message.sequence + ":" + message.value.result); });',
				'});',
			].join('\n'),
			'interactive-runtime-message.js'
		);
		await vi.waitFor(() => expect(sent).toHaveLength(1));
		const rawStart: unknown = JSON.parse(sent[0] ?? '{}');
		if (
			!rawStart ||
			typeof rawStart !== 'object' ||
			!('id' in rawStart) ||
			typeof rawStart.id !== 'number'
		) {
			throw new Error('missing runtime start request');
		}
		realm.deliverResponse(
			JSON.stringify({
				id: rawStart.id,
				ok: true,
				result: { runtimeId: 'runtime-1', generation: '5' },
			})
		);
		await Promise.resolve();
		await Promise.resolve();
		realm.deliverEvent(
			JSON.stringify({
				topic: '__interactiveRuntimeMessage:runtime-1',
				at: '2026-01-01T00:00:00.000Z',
				payload: {
					runtimeId: 'runtime-1',
					generation: '5',
					message: { sequence: 1, value: { result: 'ok' } },
				},
			})
		);
		await vi.waitFor(() =>
			expect(vi.mocked(bridge.log).mock.calls).toContainEqual(['info', 'message:1:ok'])
		);
		realm.deliverEvent(
			JSON.stringify({
				topic: '__interactiveRuntimeMessage:runtime-1',
				at: '2026-01-01T00:00:00.000Z',
				payload: {
					runtimeId: 'runtime-1',
					generation: '6',
					message: { sequence: 2, value: { result: 'leak' } },
				},
			})
		);
		expect(vi.mocked(bridge.log).mock.calls).not.toContainEqual(['info', 'message:2:leak']);
	});

	it('serializes only bounded canonical decimal panel event sequences', async () => {
		const sent: Array<{ id: number; method: string; params: unknown }> = [];
		const bridge = makeBridge({
			send: vi.fn((json: string) =>
				sent.push(JSON.parse(json) as { id: number; method: string; params: unknown })
			),
		});
		const realm = createSandboxRealm(bridge);
		realm.init('panel-sequence', { interactivePanel: true });
		realm.runScript(
			'void maestro.interactivePanel.emit("omp.view.replace", {}, 1n);',
			'panel-sequence-valid'
		);
		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]).toMatchObject({
			method: 'interactivePanel.emit',
			params: { eventSequence: '1' },
		});
		realm.deliverResponse(JSON.stringify({ id: sent[0]!.id, ok: true, result: null }));

		realm.runScript(
			'void maestro.interactivePanel.emit("omp.view.replace", {}, 0n).catch(function (error) { console.log(error.message); });',
			'panel-sequence-zero'
		);
		realm.runScript(
			'void maestro.interactivePanel.emit("omp.view.replace", {}, 9223372036854775808n).catch(function (error) { console.log(error.message); });',
			'panel-sequence-overflow'
		);
		await vi.waitFor(() =>
			expect(vi.mocked(bridge.log).mock.calls).toEqual(
				expect.arrayContaining([
					['info', 'invalid panel event sequence'],
					['info', 'invalid panel event sequence'],
				])
			)
		);
		expect(sent).toHaveLength(1);
	});
});

describe('signed OMP artifact sandbox smoke', () => {
	it('activates the packaged CJS runtime through derived surfaces and only starts after explicit action', async () => {
		const sent: Array<{ id: number; method: string; params: unknown }> = [];
		const bridge = makeBridge({
			send: vi.fn((json: string) =>
				sent.push(JSON.parse(json) as { id: number; method: string; params: unknown })
			),
		});
		const { runtimeSource } = await createBundledOmpFixture();

		const realm = createSandboxRealm(bridge);
		realm.init('com.maestro.omp', {
			workspace: true,
			interactivePanel: true,
			interactiveRuntime: true,
		});
		realm.runScript(runtimeSource, 'omp-runtime.js');
		const activation = realm.activate();

		for (const [method, result] of [
			['workspace.publishExternalSessions', null],
			['workspace.setStatus', null],
			['workspace.setBadge', null],
		] as const) {
			await vi.waitFor(() =>
				expect(sent).toHaveLength(sent.findIndex((call) => call.method === method) + 1)
			);
			const call = sent[sent.length - 1];
			expect(call.method).toBe(method);
			realm.deliverResponse(JSON.stringify({ id: call.id, ok: true, result }));
		}
		await activation;
		expect(sent.map((call) => call.method)).toEqual([
			'workspace.publishExternalSessions',
			'workspace.setStatus',
			'workspace.setBadge',
		]);

		realm.runScript(
			'void module.exports.startFromExplicitPanelAction().then(function (started) { console.log(\"started:\" + started); });',
			'omp-explicit-start.js'
		);
		await vi.waitFor(() => expect(sent).toHaveLength(4));
		expect(sent[3]).toMatchObject({ method: 'interactiveRuntime.requestWorkspaceRoot' });
		realm.deliverResponse(JSON.stringify({ id: sent[3].id, ok: true, result: { token: 'root' } }));
		let nextCall = 4;
		let runtimeStartCall: (typeof sent)[number] | undefined;
		await vi.waitFor(() => {
			while (nextCall < sent.length) {
				const call = sent[nextCall++];
				if (call?.method === 'interactiveRuntime.startOmpRuntime') {
					runtimeStartCall = call;
					return;
				}
				if (call?.method !== 'workspace.setStatus')
					throw new Error('unexpected explicit-start call');
				realm.deliverResponse(JSON.stringify({ id: call.id, ok: true, result: null }));
			}
			throw new Error('waiting for runtime start');
		});
		if (!runtimeStartCall) throw new Error('missing runtime start');
		expect(runtimeStartCall).toMatchObject({
			method: 'interactiveRuntime.startOmpRuntime',
			params: { workspaceRoot: { token: 'root' }, options: { restore: false } },
		});
		realm.deliverResponse(
			JSON.stringify({
				id: runtimeStartCall.id,
				ok: true,
				result: { runtimeId: 'runtime-1', generation: '1' },
			})
		);
		let runtimeSequence = 1;
		await vi.waitFor(() => {
			expect(sent[nextCall]).toMatchObject({ method: 'interactiveRuntime.hostTools' });
		});
		const hostToolsCall = sent[nextCall++];
		if (!hostToolsCall) throw new Error('missing host tool catalog request');
		realm.deliverResponse(
			JSON.stringify({
				id: hostToolsCall.id,
				ok: true,
				result: [
					{
						name: 'maestro.workspace.read',
						description: 'Read a host-approved workspace file.',
						parameters: { type: 'object', additionalProperties: false },
					},
				],
			})
		);
		await Promise.resolve();
		realm.deliverEvent(
			JSON.stringify({
				topic: '__interactiveRuntimeMessage:runtime-1',
				at: '2026-01-01T00:00:00.000Z',
				payload: {
					runtimeId: 'runtime-1',
					generation: '1',
					message: { sequence: 1, value: { type: 'ready', version: '16.4.8' } },
				},
			})
		);
		for (let initialized = 0; initialized < 5; initialized++) {
			await vi.waitFor(() => {
				const call = sent[nextCall];
				if (!call) throw new Error('waiting for controller initialization write');
				expect(call.method).toBe('interactiveRuntime.write');
			});
			const call = sent[nextCall++];
			if (!call) throw new Error('missing controller initialization write');
			const request = runtimeWriteRequest(call.params);
			let data: unknown;
			switch (request.type) {
				case 'get_state':
					data = {
						sessionId: 'session-1',
						isStreaming: false,
						isCompacting: false,
						steeringMode: 'all',
						followUpMode: 'all',
						interruptMode: 'immediate',
						autoCompactionEnabled: false,
						messageCount: 0,
						queuedMessageCount: 0,
						todoPhases: [],
					};
					break;
				case 'get_available_commands':
					data = { commands: [] };
					break;
				case 'get_available_models':
					data = { models: [] };
					break;
				case 'set_host_tools':
				case 'set_host_uri_schemes':
					data = undefined;
					break;
				default:
					throw new Error(`unexpected controller initialization command ${request.type}`);
			}
			realm.deliverEvent(
				JSON.stringify({
					topic: '__interactiveRuntimeMessage:runtime-1',
					at: '2026-01-01T00:00:00.000Z',
					payload: {
						runtimeId: 'runtime-1',
						generation: '1',
						message: {
							sequence: ++runtimeSequence,
							value: {
								type: 'response',
								id: request.id,
								command: request.type,
								success: true,
								...(data === undefined ? {} : { data }),
							},
						},
					},
				})
			);
			realm.deliverResponse(JSON.stringify({ id: call.id, ok: true, result: null }));
		}
		for (const expectedMethod of [
			'workspace.publishExternalSessions',
			'workspace.setStatus',
			'workspace.setBadge',
			'interactivePanel.emit',
		]) {
			await vi.waitFor(() => {
				const call = sent[nextCall];
				if (!call) throw new Error(`waiting for ${expectedMethod}`);
				expect(call.method).toBe(expectedMethod);
			});
			const call = sent[nextCall++];
			if (!call) throw new Error(`missing ${expectedMethod}`);
			if (expectedMethod === 'workspace.setStatus') {
				expect(call).toMatchObject({
					params: { status: { state: 'ready', label: 'OMP ready' } },
				});
			}
			realm.deliverResponse(JSON.stringify({ id: call.id, ok: true, result: null }));
		}
		await vi.waitFor(() => {
			expect(vi.mocked(bridge.log).mock.calls).toContainEqual(['info', 'started:true']);
		});

		const deactivation = realm.deactivate();
		let stopCall: (typeof sent)[number] | undefined;
		await vi.waitFor(() => {
			stopCall = sent.slice(nextCall).find((call) => call.method === 'interactiveRuntime.stop');
			if (!stopCall) throw new Error('waiting for runtime stop');
		});
		if (!stopCall) throw new Error('missing runtime stop');
		expect(stopCall).toMatchObject({
			method: 'interactiveRuntime.stop',
			params: { runtimeId: 'runtime-1', reason: 'workspace-deactivated' },
		});
		realm.deliverResponse(JSON.stringify({ id: stopCall.id, ok: true, result: null }));
		nextCall = sent.indexOf(stopCall) + 1;
		for (const expectedMethod of [
			'workspace.publishExternalSessions',
			'workspace.setStatus',
			'workspace.setBadge',
		]) {
			await vi.waitFor(() => {
				const call = sent[nextCall];
				if (!call) throw new Error(`waiting for ${expectedMethod}`);
				expect(call.method).toBe(expectedMethod);
			});
			const call = sent[nextCall++];
			if (!call) throw new Error(`missing ${expectedMethod}`);
			realm.deliverResponse(JSON.stringify({ id: call.id, ok: true, result: null }));
		}
		await deactivation;
	});
});

// Source: src/__tests__/main/plugins/plugin-agent-session-bindings.test.ts
// Source: src/__tests__/main/plugins/plugin-confirmation-security.test.ts
// Source: src/__tests__/main/plugins/plugin-sandbox-realm.test.ts
// Source: src/__tests__/main/plugins/plugin-service-host.test.ts
import { describe as describeSourceSuite } from 'vitest';
import { afterEach } from 'vitest';
import { beforeEach } from 'vitest';
import { describe } from 'vitest';
import { expect } from 'vitest';
import { it } from 'vitest';
import { vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PluginAgentSessionBindings } from '../../../main/plugins/plugin-agent-session-bindings';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import { PluginConfirmationWindows } from '../../../main/plugins/plugin-confirmation-window';
import { createSandboxRealm } from '../../../main/plugins/plugin-sandbox-entry';
import type { RealmBridge } from '../../../main/plugins/plugin-sandbox-entry';
import type { SandboxRealm } from '../../../main/plugins/plugin-sandbox-entry';
import { PluginServiceHost } from '../../../main/plugins/plugin-service-host';
import { TRANSCRIPTION_CONTRACT } from '../../../shared/plugins/services';
import { SERVICE_LIMITS } from '../../../shared/plugins/services';
import { validatePluginManifest } from '../../../shared/plugins/plugin-manifest';
import type { PluginManifest } from '../../../shared/plugins/plugin-manifest';
import { grantsFromRequests } from '../../../shared/plugins/permissions';
import { isPermitted } from '../../../shared/plugins/permissions';
import type { PluginMediaTools } from '../../../main/plugins/plugin-media-tools';
import type { MediaServiceLease } from '../../../main/plugins/plugin-media-tools';
const { failRename } = vi.hoisted(() => ({ failRename: { current: false } }));
vi.mock('fs', async (importOriginal) => {
	const actual = await importOriginal<typeof import('fs')>();
	return {
		...actual,
		renameSync: (...args: Parameters<typeof actual.renameSync>) => {
			if (failRename.current) throw new Error('simulated rename failure');
			return actual.renameSync(...args);
		},
	};
});
const { ipc, windows } = vi.hoisted(() => ({
	ipc: new Map<string, Function>(),
	windows: [] as any[],
}));
vi.mock('electron', () => ({
	ipcMain: { handle: (name: string, fn: Function) => ipc.set(name, fn) },
	BrowserWindow: class extends EventEmitter {
		webContents = Object.assign(new EventEmitter(), {
			id: 1,
			mainFrame: { routingId: 42, url: '' },
			setWindowOpenHandler() {},
		});
		destroyed = false;
		focused = true;
		constructor(public options: any) {
			super();
			windows.push(this);
		}
		setMenu() {}
		async loadFile(filename: string) {
			this.webContents.mainFrame.url = pathToFileURL(filename).href;
		}
		show() {}
		isFocused() {
			return this.focused;
		}
		isDestroyed() {
			return this.destroyed;
		}
		close() {
			if (!this.destroyed) {
				this.destroyed = true;
				this.emit('closed');
			}
		}
	},
}));
describeSourceSuite('plugin-agent-session-bindings', () => {
	describe('plugin provider session bindings', () => {
		let baseDir: string;

		beforeEach(() => {
			failRename.current = false;
			baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-plugin-sessions-'));
		});
		afterEach(() => {
			failRename.current = false;
			fs.rmSync(baseDir, { recursive: true, force: true });
		});

		it('persists ownership across host restarts and confines it to plugin and agent', () => {
			const first = new PluginAgentSessionBindings(baseDir);
			first.remember('relay', 'agent-a', 'provider-1');
			const restarted = new PluginAgentSessionBindings(baseDir);
			expect(() => restarted.assertOwned('relay', 'agent-a', 'provider-1')).not.toThrow();
			expect(restarted.hasBindings('relay')).toBe(true);
			expect(restarted.isOwned('relay', 'agent-a', 'provider-1')).toBe(true);
			expect(restarted.isOwned('relay', 'agent-b', 'provider-1')).toBe(false);
			expect(restarted.isOwned('other', 'agent-a', 'provider-1')).toBe(false);
			expect(() => restarted.assertOwned('relay', 'agent-b', 'provider-1')).toThrow(/not owned/);
			expect(() => restarted.assertOwned('other', 'agent-a', 'provider-1')).toThrow(/not owned/);
			expect(() => restarted.assertOwned('relay', 'agent-a', 'unknown')).toThrow(/not owned/);
			expect(() => restarted.remember('relay', 'agent-b', 'provider-1')).toThrow(/another agent/);
		});

		it('removes bindings on plugin uninstall', () => {
			const bindings = new PluginAgentSessionBindings(baseDir);
			bindings.remember('relay', 'agent-a', 'provider-1');
			bindings.purge('relay');
			expect(bindings.hasBindings('relay')).toBe(false);
			expect(() => bindings.assertOwned('relay', 'agent-a', 'provider-1')).toThrow(/not owned/);
		});

		it('evicts the oldest binding when full and keeps the completed session resumable', () => {
			const bindings = new PluginAgentSessionBindings(baseDir, 2);
			bindings.remember('relay', 'agent-a', 'provider-1');
			bindings.remember('relay', 'agent-b', 'provider-2');
			bindings.remember('relay', 'agent-a', 'provider-3');
			expect(() => bindings.assertOwned('relay', 'agent-a', 'provider-1')).toThrow(/not owned/);
			expect(() => bindings.assertOwned('relay', 'agent-b', 'provider-2')).not.toThrow();
			expect(() => bindings.assertOwned('relay', 'agent-a', 'provider-3')).not.toThrow();
			expect(() => bindings.assertOwned('relay', 'agent-b', 'provider-3')).toThrow(/not owned/);
		});

		it('keeps a resumed binding among the newest across host restarts', () => {
			const bindings = new PluginAgentSessionBindings(baseDir, 2);
			bindings.remember('relay', 'agent-a', 'provider-1');
			bindings.remember('relay', 'agent-b', 'provider-2');
			bindings.remember('relay', 'agent-a', 'provider-1');
			bindings.remember('relay', 'agent-c', 'provider-3');
			const restarted = new PluginAgentSessionBindings(baseDir, 2);
			expect(() => restarted.assertOwned('relay', 'agent-a', 'provider-1')).not.toThrow();
			expect(() => restarted.assertOwned('relay', 'agent-b', 'provider-2')).toThrow(/not owned/);
			expect(() => restarted.assertOwned('relay', 'agent-c', 'provider-3')).not.toThrow();
		});

		it('returns a completed resumed answer when recency persistence fails', () => {
			const bindings = new PluginAgentSessionBindings(baseDir, 2);
			bindings.remember('relay', 'agent-a', 'provider-1');
			failRename.current = true;
			expect(() => bindings.remember('relay', 'agent-a', 'provider-1')).not.toThrow();
			expect(() => bindings.remember('relay', 'agent-a', 'provider-2')).toThrow(
				/simulated rename failure/
			);
			failRename.current = false;
			const restarted = new PluginAgentSessionBindings(baseDir, 2);
			expect(() => restarted.assertOwned('relay', 'agent-a', 'provider-1')).not.toThrow();
			expect(() => restarted.assertOwned('relay', 'agent-a', 'provider-2')).toThrow(/not owned/);
		});
	});
});
describeSourceSuite('plugin-confirmation-security', () => {
	beforeEach(() => {
		ipc.clear();
		windows.length = 0;
	});
	async function open() {
		const host = new PluginConfirmationWindows('/fixture'),
			controller = new AbortController();
		const commit = vi.fn(() => ({ revision: 1 }));
		const promise = host.confirm(
			{
				kind: 'record',
				pluginId: 'com.example.fixture',
				key: 'policy',
				summary: 'Opaque grant',
				value: { disabled: true },
			},
			controller.signal,
			() => {},
			commit,
			async () => {}
		);
		await vi.waitFor(() => expect(windows).toHaveLength(1));
		await Promise.resolve();
		const window = windows[0],
			wc = window.webContents;
		const event = { sender: wc, senderFrame: wc.mainFrame };
		await vi.waitFor(async () =>
			expect(await ipc.get('plugin-confirmation:offer')!(event)).not.toBeNull()
		);
		const offer = await ipc.get('plugin-confirmation:offer')!(event);
		const activate = () => wc.emit('before-mouse-event', {}, { type: 'mouseUp', button: 'left' });
		const call = (request = { nonce: offer.nonce, approved: true }, e = event) =>
			ipc.get('plugin-confirmation:call')!(e, request);
		return { promise, commit, window, wc, event, offer, activate, call, controller };
	}
	describe('trusted generic confirmation surface', () => {
		it('accepts only exact-frame nonce plus a fresh main-observed activation and captures original payload', async () => {
			const s = await open();
			await Promise.resolve();
			expect(s.window.options.webPreferences).toMatchObject({
				sandbox: true,
				contextIsolation: true,
				nodeIntegration: false,
			});
			expect(await s.call()).toEqual({ ok: false, error: 'PLUGIN_DENIED' });
			expect(s.commit).not.toHaveBeenCalled();
			s.activate();
			expect(await s.call()).toEqual({ ok: true });
			expect(await s.promise).toEqual({ revision: 1 });
			expect(await s.call()).toEqual({ ok: false, error: 'PLUGIN_DENIED' });
			expect(s.commit).toHaveBeenCalledTimes(1);
		});
		it('rejects a foreign sender, child frame, payload replacement and a forged nonce', async () => {
			const s = await open();
			await Promise.resolve();
			s.activate();
			expect(await s.call(undefined, { ...s.event, sender: {} })).toMatchObject({ ok: false });
			expect(
				await s.call(undefined, { ...s.event, senderFrame: { ...s.wc.mainFrame } })
			).toMatchObject({
				ok: false,
			});
			expect(await s.call({ nonce: 'invented', approved: true })).toMatchObject({ ok: false });
			expect(
				await s.call({ nonce: s.offer.nonce, approved: true, value: { widened: true } } as any)
			).toMatchObject({ ok: false });
			expect(s.commit).not.toHaveBeenCalled();
			const denied = expect(s.promise).rejects.toMatchObject({ code: 'PLUGIN_CANCELED' });
			s.controller.abort();
			await denied;
		});
		it('cancels on plugin lifetime revocation and never accepts renderer claimed activation', async () => {
			const s = await open();
			await Promise.resolve();
			expect(
				await s.call({ nonce: s.offer.nonce, approved: true, userActivation: true } as any)
			).toMatchObject({ ok: false });
			const denied = expect(s.promise).rejects.toThrow();
			s.controller.abort();
			await denied;
			s.activate();
			expect(await s.call()).toMatchObject({ ok: false });
			expect(s.commit).not.toHaveBeenCalled();
		});
	});

	describe('confirmation offer IPC', () => {
		it('keeps a large record off the renderer command line and serves only its exact live document', async () => {
			const host = new PluginConfirmationWindows('/fixture');
			const controller = new AbortController();
			const value = { payload: 'x'.repeat(60000) };
			const promise = host.confirm(
				{
					kind: 'record',
					pluginId: 'com.example.fixture',
					key: 'large',
					summary: 'Synthetic record',
					value,
				},
				controller.signal,
				() => {},
				vi.fn(),
				async () => {}
			);
			await vi.waitFor(() => expect(windows).toHaveLength(1));
			await Promise.resolve();
			const window = windows[0],
				wc = window.webContents;
			try {
				expect(window.options.webPreferences.additionalArguments).toBeUndefined();
				const getOffer = ipc.get('plugin-confirmation:offer')!;
				const event = { sender: wc, senderFrame: wc.mainFrame };
				expect(await getOffer(event)).toMatchObject({ value, nonce: expect.any(String) });
				expect(await getOffer({ ...event, sender: {} })).toBeNull();
				expect(await getOffer({ ...event, senderFrame: { ...wc.mainFrame } })).toBeNull();
				const url = wc.mainFrame.url;
				wc.mainFrame.url = 'file:///fixture/other.html';
				expect(await getOffer(event)).toBeNull();
				wc.mainFrame.url = url;
				controller.abort();
				expect(await getOffer(event)).toBeNull();
			} finally {
				controller.abort();
				await promise.catch(() => {});
			}
		});
	});
});
describeSourceSuite('plugin-sandbox-realm', () => {
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
		it('routes generateTitle through the brokered host method', () => {
			const bridge = makeBridge();
			const realm = bootRealm(bridge);
			realm.runScript(
				"maestro.agents.generateTitle('agent-a', 'Build a login form');",
				'title-call'
			);
			const request = JSON.parse((bridge.send as ReturnType<typeof vi.fn>).mock.calls[0][0]);
			expect(request).toMatchObject({
				method: 'agents.generateTitle',
				params: { agentId: 'agent-a', firstMessage: 'Build a login form' },
			});
		});

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
		it('routes agents.send progress only to its pending call and drops late events', async () => {
			const sent: Array<{ id: number; method: string; params: unknown }> = [];
			const bridge = makeBridge({ send: vi.fn((json: string) => sent.push(JSON.parse(json))) });
			const realm = bootRealm(bridge);
			realm.runScript(
				String.raw`
			globalThis.progress = [];
			globalThis.calls = [
				maestro.agents.send('a', 'one', { onProgress: function (e) { progress.push(['one', e.summary || e.text]); } }),
				maestro.agents.send('a', 'two', { sessionId: 'owned', onProgress: function (e) { progress.push(['two', e.summary || e.text]); } })
			];
		`,
				'send-progress'
			);
			expect(sent).toHaveLength(2);
			expect(sent[0].params).toEqual({ agentId: 'a', prompt: 'one', opts: {} });
			expect(sent[1].params).toEqual({ agentId: 'a', prompt: 'two', opts: { sessionId: 'owned' } });
			realm.deliverProgress(
				JSON.stringify({ id: sent[1].id, event: { type: 'commentary', text: 'second', at: 'now' } })
			);
			realm.deliverProgress(
				JSON.stringify({
					id: sent[0].id,
					event: {
						type: 'tool',
						tool: 'Read',
						status: 'started',
						summary: 'Reading file first.md',
						at: 'now',
					},
				})
			);
			realm.deliverResponse(
				JSON.stringify({ id: sent[0].id, ok: true, result: { success: true, response: 'done' } })
			);
			realm.deliverProgress(
				JSON.stringify({ id: sent[0].id, event: { type: 'activity', text: 'late', at: 'now' } })
			);
			realm.deliverResponse(
				JSON.stringify({ id: sent[1].id, ok: true, result: { success: true, response: 'done' } })
			);
			await Promise.all([Promise.resolve(), Promise.resolve()]);
			realm.runScript('console.log(JSON.stringify(progress));', 'progress-result');
			const infos = (bridge.log as ReturnType<typeof vi.fn>).mock.calls.filter(
				([level]) => level === 'info'
			);
			expect(JSON.parse(String(infos.at(-1)?.[1]))).toEqual([
				['two', 'second'],
				['one', 'Reading file first.md'],
			]);
		});

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

		it('passes host caller identity as a separate frozen tool context', async () => {
			const realm = bootRealm();
			realm.runScript(
				String.raw`
			module.exports = { activate: function (maestro) {
				maestro.tools.register('who', function (args, context) {
					return { claimed: args.agentId, verified: context.callerAgentId,
						frozen: Object.isFrozen(context) };
				});
			} };
		`,
				'tool-context'
			);
			await realm.activate();
			const result = await realm.invokeTool(
				JSON.stringify({
					commandId: 'who',
					args: { agentId: 'forged' },
					context: { callerAgentId: 'agent-a' },
				})
			);
			expect(JSON.parse(result)).toEqual({
				ok: true,
				result: {
					claimed: 'forged',
					verified: 'agent-a',
					frozen: true,
				},
			});
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
			const [id] = (bridge.timerStart as ReturnType<typeof vi.fn>).mock.calls[0] as [
				number,
				number,
			];
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

	describe('media SDK contract', () => {
		it('keeps service context and cancellation callbacks inside the realm without event consent', async () => {
			const sent: string[] = [];
			const bridge = makeBridge({ send: vi.fn((json: string) => sent.push(json)) });
			const realm = bootRealm(bridge);
			realm.runScript(
				`module.exports = { activate: function (maestro) {
			return maestro.services.register('transcription', function (request, context) {
				console.log('realm:' + Object.isFrozen(context));
				try { context.onCancel.constructor('return process')(); console.log('escaped'); } catch (e) {}
				return new Promise(function (resolve) {
					context.onCancel(function () { console.log('cancelled:' + context.isCancelled()); resolve({text:'stopped'}); });
				});
			});
		} };`,
				'service-registration'
			);
			const activated = realm.activate();
			const registration = JSON.parse(sent[0]);
			expect(registration).toMatchObject({
				method: 'services.register',
				params: { serviceId: 'transcription' },
			});
			realm.deliverResponse(JSON.stringify({ id: registration.id, ok: true, result: null }));
			await activated;
			realm.invokeCommand(
				JSON.stringify({ commandId: 'service:transcription', args: { callId: 'forged' } })
			);
			expect(bridge.log).not.toHaveBeenCalledWith('info', 'realm:true');
			const invocation = realm.invokeTool(
				JSON.stringify({
					commandId: 'service:transcription',
					args: { callId: 'call', audioId: 'alias' },
				})
			);
			await vi.waitFor(() => expect(bridge.log).toHaveBeenCalledWith('info', 'realm:true'));
			realm.deliverEvent(
				JSON.stringify({ topic: 'services.cancel', payload: { callId: 'foreign' } })
			);
			expect(bridge.log).not.toHaveBeenCalledWith('info', 'cancelled:true');
			realm.deliverEvent(JSON.stringify({ topic: 'services.cancel', payload: { callId: 'call' } }));
			expect(JSON.parse(await invocation)).toEqual({ ok: true, result: { text: 'stopped' } });
			expect(bridge.log).toHaveBeenCalledWith('info', 'cancelled:true');
			expect(bridge.log).not.toHaveBeenCalledWith('info', 'escaped');
		});
		it('releases cancelled invocation records even when the provider never settles', async () => {
			const bridge = makeBridge();
			const realm = bootRealm(bridge);
			realm.runScript(
				`
			var originalDelete = Map.prototype.delete;
			Map.prototype.delete = function(key) {
				var result = originalDelete.call(this, key);
				if (key === 'pending-call') console.log('remaining:' + this.size);
				return result;
			};
			module.exports = { activate: function(sdk) {
				void sdk.services.register('transcription', function(request, context) {
					context.onCancel(function() { console.log('cancelled:' + context.isCancelled()); });
					return new Promise(function() {});
				});
			} };`,
				'unsettled-provider'
			);
			await realm.activate();
			void realm.invokeTool(
				JSON.stringify({ commandId: 'service:transcription', args: { callId: 'pending-call' } })
			);
			await Promise.resolve();
			realm.deliverEvent(
				JSON.stringify({ topic: 'services.cancel', payload: { callId: 'pending-call' } })
			);
			expect(bridge.log).toHaveBeenCalledWith('info', 'remaining:0');
			expect(bridge.log).toHaveBeenCalledWith('info', 'cancelled:true');
		});
		it('sends opaque media params and preserves machine-readable failure codes in the sandbox realm', async () => {
			const sent: string[] = [];
			const bridge = makeBridge({ send: vi.fn((json: string) => sent.push(json)) });
			const realm = bootRealm(bridge);
			realm.runScript(
				`module.exports = { activate: function (maestro) {
			return maestro.media.run('job', 'audio', { profile: 'whisper-cli', model: 'base', language: 'de' }).catch(function (error) {
				console.log(error.code + ':' + (error instanceof Error));
			});
		} };`,
				'media-roundtrip'
			);
			const activated = realm.activate();
			const request = JSON.parse(sent[0]);
			expect(request).toMatchObject({
				method: 'media.run',
				params: { jobId: 'job', audioId: 'audio', options: { model: 'base', language: 'de' } },
			});
			realm.deliverResponse(
				JSON.stringify({
					id: request.id,
					ok: false,
					error: 'MediaTimeout',
					errorCode: 'MediaTimeout',
				})
			);
			await activated;
			expect(bridge.log).toHaveBeenCalledWith('info', 'MediaTimeout:true');
		});
	});
});
describeSourceSuite('plugin-service-host', () => {
	const request = {
		jobId: 'owner-job',
		audioId: 'owner-audio',
		model: 'base' as const,
		language: 'de' as const,
	};
	const result = {
		text: 'Guten Tag',
		model: 'base' as const,
		language: 'de',
		durationSeconds: 1,
		multilingual: true as const,
		translated: false as const,
	};
	let host: PluginServiceHost;
	let records: Record<string, PluginManifest>;
	let revoked: Set<string>;
	let invoke: ReturnType<typeof vi.fn>;
	let leases: MediaServiceLease[];
	let cleaned: number;
	let closedFailure: boolean;
	let lifetime: number;
	let holding: boolean;
	let running: Set<string>;
	let changed: ReturnType<typeof vi.fn>;
	let cancelProvider: ReturnType<typeof vi.fn>;
	let media: Pick<PluginMediaTools, 'delegate' | 'serviceStatus'>;
	beforeEach(() => {
		changed = vi.fn();
		cancelProvider = vi.fn();
		revoked = new Set();
		leases = [];
		cleaned = 0;
		closedFailure = false;
		holding = false;
		lifetime = SERVICE_LIMITS.timeoutMs;
		running = new Set(['consumer', 'provider']);
		records = {
			consumer: {
				id: 'consumer',
				name: 'Consumer',
				version: '1.0.0',
				tier: 1,
				maestro: { minHostApi: '1.24.0' },
				entry: 'main.js',
				requires: [
					{
						id: 'voice',
						provider: 'provider',
						service: 'transcription',
						contract: TRANSCRIPTION_CONTRACT,
						version: '^1.0.0',
						optional: true,
					},
				],
			},
			provider: {
				id: 'provider',
				name: 'Provider',
				version: '1.0.0',
				tier: 1,
				maestro: { minHostApi: '1.24.0' },
				entry: 'main.js',
				provides: [
					{
						id: 'transcription',
						contract: TRANSCRIPTION_CONTRACT,
						version: '1.0.0',
						settingsPanel: 'config',
					},
				],
			},
		};
		invoke = vi.fn((_provider, _command, _request, signal: AbortSignal) =>
			holding
				? new Promise((_resolve, reject) =>
						signal.addEventListener('abort', () => reject(signal.reason), { once: true })
					)
				: Promise.resolve(result)
		);
		media = {
			delegate: vi.fn((owner, job, audio, _options, authorize) => {
				if (!records[owner]?.requires || job !== request.jobId || audio !== request.audioId)
					throw Object.assign(new Error('MediaInvalid'), { code: 'MediaInvalid' });
				authorize();
				const controller = new AbortController();
				const lease: MediaServiceLease = {
					audioId: `alias-${leases.length}`,
					expiresAt: Date.now() + lifetime,
					signal: controller.signal,
					call: vi.fn(async () => ({ durationSeconds: 1 })),
					close: vi.fn(async () => {
						controller.abort(
							Object.assign(new Error('MediaCancelled'), { code: 'MediaCancelled' })
						);
						await Promise.resolve();
						if (closedFailure) throw new Error('secret cleanup path');
						cleaned++;
					}),
				};
				leases.push(lease);
				return lease;
			}),
			serviceStatus: vi.fn(async () => ({
				profiles: ['whisper-cli'],
				models: ['base'],
				missing: [],
			})),
		};
		host = new PluginServiceHost({
			manifest: (id) => records[id],
			running: (id) => running.has(id),
			allowed: (id, cap, target) =>
				!revoked.has(`${id}:${cap}`) &&
				(cap !== 'services:call' || target === 'provider/transcription'),
			invoke,
			changed,
			cancelProvider,
			media: media as PluginMediaTools,
			settingsPanel: (_id, panel) => panel === 'config',
		});
		host.register('provider', 'transcription');
	});
	afterEach(async () => {
		closedFailure = false;
		await Promise.allSettled([...running].map((id) => host.cleanupPlugin(id)));
		await host.cleanupPlugin('consumer');
		await host.cleanupPlugin('provider');
		vi.useRealTimers();
	});

	describe('host-mediated service lifecycle', () => {
		it.each(['MediaInvalid', 'MediaTooLong', 'MediaTooLarge'])(
			'preserves invalid media classification across delegated %s failures',
			async (code) => {
				invoke.mockImplementation(async (_provider, _command, args) => {
					leases[0].call = vi.fn(async () => {
						throw Object.assign(new Error(code), { code });
					});
					return host.media('provider', 'probe', args.callId, args.audioId);
				});
				const { callId } = host.start('consumer', 'voice', request);
				await expect(host.result('consumer', callId)).rejects.toMatchObject({
					code: 'ServiceInvalid',
					message: 'ServiceInvalid',
				});
				expect(cleaned).toBeGreaterThan(0);
			}
		);
		it('uses native manifest permissions for exact consent and denies foreign or revoked scopes', async () => {
			for (const id of ['consumer', 'provider']) {
				const parsed = validatePluginManifest({
					...records[id],
					permissions:
						id === 'consumer'
							? [
									{ capability: 'services:call', scope: 'provider/transcription' },
									{ capability: 'media:tools', scope: 'discord-voice' },
								]
							: [
									{ capability: 'services:provide', scope: 'transcription' },
									{ capability: 'media:tools', scope: 'service-transcription' },
								],
				});
				expect(parsed.errors).toEqual([]);
				expect(parsed.manifest).not.toBeNull();
				records[id] = parsed.manifest!;
			}
			const grants = Object.fromEntries(
				Object.entries(records).map(([id, manifest]) => [
					id,
					grantsFromRequests(manifest.permissions ?? [], 1),
				])
			);
			host = new PluginServiceHost({
				manifest: (id) => records[id],
				running: (id) => running.has(id),
				allowed: (id, capability, target) => isPermitted(grants[id] ?? [], capability, target),
				invoke,
				media: media as PluginMediaTools,
			});
			// Declaring a dependency alone never grants consent.
			const approved = grants.consumer;
			grants.consumer = [];
			host.register('provider', 'transcription');
			expect(host.available('consumer', 'voice')).toBe(false);
			expect((await host.status('consumer', 'voice')).state).toBe('denied');
			expect(() => host.start('consumer', 'voice', request)).toThrow('ServiceDenied');
			grants.consumer = approved;
			expect(host.available('consumer', 'voice')).toBe(true);
			expect((await host.status('consumer', 'voice')).state).toBe('ready');
			const { callId } = host.start('consumer', 'voice', request);
			await expect(host.result('consumer', callId)).resolves.toEqual(result);
			expect(invoke).toHaveBeenCalledTimes(1);
			vi.mocked(media.delegate).mockClear();
			for (const scope of [
				'foreign/transcription',
				'provider/other',
				'provider/*',
				'provider/transcription,provider/*',
				undefined,
			]) {
				grants.consumer = approved.map((grant) =>
					grant.capability === 'services:call' ? { ...grant, scope } : grant
				);
				expect(host.available('consumer', 'voice')).toBe(false);
				expect((await host.status('consumer', 'voice')).state).toBe('denied');
				expect(() => host.start('consumer', 'voice', request)).toThrow('ServiceDenied');
			}
			grants.consumer = approved.filter((grant) => grant.capability !== 'services:call');
			expect((await host.status('consumer', 'voice')).state).toBe('denied');
			expect(() => host.start('consumer', 'voice', request)).toThrow('ServiceDenied');
			expect(media.delegate).not.toHaveBeenCalled();
			expect(invoke).toHaveBeenCalledTimes(1);
		});
		it.each([
			'consumer:services:call',
			'consumer:media:tools',
			'provider:services:provide',
			'provider:media:tools',
		])('withholds readiness when %s is revoked during status I/O', async (permission) => {
			media.serviceStatus = vi.fn(async () => {
				revoked.add(permission);
				return { profiles: ['whisper-cli'], models: ['base'], missing: [] } as const;
			});
			const status = await host.status('consumer', 'voice');
			expect(status.state).toBe('denied');
			expect(status.readiness).toBeUndefined();
		});
		it('allows only one result waiter, while cancellation remains available', async () => {
			holding = true;
			const { callId } = host.start('consumer', 'voice', request);
			const value = host.result('consumer', callId);
			await expect(host.result('consumer', callId)).rejects.toMatchObject({
				code: 'ServiceInvalid',
			});
			await host.cancel('consumer', callId);
			await expect(value).rejects.toMatchObject({ code: 'ServiceCancelled' });
		});
		it('routes a pinned versioned provider and withholds owner handles/URLs; cleans before result', async () => {
			vi.useFakeTimers({ toFake: ['Date'] });
			expect(await host.status('consumer', 'voice')).toMatchObject({
				state: 'ready',
				provider: 'provider',
				version: '1.0.0',
				readiness: { models: ['base'], languages: ['de', 'en'] },
				settingsTarget: { pluginId: 'provider', panelId: 'config' },
			});
			const { callId } = host.start('consumer', 'voice', request);
			expect(invoke).toHaveBeenCalledWith(
				'provider',
				'service:transcription',
				expect.objectContaining({ callId, audioId: 'alias-0' }),
				expect.any(AbortSignal),
				SERVICE_LIMITS.timeoutMs
			);
			expect(JSON.stringify(invoke.mock.calls[0][2])).not.toContain('owner-');
			expect(await host.result('consumer', callId)).toEqual(result);
			expect(cleaned).toBeGreaterThan(0);
		});
		it('returns denied metadata without mounting/activating anything when optional consent is absent', async () => {
			revoked.add('consumer:services:call');
			expect(await host.status('consumer', 'voice')).toMatchObject({ state: 'denied' });
			expect(() => host.start('consumer', 'voice', request)).toThrow('ServiceDenied');
			expect(media.delegate).not.toHaveBeenCalled();
		});
		it('never selects another provider and rejects absent, untrusted/inactive, incompatible or unregistered services', async () => {
			records.provider.provides![0].version = '1.5.0';
			records.consumer.requires![0].version = '1.0.0';
			expect(await host.status('consumer', 'voice')).toMatchObject({ state: 'incompatible' });
			delete records.provider;
			expect(await host.status('consumer', 'voice')).toMatchObject({ state: 'unavailable' });
			expect(invoke).not.toHaveBeenCalled();
		});
		it.each([
			'consumer:services:call',
			'consumer:media:tools',
			'provider:services:provide',
			'provider:media:tools',
		])('revokes %s while a call is in flight', async (permission) => {
			holding = true;
			const { callId } = host.start('consumer', 'voice', request);
			revoked.add(permission);
			const value = host.result('consumer', callId);
			await expect(value).rejects.toMatchObject({ code: 'ServiceDenied' });
			expect(leases[0].signal.aborted).toBe(true);
			expect(cleaned).toBeGreaterThan(0);
		});
		it('cancels idempotently after consumer consent is revoked; foreign cancellation cannot affect work', async () => {
			holding = true;
			const { callId } = host.start('consumer', 'voice', request);
			await host.cancel('intruder', callId);
			expect(leases[0].signal.aborted).toBe(false);
			revoked.add('consumer:services:call');
			const value = host.result('consumer', callId);
			await host.cancel('consumer', callId);
			await expect(value).rejects.toMatchObject({ code: 'ServiceCancelled' });
			await host.cancel('consumer', callId);
			expect(leases[0].signal.aborted).toBe(true);
		});
		it('expires under the original shorter deadline, including when results are never fetched', async () => {
			lifetime = 15;
			holding = true;
			const { callId } = host.start('consumer', 'voice', request);
			await expect(host.result('consumer', callId)).rejects.toMatchObject({
				code: 'ServiceTimeout',
			});
			expect(invoke.mock.calls[0][4]).toBeLessThanOrEqual(15);
			expect(leases[0].signal.aborted).toBe(true);
		});
		it.each(['consumer', 'provider'])(
			'disable/crash/update/uninstall of %s revokes work and registration',
			async (id) => {
				holding = true;
				const { callId } = host.start('consumer', 'voice', request);
				const value = host.result('consumer', callId);
				running.delete(id);
				host.cleanupPlugin(id);
				await expect(value).rejects.toMatchObject({ code: 'ServiceUnavailable' });
				expect(leases[0].signal.aborted).toBe(true);
			}
		);
		it.each([true, false])(
			'consumer cleanup releases both local slots after drain (in flight: %s)',
			async (inFlight) => {
				vi.useFakeTimers();
				holding = inFlight;
				const first = host.start('consumer', 'voice', request);
				host.start('consumer', 'voice', request);
				expect((await host.status('consumer', 'voice')).state).toBe('busy');
				const retained: boolean[] = [];
				changed.mockImplementation(() => retained.push(host.ownsCancel('consumer', first)));
				await host.cleanupPlugin('consumer');
				expect(leases.every((lease) => lease.signal.aborted)).toBe(true);
				expect((await host.status('consumer', 'voice')).state).toBe('ready');
				expect(vi.getTimerCount()).toBe(0);
				expect(host.ownsCancel('consumer', first)).toBe(false);
				await expect(host.result('consumer', first.callId)).rejects.toMatchObject({
					code: 'ServiceInvalid',
				});
				expect(retained[0]).toBe(true);
				expect(retained.at(-1)).toBe(false);
				host.start('consumer', 'voice', request);
				host.start('consumer', 'voice', request);
				expect(invoke).toHaveBeenCalledTimes(4);
			}
		);
		it('consumer cleanup releases four global slots for an unrelated surviving consumer', async () => {
			vi.useFakeTimers();
			holding = true;
			for (const id of ['other', 'survivor']) {
				records[id] = { ...records.consumer, id };
				running.add(id);
			}
			for (const id of ['consumer', 'other']) {
				host.start(id, 'voice', request);
				host.start(id, 'voice', request);
			}
			expect(() => host.start('survivor', 'voice', request)).toThrow('ServiceBusy');
			await Promise.all([host.cleanupPlugin('consumer'), host.cleanupPlugin('other')]);
			expect((await host.status('survivor', 'voice')).state).toBe('ready');
			expect(vi.getTimerCount()).toBe(0);
			host.start('survivor', 'voice', request);
			host.start('survivor', 'voice', request);
			expect(invoke).toHaveBeenCalledTimes(6);
		});
		it('retains owner reservations and cleanup barrier until media drain finishes', async () => {
			vi.useFakeTimers();
			holding = true;
			const first = host.start('consumer', 'voice', request);
			host.start('consumer', 'voice', request);
			const gate = Promise.withResolvers<void>();
			for (const lease of leases) {
				const close = lease.close;
				lease.close = vi.fn(async () => {
					await close();
					await gate.promise;
				});
			}
			let drained = false;
			const cleanup = host.cleanupPlugin('consumer').then(() => {
				drained = true;
			});
			await Promise.resolve();
			expect(drained).toBe(false);
			expect(host.ownsCancel('consumer', first)).toBe(true);
			expect((await host.status('consumer', 'voice')).state).toBe('busy');
			expect(() => host.start('consumer', 'voice', request)).toThrow('ServiceBusy');
			gate.resolve();
			await cleanup;
			expect(drained).toBe(true);
			expect(host.ownsCancel('consumer', first)).toBe(false);
			expect(vi.getTimerCount()).toBe(0);
			host.start('consumer', 'voice', request);
			host.start('consumer', 'voice', request);
		});
		it('retains failed owner cleanup for retry before releasing capacity', async () => {
			vi.useFakeTimers();
			holding = true;
			const first = host.start('consumer', 'voice', request);
			host.start('consumer', 'voice', request);
			closedFailure = true;
			await expect(host.cleanupPlugin('consumer')).rejects.toThrow('secret cleanup path');
			expect(host.ownsCancel('consumer', first)).toBe(true);
			expect((await host.status('consumer', 'voice')).state).toBe('busy');
			expect(() => host.start('consumer', 'voice', request)).toThrow('ServiceBusy');
			closedFailure = false;
			await host.cleanupPlugin('consumer');
			expect(vi.getTimerCount()).toBe(0);
			host.start('consumer', 'voice', request);
			host.start('consumer', 'voice', request);
		});
		it('provider cleanup retains unavailable errors for surviving consumers after re-registration', async () => {
			vi.useFakeTimers();
			holding = true;
			const first = host.start('consumer', 'voice', request);
			const second = host.start('consumer', 'voice', request);
			await host.cleanupPlugin('provider');
			expect((await host.status('consumer', 'voice')).state).toBe('unavailable');
			host.register('provider', 'transcription');
			expect((await host.status('consumer', 'voice')).state).toBe('busy');
			for (const call of [first, second]) {
				expect(host.ownsCancel('consumer', call)).toBe(true);
				await expect(host.result('consumer', call.callId)).rejects.toMatchObject({
					code: 'ServiceUnavailable',
				});
			}
			expect(vi.getTimerCount()).toBe(0);
			expect((await host.status('consumer', 'voice')).state).toBe('ready');
		});
		it('awaits late provider settlement during overlapping cleanup/cancel and preserves the first failure', async () => {
			vi.useFakeTimers();
			const reply = Promise.withResolvers<typeof result>();
			invoke.mockReturnValueOnce(reply.promise);
			const first = host.start('consumer', 'voice', request);
			const value = host.result('consumer', first.callId);
			const failed = expect(value).rejects.toMatchObject({ code: 'ServiceCancelled' });
			changed.mockClear();
			const cancel = host.cancel('consumer', first.callId);
			let drained = false;
			const cleanup = host.cleanupPlugin('consumer').then(() => {
				drained = true;
			});
			await Promise.resolve();
			expect(drained).toBe(false);
			expect(host.ownsCancel('consumer', first)).toBe(true);
			reply.resolve(result);
			await Promise.all([cancel, cleanup, failed]);
			expect(cancelProvider).toHaveBeenCalledTimes(1);
			expect(changed).toHaveBeenCalledTimes(1);
			expect(vi.getTimerCount()).toBe(0);
			expect(host.ownsCancel('consumer', first)).toBe(false);
			const next = host.start('consumer', 'voice', request);
			await host.cleanupPlugin('consumer');
			expect(host.ownsCancel('consumer', next)).toBe(false);
			await vi.advanceTimersByTimeAsync(SERVICE_LIMITS.timeoutMs);
			expect(vi.getTimerCount()).toBe(0);
			expect(invoke).toHaveBeenCalledTimes(2);
		});
		it.each([false, true])(
			'unregister notifies service loss before pending/failed drain (failure: %s)',
			async (fail) => {
				vi.useFakeTimers();
				holding = true;
				const call = host.start('consumer', 'voice', request);
				const gate = Promise.withResolvers<void>();
				const close = leases[0].close;
				leases[0].close = vi.fn(async () => {
					await close();
					await gate.promise;
				});
				const availability: boolean[] = [];
				changed.mockClear();
				changed.mockImplementation(() => availability.push(host.available('consumer', 'voice')));
				const cleanup = host.unregister('provider', 'transcription');
				const invalidated = [...availability];
				expect(host.ownsCancel('consumer', call)).toBe(true);
				if (fail) {
					const rejected = expect(cleanup).rejects.toThrow('MediaProcessFailed');
					gate.reject(new Error('MediaProcessFailed'));
					await rejected;
					leases[0].close = close;
					await host.cleanupPlugin('provider');
				} else {
					gate.resolve();
					await cleanup;
				}
				await expect(host.result('consumer', call.callId)).rejects.toThrow(
					fail ? 'MediaProcessFailed' : 'ServiceUnavailable'
				);
				expect(invalidated).toEqual([false]);
			}
		);
		it('does not resurrect a revoked registration when permissions are restored', async () => {
			revoked.add('provider:services:provide');
			host.reconcile();
			revoked.clear();
			expect(await host.status('consumer', 'voice')).toMatchObject({ state: 'unavailable' });
			host.register('provider', 'transcription');
			expect(await host.status('consumer', 'voice')).toMatchObject({ state: 'ready' });
		});
		it('does not resurrect a settled result after consumer revocation and immediate restoration', async () => {
			const { callId } = host.start('consumer', 'voice', request);
			await vi.waitFor(() => expect(cleaned).toBeGreaterThan(0));
			revoked.add('consumer:media:tools');
			host.reconcile();
			revoked.clear();
			await expect(host.result('consumer', callId)).rejects.toMatchObject({
				code: 'ServiceDenied',
			});
		});
		it.each([
			{ ...result, text: 'x'.repeat(12001) },
			{ ...result, language: 'en' },
			{ ...result, text: '😀'.repeat(12001) },
			{ ...result, translated: true },
			{ ...result, arbitrary: 'data' },
		])('rejects hostile results after cleanup', async (invalid) => {
			invoke.mockResolvedValue(invalid);
			const { callId } = host.start('consumer', 'voice', request);
			await expect(host.result('consumer', callId)).rejects.toMatchObject({
				code: 'ServiceInvalid',
			});
			expect(cleaned).toBeGreaterThan(0);
		});
		it('never returns successful output when cleanup fails', async () => {
			closedFailure = true;
			const { callId } = host.start('consumer', 'voice', request);
			await expect(host.result('consumer', callId)).rejects.toThrow();
		});
		it('binds aliases to the exact provider/call and caps retained calls', async () => {
			holding = true;
			const { callId } = host.start('consumer', 'voice', request);
			await expect(host.media('intruder', 'probe', callId, 'alias-0')).rejects.toMatchObject({
				code: 'ServiceInvalid',
			});
			await host.media('provider', 'probe', callId, 'alias-0');
			await expect(host.result('intruder', callId)).rejects.toMatchObject({
				code: 'ServiceInvalid',
			});
			host.start('consumer', 'voice', request);
			expect(() => host.start('consumer', 'voice', request)).toThrow('ServiceBusy');
			await host.cancel('consumer', callId);
			await expect(host.media('provider', 'probe', callId, 'alias-0')).rejects.toMatchObject({
				code: 'ServiceInvalid',
			});
		});
	});
});

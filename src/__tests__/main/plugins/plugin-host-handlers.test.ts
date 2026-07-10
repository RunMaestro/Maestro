/**
 * @file plugin-host-handlers.test.ts
 * @description Host handlers for the new verbs: settings.set namespace + secret
 * rejection, sessions metadata-only projection, storage confinement under the
 * ActionGuard, ui.runCommand registration gate, events delegation, net.fetch
 * egress refusal, fs.write guarding, and the uninstall purge.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	buildHostCallHandlers,
	purgePluginData,
	type HostHandlerDeps,
	type PluginSessionMetadata,
} from '../../../main/plugins/plugin-host-handlers';
import { ActionGuard } from '../../../main/plugins/action-guard';
import { PluginKvStore } from '../../../main/plugins/plugin-kv-store';
import { PluginEventBusImpl } from '../../../main/plugins/plugin-event-bus';
import { PermissionBroker } from '../../../main/plugins/permission-broker';
import { PluginBackgroundSupervisor } from '../../../main/plugins/plugin-background-supervisor';
import { PluginGroupingRegistry } from '../../../main/plugins/plugin-grouping-registry';
import type { PermissionGrant } from '../../../shared/plugins/permissions';

let kvBase: string;
let kv: PluginKvStore;

beforeEach(() => {
	kvBase = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-hh-'));
	kv = new PluginKvStore({ baseDir: kvBase });
});
afterEach(() => fs.rmSync(kvBase, { recursive: true, force: true }));

function makeDeps(over: Partial<HostHandlerDeps> = {}): HostHandlerDeps {
	const base: HostHandlerDeps = {
		broker: {
			authorize: () => ({ allowed: true, capability: 'fs:write' }),
		} as unknown as HostHandlerDeps['broker'],
		actionGuard: new ActionGuard(),
		kvStore: kv,
		eventBus: new PluginEventBusImpl({ isPermitted: () => true, push: () => true }),
		egressGuard: { assertUrlAllowed: async () => {}, lookup: (() => {}) as never },
		settingsGet: () => null,
		settingsSet: vi.fn(),
		settingsDeleteNamespace: vi.fn(),
		sessionsList: () => [],
		sessionsGet: () => null,
		runUiCommand: async () => true,
		isHostViewsEnabled: () => true,
		getHostView: (pluginId, localId) =>
			pluginId === 'p' && localId === 'status'
				? {
						id: 'p/status',
						localId: 'status',
						pluginId: 'p',
						surface: 'movement',
						title: 'Plugin status',
					}
				: null,
		forwardHostView: vi.fn(() => true),
		listAgents: () => [],
		isPluginTrusted: () => true,
		readSessionTranscript: async () => [],
		assertTranscriptReadAllowed: () => {},
		auditTranscriptRead: () => {},
	};
	return { ...base, ...over };
}

function brokerFor(getGrants: () => PermissionGrant[]): PermissionBroker {
	return new PermissionBroker({ getGrants });
}

function grant(capability: PermissionGrant['capability']): PermissionGrant {
	return { capability, grantedAt: 1 };
}

describe('settings.set', () => {
	it('rejects keys outside the plugin namespace', async () => {
		const settingsSet = vi.fn();
		const h = buildHostCallHandlers(makeDeps({ settingsSet }));
		await expect(h['settings.set']!('p', { key: 'theme', value: 'dark' })).rejects.toThrow(
			/plugins\.p\./
		);
		await expect(h['settings.set']!('p', { key: 'plugins.other.x', value: 1 })).rejects.toThrow(
			/plugins\.p\./
		);
		expect(settingsSet).not.toHaveBeenCalled();
	});

	it('rejects feature-gate, secret-looking, and prototype keys within the namespace', async () => {
		const h = buildHostCallHandlers(makeDeps());
		await expect(
			h['settings.set']!('p', { key: 'plugins.p.encoreFeatures', value: true })
		).rejects.toThrow(/feature-gate/);
		await expect(
			h['settings.set']!('p', { key: 'plugins.p.apiToken', value: 'x' })
		).rejects.toThrow(/secret/);
		await expect(
			h['settings.set']!('p', { key: 'plugins.p.__proto__.polluted', value: 1 })
		).rejects.toThrow(/prototype/);
	});

	it('writes a valid namespaced non-secret setting', async () => {
		const settingsSet = vi.fn();
		const h = buildHostCallHandlers(makeDeps({ settingsSet }));
		await expect(
			h['settings.set']!('p', { key: 'plugins.p.theme', value: 'dark' })
		).resolves.toEqual({ ok: true });
		expect(settingsSet).toHaveBeenCalledWith('plugins.p.theme', 'dark');
	});

	it('denies stale settings.set host calls after live grants are revoked', async () => {
		let grants = [grant('settings:write')];
		const settingsSet = vi.fn();
		const h = buildHostCallHandlers(
			makeDeps({
				broker: brokerFor(() => grants),
				settingsSet,
			})
		);

		await expect(
			h['settings.set']!('p', { key: 'plugins.p.theme', value: 'dark' })
		).resolves.toEqual({ ok: true });
		grants = [];

		await expect(
			h['settings.set']!('p', { key: 'plugins.p.theme', value: 'light' })
		).rejects.toThrow(/permission denied/);
		expect(settingsSet).toHaveBeenCalledTimes(1);
		expect(settingsSet).toHaveBeenCalledWith('plugins.p.theme', 'dark');
	});

	it('rejects oversized and non-serializable values', async () => {
		const h = buildHostCallHandlers(makeDeps());
		await expect(
			h['settings.set']!('p', { key: 'plugins.p.big', value: 'x'.repeat(70_000) })
		).rejects.toThrow(/size limit/);
		await expect(h['settings.set']!('p', { key: 'plugins.p.bad', value: 10n })).rejects.toThrow(
			/serializable/
		);
	});
});

describe('sessions.list / sessions.get (metadata only)', () => {
	const rich = [
		{
			id: 's1',
			title: 'T',
			agentId: 'a',
			status: 'running',
			createdAt: 1,
			updatedAt: 2,
			projectPath: '/p',
			transcript: 'SECRET-CONTENT',
			messages: ['prompt text'],
		},
	] as unknown as PluginSessionMetadata[];

	it('projects to exactly the metadata fields, never content', async () => {
		const h = buildHostCallHandlers(
			makeDeps({
				sessionsList: () => rich,
				sessionsGet: (id) => (id === 's1' ? rich[0] : null),
			})
		);
		const list = await h['sessions.list']!('p', {});
		expect(list).toEqual([
			{
				id: 's1',
				title: 'T',
				agentId: 'a',
				status: 'running',
				createdAt: 1,
				updatedAt: 2,
				projectPath: '/p',
			},
		]);
		expect(JSON.stringify(list)).not.toContain('SECRET-CONTENT');

		const one = (await h['sessions.get']!('p', { sessionId: 's1' })) as Record<string, unknown>;
		expect(one).not.toHaveProperty('transcript');
		expect(one).not.toHaveProperty('messages');
		expect(await h['sessions.get']!('p', { sessionId: 'nope' })).toBeNull();
	});
});

describe('storage.* handlers', () => {
	it('read/write/keys/delete the plugin OWN store, isolated per plugin', async () => {
		const h = buildHostCallHandlers(makeDeps());
		await h['storage.set']!('p', { key: 'k', value: 'v' });
		expect(await h['storage.get']!('p', { key: 'k' })).toBe('v');
		expect(await h['storage.keys']!('p', {})).toEqual(['k']);
		expect(await h['storage.delete']!('p', { key: 'k' })).toEqual({ ok: true, existed: true });
		await h['storage.set']!('p', { key: 'k', value: 'v' });
		expect(await h['storage.get']!('other', { key: 'k' })).toBeNull();
	});

	it('storage.set is bounded by the KV value cap', async () => {
		const h = buildHostCallHandlers(makeDeps());
		await expect(h['storage.set']!('p', { key: 'k', value: 'x'.repeat(70_000) })).rejects.toThrow();
	});
});

describe('ui.runCommand', () => {
	it('invokes a registered command and rejects unknown ones', async () => {
		const runUiCommand = vi.fn((id: string) => id === 'good');
		const h = buildHostCallHandlers(makeDeps({ runUiCommand }));
		await expect(h['ui.runCommand']!('p', { commandId: 'good' })).resolves.toEqual({ ok: true });
		await expect(h['ui.runCommand']!('p', { commandId: 'evil' })).rejects.toThrow(
			/registered palette command/
		);
	});
});

describe('ui.hostViewUpdate / ui.hostViewRemove', () => {
	const blocks = [{ kind: 'text', text: 'Rendered by the host' }];

	it('fails cleanly without buffering when either Encore feature gate is off', async () => {
		const forwardHostView = vi.fn(() => true);
		const h = buildHostCallHandlers(makeDeps({ isHostViewsEnabled: () => false, forwardHostView }));

		await expect(h['ui.hostViewUpdate']!('p', { id: 'status', blocks })).rejects.toThrow(
			/host views are disabled/
		);
		expect(forwardHostView).not.toHaveBeenCalled();
	});

	it('denies an update when ui:hostView is not granted', async () => {
		const forwardHostView = vi.fn(() => true);
		const h = buildHostCallHandlers(
			makeDeps({
				broker: brokerFor(() => []),
				forwardHostView,
			})
		);

		await expect(h['ui.hostViewUpdate']!('p', { id: 'status', blocks })).rejects.toThrow(
			/permission denied/
		);
		expect(forwardHostView).not.toHaveBeenCalled();
	});

	it('rejects an undeclared view id and caller-supplied surface override', async () => {
		const forwardHostView = vi.fn(() => true);
		const h = buildHostCallHandlers(makeDeps({ forwardHostView }));

		await expect(h['ui.hostViewUpdate']!('p', { id: 'other', blocks })).rejects.toThrow(
			/not declared/
		);
		await expect(
			h['ui.hostViewUpdate']!('p', { id: 'status', blocks, surface: 'cadenza' })
		).rejects.toThrow(/closed schema/);
		expect(forwardHostView).not.toHaveBeenCalled();
	});

	it('rejects decision cadenza payloads without opening a reply channel', async () => {
		const forwardHostView = vi.fn(() => true);
		const h = buildHostCallHandlers(makeDeps({ forwardHostView }));

		await expect(
			h['ui.hostViewUpdate']!('p', {
				id: 'status',
				blocks: { viewType: 'decision', blocks: [], options: [{ label: 'Approve', value: 'yes' }] },
			})
		).rejects.toThrow(/decision cadenza payloads are not supported/);
		expect(forwardHostView).not.toHaveBeenCalled();
	});

	it('rejects an oversized BlockView payload before forwarding', async () => {
		const forwardHostView = vi.fn(() => true);
		const h = buildHostCallHandlers(makeDeps({ forwardHostView }));

		await expect(
			h['ui.hostViewUpdate']!('p', {
				id: 'status',
				blocks: [{ kind: 'text', text: 'x'.repeat(1_000_000) }],
			})
		).rejects.toThrow(/size limit/);
		expect(forwardHostView).not.toHaveBeenCalled();
	});

	it('forwards a granted update and remove only for the caller-owned declared id', async () => {
		const forwardHostView = vi.fn(() => true);
		const h = buildHostCallHandlers(
			makeDeps({
				broker: brokerFor(() => [grant('ui:hostView')]),
				forwardHostView,
			})
		);

		await expect(h['ui.hostViewUpdate']!('p', { id: 'status', blocks })).resolves.toEqual({
			ok: true,
		});
		await expect(h['ui.hostViewRemove']!('p', { id: 'status' })).resolves.toEqual({ ok: true });
		expect(forwardHostView).toHaveBeenNthCalledWith(1, 'p', 'update', 'status', blocks);
		expect(forwardHostView).toHaveBeenNthCalledWith(2, 'p', 'remove', 'status');
	});
});

describe('events.subscribe / events.unsubscribe', () => {
	it('delegate to the bus and filter to catalog topics', async () => {
		const bus = new PluginEventBusImpl({ isPermitted: () => true, push: () => true });
		const h = buildHostCallHandlers(makeDeps({ eventBus: bus }));
		const res = await h['events.subscribe']!('p', { topics: ['session.created', 'bogus'] });
		expect(res).toEqual({ topics: ['session.created'] });
		await h['events.unsubscribe']!('p', { topics: ['session.created'] });
		expect(bus.topicsFor('p')).toEqual([]);
	});
});

describe('net.fetch egress + fs.write guarding', () => {
	it('net.fetch refuses (and never fetches) when the egress guard blocks', async () => {
		const h = buildHostCallHandlers(
			makeDeps({
				egressGuard: {
					assertUrlAllowed: async () => {
						throw new Error('egress blocked: loopback');
					},
					lookup: (() => {}) as never,
				},
			})
		);
		await expect(h['net.fetch']!('p', { url: 'http://127.0.0.1' })).rejects.toThrow(
			/egress blocked/
		);
	});

	it('fs.write is gated by the ActionGuard (denied when the guard refuses)', async () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsw-'));
		const actionGuard = new ActionGuard({
			limits: { high: { windowMs: 1000, maxPerWindow: 0, maxConcurrent: 1 } },
		});
		const h = buildHostCallHandlers(makeDeps({ actionGuard }));
		await expect(
			h['fs.write']!('p', { path: path.join(tmp, 'f.txt'), contents: 'x' })
		).rejects.toThrow(/limit/);
		expect(fs.existsSync(path.join(tmp, 'f.txt'))).toBe(false);
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	it('fs.write writes when broker + guard allow', async () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsw-'));
		const h = buildHostCallHandlers(makeDeps());
		const target = path.join(tmp, 'sub', 'f.txt');
		await expect(h['fs.write']!('p', { path: target, contents: 'hello' })).resolves.toEqual({
			ok: true,
		});
		expect(fs.readFileSync(target, 'utf-8')).toBe('hello');
		fs.rmSync(tmp, { recursive: true, force: true });
	});
});

describe('purgePluginData', () => {
	it('purges KV, namespaced settings, event subscriptions, and live host views', async () => {
		kv.set('p', 'k', 'v');
		const bus = new PluginEventBusImpl({ isPermitted: () => true, push: () => true });
		bus.subscribe('p', ['session.created']);
		const settingsDeleteNamespace = vi.fn();
		const hostViews = { purge: vi.fn() };
		purgePluginData('p', { kvStore: kv, settingsDeleteNamespace, eventBus: bus, hostViews });
		expect(kv.get('p', 'k')).toBeNull();
		expect(settingsDeleteNamespace).toHaveBeenCalledWith('plugins.p.');
		expect(bus.topicsFor('p')).toEqual([]);
		expect(hostViews.purge).toHaveBeenCalledWith('p');
	});
});

describe('net.fetch fail-closed (connection pinning)', () => {
	it('rejects when no dispatcher is available, after assertUrlAllowed passes', async () => {
		const assertUrlAllowed = vi.fn(async () => {});
		const h = buildHostCallHandlers(
			makeDeps({ egressGuard: { assertUrlAllowed, lookup: (() => {}) as never } })
		);
		await expect(h['net.fetch']!('p', { url: 'https://example.com' })).rejects.toThrow(
			/connection pinning is unavailable/
		);
		expect(assertUrlAllowed).toHaveBeenCalledWith('https://example.com');
	});

	it('proceeds to fetch when a dispatcher is present', async () => {
		const fetchMock = vi.fn(async () => ({
			status: 200,
			statusText: 'OK',
			body: null,
			headers: { forEach: () => {} },
		}));
		vi.stubGlobal('fetch', fetchMock);
		try {
			const h = buildHostCallHandlers(
				makeDeps({
					egressGuard: {
						assertUrlAllowed: async () => {},
						lookup: (() => {}) as never,
						dispatcher: {},
					},
				})
			);
			const res = await h['net.fetch']!('p', { url: 'https://example.com' });
			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(res).toEqual({ status: 200, statusText: 'OK', headers: {}, body: '' });
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

describe('settings.get scoping', () => {
	it('denies the feature gate and peer namespaces, allows own + general keys', async () => {
		const settingsGet = vi.fn((key: string) => `V:${key}`);
		const h = buildHostCallHandlers(makeDeps({ settingsGet }));
		await expect(h['settings.get']!('p1', { key: 'encoreFeatures' })).rejects.toThrow(
			/feature gate/
		);
		await expect(h['settings.get']!('p1', { key: 'plugins.other.x' })).rejects.toThrow(
			/another plugin/
		);
		await expect(h['settings.get']!('p1', { key: 'plugins.p1.x' })).resolves.toBe('V:plugins.p1.x');
		await expect(h['settings.get']!('p1', { key: 'theme' })).resolves.toBe('V:theme');
	});
});

describe('transcripts.read', () => {
	const rows = [
		{
			id: 'e1',
			type: 'USER',
			timestamp: 100,
			summary: 's1',
			fullResponse: 'full one',
			projectPath: '/repo/a',
			hostname: 'host-x',
		},
		{
			id: 'e2',
			type: 'AUTO',
			timestamp: 200,
			summary: 's2',
			fullResponse: 'full two',
			projectPath: '/repo/a',
			hostname: 'host-x',
		},
	];
	const readSessionTranscript = (async () => rows) as HostHandlerDeps['readSessionTranscript'];
	const sessionsGet = ((id: string) =>
		id === 's1'
			? ({ id: 's1', projectPath: '/repo/a' } as PluginSessionMetadata)
			: null) as HostHandlerDeps['sessionsGet'];

	it('requires an explicit fields projection', async () => {
		const h = buildHostCallHandlers(makeDeps({ readSessionTranscript, sessionsGet }));
		await expect(h['transcripts.read']!('p', { sessionId: 's1' })).rejects.toThrow(
			/fields is required/
		);
		await expect(h['transcripts.read']!('p', { sessionId: 's1', fields: [] })).rejects.toThrow(
			/fields is required/
		);
	});

	it('projects ONLY declared + allowlisted fields and audits the read', async () => {
		const audit = vi.fn();
		const h = buildHostCallHandlers(
			makeDeps({ readSessionTranscript, sessionsGet, auditTranscriptRead: audit })
		);
		const out = (await h['transcripts.read']!('p', {
			sessionId: 's1',
			fields: ['summary', 'fullResponse', 'hostname'],
		})) as Array<Record<string, unknown>>;
		expect(out).toEqual([
			{ summary: 's1', fullResponse: 'full one' },
			{ summary: 's2', fullResponse: 'full two' },
		]);
		expect(audit).toHaveBeenCalledWith(
			'p',
			expect.objectContaining({ sessionId: 's1', projectPath: '/repo/a', count: 2 })
		);
	});

	it("re-authorizes against the session's RESOLVED project, not the caller's claim", async () => {
		const broker = {
			authorize: () => ({
				allowed: false,
				capability: 'transcripts:read',
				reason: 'permission denied: transcripts:read (/repo/a)',
			}),
		} as unknown as HostHandlerDeps['broker'];
		const h = buildHostCallHandlers(makeDeps({ readSessionTranscript, sessionsGet, broker }));
		await expect(
			h['transcripts.read']!('p', {
				sessionId: 's1',
				fields: ['summary'],
				projectPath: '/repo/granted',
			})
		).rejects.toThrow(/permission denied/);
	});

	it('refuses when the untrusted content+egress guard throws', async () => {
		const assertTranscriptReadAllowed = () => {
			throw new Error('transcripts:read cannot be combined with net:fetch');
		};
		const h = buildHostCallHandlers(
			makeDeps({ readSessionTranscript, sessionsGet, assertTranscriptReadAllowed })
		);
		await expect(
			h['transcripts.read']!('p', { sessionId: 's1', fields: ['summary'] })
		).rejects.toThrow(/cannot be combined with net:fetch/);
	});

	it('returns empty for an unknown session', async () => {
		const h = buildHostCallHandlers(makeDeps({ readSessionTranscript, sessionsGet }));
		await expect(
			h['transcripts.read']!('p', { sessionId: 'nope', fields: ['summary'] })
		).resolves.toEqual([]);
	});

	it('applies since and limit', async () => {
		const h = buildHostCallHandlers(makeDeps({ readSessionTranscript, sessionsGet }));
		await expect(
			h['transcripts.read']!('p', { sessionId: 's1', fields: ['summary'], since: 150 })
		).resolves.toEqual([{ summary: 's2' }]);
		await expect(
			h['transcripts.read']!('p', { sessionId: 's1', fields: ['summary'], limit: 1 })
		).resolves.toEqual([{ summary: 's2' }]);
	});
});

describe('high-power act verbs (agents.dispatch / process.spawn)', () => {
	const scopedGrant = (
		capability: PermissionGrant['capability'],
		scope: string
	): PermissionGrant => ({ capability, scope, grantedAt: 1 });
	const echoEntry = {
		name: 'echo-tool',
		binaryPath: path.join(os.tmpdir(), 'echo-tool.exe'),
		baseArgs: ['--safe'],
		env: { SAFE_FLAG: '1' },
	};
	const resolveSpawnBinary = (name: string) => (name === 'echo-tool' ? echoEntry : null);

	it('does NOT register agents.dispatch or process.spawn with default deps', () => {
		const h = buildHostCallHandlers(makeDeps());
		expect(h['agents.dispatch']).toBeUndefined();
		expect(h['process.spawn']).toBeUndefined();
	});

	it('still exposes the read-only agents.get verb (gating is verb-specific, not namespace-wide)', () => {
		const h = buildHostCallHandlers(makeDeps());
		expect(typeof h['agents.get']).toBe('function');
	});

	it('allows trusted + allowlist-granted low-risk agents.dispatch and audits before the sink', async () => {
		const events: string[] = [];
		const dispatch = vi.fn(async () => {
			events.push('sink');
			return 'dispatched';
		});
		const actionGuard = new ActionGuard({
			now: () => 5,
			audit: () => events.push('audit'),
		});
		const h = buildHostCallHandlers(
			makeDeps({
				broker: brokerFor(() => [scopedGrant('agents:dispatch', 'a')]),
				actionGuard,
				isPluginTrusted: () => true,
				dispatch,
			})
		);
		await expect(
			h['agents.dispatch']!('p', { agentId: 'a', prompt: 'write a friendly summary' })
		).resolves.toBe('dispatched');
		expect(events).toEqual(['audit', 'sink']);
		expect(dispatch).toHaveBeenCalledWith('a', 'write a friendly summary');
	});

	it('denies dispatch to an agent the allowlist grant does not name (exact membership, no wildcard)', async () => {
		const dispatch = vi.fn(async () => 'dispatched');
		const h = buildHostCallHandlers(
			makeDeps({
				broker: brokerFor(() => [scopedGrant('agents:dispatch', 'a,b')]),
				isPluginTrusted: () => true,
				dispatch,
			})
		);
		await expect(
			h['agents.dispatch']!('p', { agentId: 'c', prompt: 'write a friendly summary' })
		).rejects.toThrow(/permission denied/);
		// An UNSCOPED act-verb grant is a wildcard and must also deny.
		const h2 = buildHostCallHandlers(
			makeDeps({
				broker: brokerFor(() => [grant('agents:dispatch')]),
				isPluginTrusted: () => true,
				dispatch,
			})
		);
		await expect(
			h2['agents.dispatch']!('p', { agentId: 'a', prompt: 'write a friendly summary' })
		).rejects.toThrow(/permission denied/);
		expect(dispatch).not.toHaveBeenCalled();
	});

	it('rejects every out-of-schema dispatch field before any side effect (closed schema)', async () => {
		const dispatch = vi.fn(async () => 'dispatched');
		const h = buildHostCallHandlers(
			makeDeps({
				broker: brokerFor(() => [scopedGrant('agents:dispatch', 'a')]),
				isPluginTrusted: () => true,
				dispatch,
			})
		);
		for (const extra of [
			{ opts: { model: 'gpt' } },
			{ skipPermissions: true },
			{ force: true },
			{ concurrency: 9 },
			{ env: { PATH: '/tmp' } },
			{ cwd: '/tmp' },
			{ model: 'x' },
			{ permissionMode: 'bypass' },
		]) {
			await expect(
				h['agents.dispatch']!('p', { agentId: 'a', prompt: 'friendly summary', ...extra })
			).rejects.toThrow(/closed schema/);
		}
		expect(dispatch).not.toHaveBeenCalled();
	});

	it('denies untrusted plugins before dispatch side effects', async () => {
		const dispatch = vi.fn(async () => 'dispatched');
		const h = buildHostCallHandlers(
			makeDeps({
				broker: brokerFor(() => [scopedGrant('agents:dispatch', 'a')]),
				isPluginTrusted: () => false,
				dispatch,
			})
		);
		await expect(
			h['agents.dispatch']!('p', { agentId: 'a', prompt: 'write a friendly summary' })
		).rejects.toThrow(/trusted signed plugin/);
		expect(dispatch).not.toHaveBeenCalled();
	});

	it('spawns only a host-blessed binary name, handing the sink a host-owned spec', async () => {
		const spawn = vi.fn(async () => 'spawned');
		const h = buildHostCallHandlers(
			makeDeps({
				broker: brokerFor(() => [scopedGrant('process:spawn', 'echo-tool')]),
				isPluginTrusted: () => true,
				spawn,
				resolveSpawnBinary,
			})
		);
		await expect(
			h['process.spawn']!('p', { command: 'echo-tool', opts: { args: ['hello'] } })
		).resolves.toBe('spawned');
		// Everything except args is host-owned; plugin args come AFTER baseArgs.
		expect(spawn).toHaveBeenCalledWith('p', {
			name: 'echo-tool',
			binaryPath: echoEntry.binaryPath,
			args: ['--safe', 'hello'],
			env: { SAFE_FLAG: '1' },
		});
	});

	it('denies spawn without a grant naming the binary, and stale grants take effect immediately', async () => {
		let grants: PermissionGrant[] = [];
		const spawn = vi.fn(async () => 'spawned');
		const h = buildHostCallHandlers(
			makeDeps({
				broker: brokerFor(() => grants),
				isPluginTrusted: () => true,
				spawn,
				resolveSpawnBinary,
			})
		);
		await expect(h['process.spawn']!('p', { command: 'echo-tool' })).rejects.toThrow(
			/permission denied/
		);
		grants = [scopedGrant('process:spawn', 'echo-tool')];
		await expect(h['process.spawn']!('p', { command: 'echo-tool' })).resolves.toBe('spawned');
		grants = [];
		await expect(h['process.spawn']!('p', { command: 'echo-tool' })).rejects.toThrow(
			/permission denied/
		);
		expect(spawn).toHaveBeenCalledTimes(1);
	});

	it('denies a granted-but-unregistered binary name (empty host registry = deny)', async () => {
		const spawn = vi.fn(async () => 'spawned');
		const h = buildHostCallHandlers(
			makeDeps({
				broker: brokerFor(() => [scopedGrant('process:spawn', 'ghost-tool')]),
				isPluginTrusted: () => true,
				spawn,
				// No resolveSpawnBinary at all: the default is DENY.
			})
		);
		await expect(h['process.spawn']!('p', { command: 'ghost-tool' })).rejects.toThrow(
			/not a host-approved binary/
		);
		expect(spawn).not.toHaveBeenCalled();
	});

	it('rejects plugin-supplied env/cwd/shell/detached on spawn (closed schema)', async () => {
		const spawn = vi.fn(async () => 'spawned');
		const h = buildHostCallHandlers(
			makeDeps({
				broker: brokerFor(() => [scopedGrant('process:spawn', 'echo-tool')]),
				isPluginTrusted: () => true,
				spawn,
				resolveSpawnBinary,
			})
		);
		for (const opts of [
			{ env: { API_TOKEN: 'secret' } },
			{ cwd: '/tmp' },
			{ shell: true },
			{ detached: true },
			{ force: true },
		]) {
			await expect(h['process.spawn']!('p', { command: 'echo-tool', opts })).rejects.toThrow(
				/closed schema/
			);
		}
		await expect(h['process.spawn']!('p', { command: 'echo-tool', shell: true })).rejects.toThrow(
			/closed schema/
		);
		expect(spawn).not.toHaveBeenCalled();
	});

	it('denies high-risk dispatch/spawn text before side effects (risk tripwire)', async () => {
		const dispatch = vi.fn(async () => 'dispatched');
		const spawn = vi.fn(async () => 'spawned');
		const h = buildHostCallHandlers(
			makeDeps({
				broker: brokerFor(() => [
					scopedGrant('agents:dispatch', 'a'),
					scopedGrant('process:spawn', 'echo-tool'),
				]),
				isPluginTrusted: () => true,
				dispatch,
				spawn,
				resolveSpawnBinary,
			})
		);
		await expect(
			h['agents.dispatch']!('p', { agentId: 'a', prompt: 'delete the production database' })
		).rejects.toThrow(/high-risk prompt/);
		await expect(
			h['process.spawn']!('p', {
				command: 'echo-tool',
				opts: { args: ['&&', 'rm', '-rf', '/'] },
			})
		).rejects.toThrow(/high-risk prompt/);
		expect(dispatch).not.toHaveBeenCalled();
		expect(spawn).not.toHaveBeenCalled();
	});

	it('denies when the ActionGuard refuses before act-verb side effects', async () => {
		const spawn = vi.fn(async () => 'spawned');
		const actionGuard = new ActionGuard({
			limits: { high: { windowMs: 1000, maxPerWindow: 0, maxConcurrent: 1 } },
		});
		const h = buildHostCallHandlers(
			makeDeps({
				broker: brokerFor(() => [scopedGrant('process:spawn', 'echo-tool')]),
				actionGuard,
				isPluginTrusted: () => true,
				spawn,
				resolveSpawnBinary,
			})
		);
		await expect(h['process.spawn']!('p', { command: 'echo-tool' })).rejects.toThrow(/limit/);
		expect(spawn).not.toHaveBeenCalled();
	});
});

describe('brokered non-act host API breadth', () => {
	it('re-authorizes read methods on every direct handler call so revokes take effect immediately', async () => {
		let grants: PermissionGrant[] = [grant('sessions:read')];
		const sessionsList = vi.fn(() => [{ id: 's1', title: 'One' }]);
		const h = buildHostCallHandlers(makeDeps({ broker: brokerFor(() => grants), sessionsList }));

		await expect(h['sessions.list']!('p', {})).resolves.toEqual([{ id: 's1', title: 'One' }]);
		grants = [];
		await expect(h['sessions.list']!('p', {})).rejects.toThrow(/permission denied/);
		expect(sessionsList).toHaveBeenCalledTimes(1);
	});

	it('allows session create/update/delete and denies stale or disabled write paths cleanly', async () => {
		let current: PluginSessionMetadata | null = null;
		const h = buildHostCallHandlers(
			makeDeps({
				broker: brokerFor(() => [grant('sessions:create'), grant('sessions:write')]),
				sessionsGet: (id) => (current?.id === id ? current : null),
				sessionsCreate: async () => {
					current = { id: 's1', title: 'Created', projectPath: '/repo' };
					return current;
				},
				sessionsUpdate: async (id, patch) => {
					if (current?.id !== id) return null;
					current = {
						...current,
						...(typeof patch.title === 'string' ? { title: patch.title } : {}),
					};
					return current;
				},
				sessionsDelete: async (id) => {
					if (current?.id !== id) return false;
					current = null;
					return true;
				},
			})
		);

		await expect(h['sessions.create']!('p', { title: 'Created' })).resolves.toEqual({
			id: 's1',
			title: 'Created',
			projectPath: '/repo',
		});
		await expect(
			h['sessions.update']!('p', { sessionId: 's1', patch: { title: 'Renamed' } })
		).resolves.toEqual({ id: 's1', title: 'Renamed', projectPath: '/repo' });
		await expect(h['sessions.update']!('p', { sessionId: 'missing', patch: {} })).rejects.toThrow(
			/unknown sessionId/
		);
		await expect(h['sessions.delete']!('p', { sessionId: 's1' })).resolves.toEqual({ ok: true });

		const disabled = buildHostCallHandlers(
			makeDeps({ broker: brokerFor(() => [grant('sessions:create')]) })
		);
		await expect(disabled['sessions.create']!('p', {})).rejects.toThrow(/unavailable/);
	});

	it('manages tabs through injected tab deps and denies stale tab ids cleanly', async () => {
		const tabs = new Map([
			['t1', { id: 't1', sessionId: 's1', type: 'ai' as const, title: 'One' }],
		]);
		const h = buildHostCallHandlers(
			makeDeps({
				broker: brokerFor(() => [grant('tabs:manage')]),
				tabsList: () => [...tabs.values()],
				tabsCreate: async () => {
					const tab = { id: 't2', sessionId: 's1', type: 'ai' as const, title: 'Two' };
					tabs.set(tab.id, tab);
					return tab;
				},
				tabsFocus: async (id) => tabs.has(id),
				tabsClose: async (id) => tabs.delete(id),
			})
		);

		await expect(h['tabs.list']!('p', {})).resolves.toHaveLength(1);
		await expect(h['tabs.create']!('p', { sessionId: 's1' })).resolves.toEqual(
			expect.objectContaining({ id: 't2' })
		);
		await expect(h['tabs.focus']!('p', { tabId: 't2' })).resolves.toEqual({ ok: true });
		await expect(h['tabs.close']!('p', { tabId: 't2' })).resolves.toEqual({ ok: true });
		await expect(h['tabs.close']!('p', { tabId: 'stale' })).rejects.toThrow(/unknown tabId/);
	});

	it('projects history as metadata-only and keeps transcript append audited/project-authorized', async () => {
		const appended: unknown[] = [];
		const auditWrite = vi.fn();
		const h = buildHostCallHandlers(
			makeDeps({
				broker: brokerFor(() => [grant('history:read'), grant('transcripts:write')]),
				sessionsGet: (id) => (id === 's1' ? { id: 's1', projectPath: '/repo' } : null),
				listHistoryEntries: async () => [
					{
						id: 'h1',
						type: 'USER',
						timestamp: 1,
						summary: 'SECRET SUMMARY',
						fullResponse: 'SECRET FULL',
						projectPath: '/repo',
						sessionId: 's1',
					},
				],
				getHistoryEntry: async () => ({
					id: 'h1',
					type: 'USER',
					timestamp: 1,
					summary: 'SECRET SUMMARY',
					fullResponse: 'SECRET FULL',
					projectPath: '/repo',
					sessionId: 's1',
				}),
				appendSessionTranscript: async (_sessionId, _projectPath, entries) =>
					appended.push(...entries),
				auditTranscriptWrite: auditWrite,
			})
		);

		const list = await h['history.list']!('p', {});
		expect(JSON.stringify(list)).not.toContain('SECRET');
		await expect(h['history.get']!('p', { entryId: 'h1' })).resolves.toEqual(
			expect.objectContaining({ id: 'h1', sessionId: 's1', projectPath: '/repo' })
		);
		await expect(
			h['transcripts.append']!('p', {
				sessionId: 's1',
				projectPath: '/caller-lie',
				entries: [{ summary: 'new content', fullResponse: 'full content' }],
			})
		).resolves.toEqual({ ok: true, count: 1 });
		expect(appended).toEqual([
			expect.objectContaining({ sessionId: 's1', projectPath: '/repo', summary: 'new content' }),
		]);
		expect(auditWrite).toHaveBeenCalledWith(
			'p',
			expect.objectContaining({ sessionId: 's1', projectPath: '/repo', count: 1 })
		);
	});

	it('runs storage.sql through the plugin-owned SQL broker and denies stale grants', async () => {
		let grants: PermissionGrant[] = [grant('storage:sql')];
		const rowsByPlugin = new Map<string, Array<Record<string, unknown>>>();
		const runStorageSql = vi.fn((pluginId: string, query: string, params: unknown[]) => {
			const normalized = query.trim().toUpperCase();
			if (normalized.startsWith('ATTACH')) throw new Error('ATTACH is not permitted');
			const rows = rowsByPlugin.get(pluginId) ?? [];
			if (normalized.startsWith('CREATE TABLE')) {
				rowsByPlugin.set(pluginId, rows);
				return { columns: [], rows: [], rowCount: 0, truncated: false, changes: 0 };
			}
			if (normalized.startsWith('INSERT')) {
				rows.push({ name: params[0] });
				rowsByPlugin.set(pluginId, rows);
				return { columns: [], rows: [], rowCount: 0, truncated: false, changes: 1 };
			}
			if (normalized.startsWith('SELECT')) {
				if (!rowsByPlugin.has(pluginId)) throw new Error('no such table: items');
				return { columns: ['name'], rows, rowCount: rows.length, truncated: false };
			}
			throw new Error('unsupported query');
		});
		const h = buildHostCallHandlers(makeDeps({ broker: brokerFor(() => grants), runStorageSql }));

		await h['storage.sql']!('p', { query: 'CREATE TABLE items (name TEXT)' });
		await h['storage.sql']!('p', {
			query: 'INSERT INTO items (name) VALUES (?)',
			params: ['alpha'],
		});
		await expect(h['storage.sql']!('p', { query: 'SELECT name FROM items' })).resolves.toEqual(
			expect.objectContaining({ rows: [{ name: 'alpha' }], rowCount: 1 })
		);
		await expect(h['storage.sql']!('other', { query: 'SELECT name FROM items' })).rejects.toThrow(
			/no such table/
		);
		await expect(
			h['storage.sql']!('p', { query: "ATTACH DATABASE '/tmp/x' AS x" })
		).rejects.toThrow(/not permitted/);
		grants = [];
		await expect(h['storage.sql']!('p', { query: 'SELECT 1' })).rejects.toThrow(
			/permission denied/
		);
		expect(runStorageSql).toHaveBeenCalledTimes(5);
	});

	it('brokers fs.watch, power handles, and background service lifecycle with clean stale-id denial', async () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-watch-'));
		const file = path.join(tmp, 'watched.txt');
		fs.writeFileSync(file, 'start', 'utf-8');
		const prevent = vi.fn();
		const release = vi.fn();
		const h = buildHostCallHandlers(
			makeDeps({
				broker: brokerFor(() => [
					grant('fs:watch'),
					grant('power:preventSleep'),
					grant('background:service'),
				]),
				powerPreventSleep: prevent,
				powerReleaseSleep: release,
			})
		);
		try {
			await expect(h['fs.watch']!('p', { path: file, opts: { once: true } })).resolves.toEqual(
				expect.objectContaining({ path: fs.realpathSync(file), watchId: expect.any(String) })
			);
			const sleep = (await h['power.preventSleep']!('p', { reason: 'work' })) as {
				handleId: string;
			};
			expect(prevent).toHaveBeenCalledWith(expect.stringContaining('plugin:p:work:'));
			await expect(h['power.releaseSleep']!('p', sleep)).resolves.toEqual({ ok: true });
			expect(release).toHaveBeenCalledTimes(1);
			await expect(h['power.releaseSleep']!('p', sleep)).rejects.toThrow(/unknown sleep handle/);

			const registered = (await h['background.register']!('p', { service: { id: 'svc' } })) as {
				serviceId: string;
			};
			expect(registered).toEqual({ serviceId: 'svc' });
			await expect(h['background.unregister']!('p', registered)).resolves.toEqual({ ok: true });
			await expect(h['background.unregister']!('p', registered)).rejects.toThrow(
				/unknown background service/
			);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
});

describe('background service supervision (delegated handlers)', () => {
	it('delegates register/unregister/list to the injected supervisor and gates on the live grant', async () => {
		let grants = [grant('background:service')];
		const supervisor = new PluginBackgroundSupervisor({
			restartPlugin: vi.fn(),
			isPluginEnabled: () => true,
		});
		const h = buildHostCallHandlers(
			makeDeps({
				broker: brokerFor(() => grants),
				backgroundRegister: async (pluginId, service) => supervisor.register(pluginId, service),
				backgroundUnregister: async (pluginId, serviceId) =>
					supervisor.unregister(pluginId, serviceId),
				backgroundList: (pluginId) => supervisor.health(pluginId),
			})
		);

		await expect(
			h['background.register']!('p', { service: { id: 'svc', name: 'poller' } })
		).resolves.toEqual({ serviceId: 'svc' });
		await expect(h['background.list']!('p', {})).resolves.toEqual(
			expect.objectContaining({
				pluginId: 'p',
				state: 'running',
				restarts: 0,
				services: [expect.objectContaining({ id: 'svc', name: 'poller' })],
			})
		);
		// The list is per-plugin: another plugin sees only its own (empty) view.
		await expect(h['background.list']!('other', {})).resolves.toEqual(
			expect.objectContaining({ pluginId: 'other', state: 'stopped', services: [] })
		);

		await expect(h['background.unregister']!('p', { serviceId: 'svc' })).resolves.toEqual({
			ok: true,
		});
		await expect(h['background.unregister']!('p', { serviceId: 'svc' })).rejects.toThrow(
			/unknown background service/
		);

		// Revoked live grant fails closed on every verb.
		grants = [];
		await expect(h['background.register']!('p', { service: { id: 'x' } })).rejects.toThrow(
			/permission denied/
		);
		await expect(h['background.list']!('p', {})).rejects.toThrow(/permission denied/);
	});

	it('reports supervised restart state through background.list after a crash', async () => {
		const supervisor = new PluginBackgroundSupervisor({
			restartPlugin: vi.fn(),
			isPluginEnabled: () => true,
		});
		const h = buildHostCallHandlers(
			makeDeps({
				broker: brokerFor(() => [grant('background:service')]),
				backgroundRegister: async (pluginId, service) => supervisor.register(pluginId, service),
				backgroundList: (pluginId) => supervisor.health(pluginId),
			})
		);

		await h['background.register']!('p', { service: { id: 'svc' } });
		supervisor.onPluginCrash('p', 1);
		await expect(h['background.list']!('p', {})).resolves.toEqual(
			expect.objectContaining({
				state: 'restarting',
				restarts: 1,
				services: [],
				lastError: expect.stringMatching(/code 1/),
			})
		);
	});

	it('falls back to the in-memory map for list when no supervisor is injected', async () => {
		const h = buildHostCallHandlers(
			makeDeps({ broker: brokerFor(() => [grant('background:service')]) })
		);
		await expect(h['background.list']!('p', {})).resolves.toEqual(
			expect.objectContaining({ pluginId: 'p', state: 'stopped', services: [] })
		);
		await h['background.register']!('p', { service: { id: 'svc', name: 'poller' } });
		await expect(h['background.list']!('p', {})).resolves.toEqual(
			expect.objectContaining({
				state: 'running',
				services: [{ id: 'svc', name: 'poller' }],
			})
		);
	});
});

describe('resource cleanup on plugin stop', () => {
	it('releases a stopped plugin wake lock and closes its fs watcher once', async () => {
		let cleanup: ((pluginId: string) => void) | undefined;
		const registerResourceCleanup = vi.fn((fn: (pluginId: string) => void) => {
			cleanup = fn;
		});
		const powerPreventSleep = vi.fn();
		const powerReleaseSleep = vi.fn();
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-cleanup-'));
		const probe = fs.watch(tmp, { persistent: false }, () => {});
		const watcherPrototype = Object.getPrototypeOf(probe);
		probe.close();
		const closeSpy = vi.spyOn(watcherPrototype, 'close');
		const h = buildHostCallHandlers(
			makeDeps({
				broker: brokerFor(() => [grant('power:preventSleep'), grant('fs:watch')]),
				powerPreventSleep,
				powerReleaseSleep,
				registerResourceCleanup,
			})
		);

		try {
			expect(registerResourceCleanup).toHaveBeenCalledTimes(1);
			expect(cleanup).toBeDefined();

			const sleep = (await h['power.preventSleep']!('p', { reason: 'sync' })) as {
				handleId: string;
			};
			await expect(h['fs.watch']!('p', { path: tmp })).resolves.toEqual(
				expect.objectContaining({ path: fs.realpathSync(tmp), watchId: expect.any(String) })
			);
			const expectedReason = `plugin:p:sync:${sleep.handleId}`;

			cleanup!('p');

			expect(powerReleaseSleep).toHaveBeenCalledTimes(1);
			expect(powerReleaseSleep).toHaveBeenCalledWith(expectedReason);
			expect(closeSpy).toHaveBeenCalledTimes(1);
			await expect(h['power.releaseSleep']!('p', sleep)).rejects.toThrow(/unknown sleep handle/);

			expect(() => cleanup!('p')).not.toThrow();
			expect(powerReleaseSleep).toHaveBeenCalledTimes(1);
			expect(closeSpy).toHaveBeenCalledTimes(1);
		} finally {
			try {
				cleanup?.('p');
			} catch {
				// already cleaned
			}
			closeSpy.mockRestore();
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	it('does not clean another plugin resources', async () => {
		let cleanup: ((pluginId: string) => void) | undefined;
		const registerResourceCleanup = vi.fn((fn: (pluginId: string) => void) => {
			cleanup = fn;
		});
		const powerReleaseSleep = vi.fn();
		const tmpA = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-cleanup-a-'));
		const tmpB = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-cleanup-b-'));
		const probe = fs.watch(tmpA, { persistent: false }, () => {});
		const watcherPrototype = Object.getPrototypeOf(probe);
		probe.close();
		const closeSpy = vi.spyOn(watcherPrototype, 'close');
		const h = buildHostCallHandlers(
			makeDeps({
				broker: brokerFor(() => [grant('power:preventSleep'), grant('fs:watch')]),
				powerPreventSleep: vi.fn(),
				powerReleaseSleep,
				registerResourceCleanup,
			})
		);

		try {
			expect(cleanup).toBeDefined();

			const sleepA = (await h['power.preventSleep']!('a', { reason: 'a-work' })) as {
				handleId: string;
			};
			const sleepB = (await h['power.preventSleep']!('b', { reason: 'b-work' })) as {
				handleId: string;
			};
			await h['fs.watch']!('a', { path: tmpA });
			await h['fs.watch']!('b', { path: tmpB });
			const reasonA = `plugin:a:a-work:${sleepA.handleId}`;
			const reasonB = `plugin:b:b-work:${sleepB.handleId}`;

			cleanup!('a');

			expect(powerReleaseSleep).toHaveBeenCalledTimes(1);
			expect(powerReleaseSleep).toHaveBeenCalledWith(reasonA);
			expect(powerReleaseSleep).not.toHaveBeenCalledWith(reasonB);
			expect(closeSpy).toHaveBeenCalledTimes(1);

			await expect(h['power.releaseSleep']!('b', sleepB)).resolves.toEqual({ ok: true });
			expect(powerReleaseSleep).toHaveBeenCalledTimes(2);
			expect(powerReleaseSleep).toHaveBeenLastCalledWith(reasonB);
			expect(closeSpy).toHaveBeenCalledTimes(1);

			cleanup!('b');
			expect(closeSpy).toHaveBeenCalledTimes(2);
			expect(powerReleaseSleep).toHaveBeenCalledTimes(2);
		} finally {
			try {
				cleanup?.('a');
				cleanup?.('b');
			} catch {
				// already cleaned
			}
			closeSpy.mockRestore();
			fs.rmSync(tmpA, { recursive: true, force: true });
			fs.rmSync(tmpB, { recursive: true, force: true });
		}
	});
});

describe('ui.groupingPublish / ui.groupingClear', () => {
	it('requires a declared grouping, drops unknown sessions, and retains no session mutations', async () => {
		const groupingRegistry = new PluginGroupingRegistry();
		const sessions: PluginSessionMetadata[] = [
			{ id: 'known', title: 'Known session' },
			{ id: 'other', title: 'Other session' },
		];
		const h = buildHostCallHandlers(
			makeDeps({
				groupingRegistry,
				isDeclaredGrouping: (pluginId, localId) =>
					pluginId === 'com.acme' && localId === 'by-agent-type',
				sessionsList: () => sessions,
			})
		);

		await h['ui.groupingPublish']!('com.acme', {
			id: 'by-agent-type',
			groups: [{ id: 'claude', label: 'Claude' }],
			assignments: { known: 'claude', missing: 'claude' },
		});

		expect(groupingRegistry.snapshot()).toEqual([
			expect.objectContaining({ assignments: { known: 'claude' } }),
		]);
		expect(sessions).toEqual([
			{ id: 'known', title: 'Known session' },
			{ id: 'other', title: 'Other session' },
		]);
		await expect(
			h['ui.groupingPublish']!('com.acme', {
				id: 'not-declared',
				groups: [],
				assignments: {},
			})
		).rejects.toThrow(/not declared/);
	});

	it('denies publication without ui:grouping and rejects unknown payload fields', async () => {
		const h = buildHostCallHandlers(
			makeDeps({
				broker: brokerFor(() => []),
				groupingRegistry: new PluginGroupingRegistry(),
				isDeclaredGrouping: () => true,
			})
		);

		await expect(
			h['ui.groupingPublish']!('com.acme', {
				id: 'by-agent-type',
				groups: [],
				assignments: {},
				extra: true,
			})
		).rejects.toThrow(/unexpected field/);
		await expect(
			h['ui.groupingPublish']!('com.acme', {
				id: 'by-agent-type',
				groups: [],
				assignments: {},
			})
		).rejects.toThrow(/permission denied/);
	});
});

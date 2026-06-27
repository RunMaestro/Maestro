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
		runUiCommand: () => true,
		listAgents: () => [],
	};
	return { ...base, ...over };
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
	it('purges KV, namespaced settings, and event subscriptions', async () => {
		kv.set('p', 'k', 'v');
		const bus = new PluginEventBusImpl({ isPermitted: () => true, push: () => true });
		bus.subscribe('p', ['session.created']);
		const settingsDeleteNamespace = vi.fn();
		purgePluginData('p', { kvStore: kv, settingsDeleteNamespace, eventBus: bus });
		expect(kv.get('p', 'k')).toBeNull();
		expect(settingsDeleteNamespace).toHaveBeenCalledWith('plugins.p.');
		expect(bus.topicsFor('p')).toEqual([]);
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

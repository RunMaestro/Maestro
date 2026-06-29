import { describe, expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { BridgeHandlers } from '../bridge-core';
import { startBridgeHost } from '../mae-bridge-host';
import { parseDiscovery } from '../protocol';

function fakeHandlers(rec: { registered: string[]; toasts: number }): BridgeHandlers {
	return {
		listSessions: async () => [{ id: 's1', title: 'Build', status: 'busy', projectPath: '/r' }],
		listPlaybooks: async () => [{ id: 'p1', name: 'Ship' }],
		observeCues: async () => [{ name: 'c1' }],
		toast: async () => {
			rec.toasts += 1;
		},
		registerSession: async (params) => {
			rec.registered.push(params.ompSessionId);
		},
		recordEvent: async () => undefined,
		endSession: async () => undefined,
	};
}

async function post(
	url: string,
	body: unknown,
	token?: string
): Promise<{ status: number; json: unknown }> {
	const headers: Record<string, string> = { 'content-type': 'application/json' };
	if (token) headers.authorization = `Bearer ${token}`;
	const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
	return { status: res.status, json: await res.json() };
}

function tokenOf(value: unknown): string {
	if (value && typeof value === 'object' && 'token' in value && typeof value.token === 'string') {
		return value.token;
	}
	return '';
}

describe('mae-bridge-host', () => {
	test('binds loopback, issues a scoped token, serves verbs, writes 0600 discovery, cleans up', async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mae-host-'));
		const discovery = path.join(dir, 'mae-bridge.json');
		const rec = { registered: [] as string[], toasts: 0 };
		const host = await startBridgeHost({
			handlers: fakeHandlers(rec),
			env: { MAE_BRIDGE_DISCOVERY: discovery },
			secret: 'boot-secret',
		});
		try {
			expect(host.url.startsWith('http://127.0.0.1:')).toBe(true);

			const disc = parseDiscovery(JSON.parse(await fs.readFile(discovery, 'utf8')));
			expect(disc?.url).toBe(host.url);
			expect(disc?.secret).toBe('boot-secret');

			if (process.platform !== 'win32') {
				const mode = (await fs.stat(discovery)).mode & 0o777;
				expect(mode).toBe(0o600);
			}

			const issued = await post(`${host.url}/v1/sessions/issue`, {
				secret: 'boot-secret',
				runId: 'run-1',
				cwd: '/r',
			});
			expect(issued.status).toBe(200);
			const token = tokenOf(issued.json);
			expect(token).not.toBe('');

			expect((await post(`${host.url}/v1/bridge`, { verb: 'sessions.list' }, token)).status).toBe(
				200
			);

			const reg = await post(
				`${host.url}/v1/bridge`,
				{
					verb: 'session.register',
					params: {
						runId: 'run-1',
						ompSessionId: '/s/a.jsonl',
						cwd: '/r',
						engine: 'omp',
						startedAt: 1,
					},
				},
				token
			);
			expect(reg.status).toBe(200);
			expect(rec.registered).toContain('/s/a.jsonl');

			expect(
				(await post(`${host.url}/v1/bridge`, { verb: 'agent.dispatch', params: {} }, token)).status
			).toBe(403);
			expect(
				(await post(`${host.url}/v1/sessions/issue`, { secret: 'WRONG', runId: 'r', cwd: '/r' }))
					.status
			).toBe(401);
		} finally {
			await host.close();
		}

		let removed = false;
		try {
			await fs.stat(discovery);
		} catch {
			removed = true;
		}
		expect(removed).toBe(true);
	});

	test('writeDiscovery:false starts without a discovery file', async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mae-host-'));
		const discovery = path.join(dir, 'mae-bridge.json');
		const rec = { registered: [] as string[], toasts: 0 };
		const host = await startBridgeHost({
			handlers: fakeHandlers(rec),
			env: { MAE_BRIDGE_DISCOVERY: discovery },
			writeDiscovery: false,
		});
		try {
			expect(host.discoveryPath).toBeUndefined();
			let exists = true;
			try {
				await fs.stat(discovery);
			} catch {
				exists = false;
			}
			expect(exists).toBe(false);
		} finally {
			await host.close();
		}
	});

	test('rejects a non-loopback bind', async () => {
		const rec = { registered: [] as string[], toasts: 0 };
		let threw = false;
		try {
			await startBridgeHost({
				handlers: fakeHandlers(rec),
				host: '0.0.0.0',
				writeDiscovery: false,
			});
		} catch {
			threw = true;
		}
		expect(threw).toBe(true);
	});

	test('rejects (and tears down) when the discovery write fails', async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mae-host-'));
		const fileAsDir = path.join(dir, 'not-a-dir');
		await fs.writeFile(fileAsDir, 'x');
		// Parent of the discovery path is a file -> mkdir fails -> write throws.
		const badDiscovery = path.join(fileAsDir, 'sub', 'mae-bridge.json');
		const rec = { registered: [] as string[], toasts: 0 };
		let threw = false;
		try {
			await startBridgeHost({
				handlers: fakeHandlers(rec),
				env: { MAE_BRIDGE_DISCOVERY: badDiscovery },
			});
		} catch {
			threw = true;
		}
		expect(threw).toBe(true);
	});
});

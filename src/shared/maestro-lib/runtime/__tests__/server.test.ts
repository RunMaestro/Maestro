/**
 * The detached host's transport, end to end: a real runtime on a temp data directory, served by
 * `startRuntimeServer`, read by the real `createWsMaestroClient`. Nothing is faked between the two
 * but the clock, the pid probe, and the provider probe, so a request the client sends is answered
 * by the same handler a `maestro-cli host` answers it with.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CLI_SECRET_HEADER } from '../../../webLogin';
import { DEFAULT_TAB_DEFAULTS } from '../../agents/rules';
import { writeCliServerInfoTo } from '../../client/discovery';
import { requestHostStatus, requestHostStop } from '../../client/host-control';
import type { ClientResult, MaestroClient, MaestroEvent } from '../../client/types';
import { createWsMaestroClient } from '../../client/ws-client';
import { createMaestroRuntime, type MaestroRuntime, type RuntimeDeps } from '../index';
import { startRuntimeServer, type RuntimeServer } from '../server';
import type { WatchDirectory } from '../settings-watch';

const T0 = Date.parse('2026-10-04T12:00:00Z');
const TOKEN = 'test-token';
const SECRET = 'test-secret';

function value<T>(result: ClientResult<T>): T {
	if (!result.ok) throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
	return result.value;
}
function errorOf(result: ClientResult<unknown>) {
	if (result.ok) throw new Error('expected a failure');
	return result.error;
}

async function waitFor(check: () => boolean, what: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!check()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe('runtime server', () => {
	let dir: string;
	let runtime: MaestroRuntime;
	let server: RuntimeServer;
	let client: MaestroClient;
	let stopRequests: number;
	let inFlight: { turns: number };

	const watchDirectory: WatchDirectory = () => ({ close: () => undefined });

	function deps(): Partial<RuntimeDeps> {
		let id = 0;
		let now = 1_000;
		return {
			pid: 100,
			now: () => T0,
			bootTime: () => T0 - 3_600_000,
			isPidAlive: (pid) => pid === 100,
			hostname: () => 'testhost',
			rules: { newId: () => `id-${++id}`, now: () => ++now, random: () => 0 },
			checkCwd: () => null,
			readTabDefaults: async () => DEFAULT_TAB_DEFAULTS,
			watchDirectory,
			probeBinary: async (binaryName) => ({ exists: true, path: `/fake/bin/${binaryName}` }),
		};
	}

	function publish(overrides: Partial<{ token: string; cliSecret: string }> = {}): void {
		writeCliServerInfoTo(dir, {
			port: server.port,
			token: overrides.token ?? TOKEN,
			pid: process.pid,
			startedAt: Date.now(),
			cliSecret: overrides.cliSecret ?? SECRET,
			hostKind: 'headless',
		});
	}

	beforeEach(async () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-server-'));
		fs.writeFileSync(
			path.join(dir, 'maestro-sessions.json'),
			JSON.stringify({
				sessions: [
					{
						id: 'a1',
						name: 'Alpha',
						toolType: 'claude-code',
						cwd: dir,
						projectRoot: dir,
						aiTabs: [
							{
								id: 't1',
								agentSessionId: null,
								name: null,
								logs: [{ id: 'l1', timestamp: 10, source: 'user', text: 'hello' }],
							},
						],
						activeTabId: 't1',
						unifiedTabOrder: [{ type: 'ai', id: 't1' }],
					},
				],
				activeSessionId: 'a1',
			})
		);
		const started = await createMaestroRuntime({ dataDir: dir, mode: 'host', deps: deps() });
		if (!started.ok) throw new Error(`refused: ${started.refusal.message}`);
		inFlight = { turns: 0 };
		// A wrapper so a test can claim work in flight without running a provider.
		runtime = new Proxy(started.runtime, {
			get: (target, key) =>
				key === 'turnsInFlight' ? () => inFlight.turns : Reflect.get(target, key),
		});
		stopRequests = 0;
		server = await startRuntimeServer({
			runtime,
			token: TOKEN,
			cliSecret: SECRET,
			onStopRequested: () => {
				stopRequests += 1;
			},
			describe: () => ({ cue: { state: 'disabled' }, version: '9.9.9' }),
		});
		publish();
		client = createWsMaestroClient({
			userDataDir: dir,
			reconcileIntervalMs: 0,
			heartbeatIntervalMs: 60_000,
		});
	});

	afterEach(async () => {
		await client.connection.close();
		await server.close();
		await runtime.connection.close();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('is attached as a headless host and reads the agents', async () => {
		const host = value(await client.connection.connect());
		expect(host.kind).toBe('headless');
		expect(host.label).toBe(`headless pid ${process.pid}`);
		const agents = value(await client.agents.list());
		expect(agents.map((agent) => agent.name)).toEqual(['Alpha']);
		expect(value(await client.tabs.transcript('a1', 't1')).map((entry) => entry.text)).toEqual([
			'hello',
		]);
	});

	it('creates, edits, and removes an agent through the runtime', async () => {
		value(await client.connection.connect());
		const { agentId } = value(
			await client.agents.create({ name: 'Beta', provider: 'claude-code', cwd: dir })
		);
		expect(value(await runtime.agents.get(agentId)).name).toBe('Beta');

		value(await client.agents.rename(agentId, 'Gamma'));
		const receipt = value(await client.agents.update(agentId, { model: 'opus' }));
		expect(receipt.applied).toEqual(['model']);
		const stored = value(await runtime.agents.get(agentId));
		expect(stored.name).toBe('Gamma');
		expect(stored.customModel).toBe('opus');

		value(await client.agents.remove(agentId));
		expect(errorOf(await runtime.agents.get(agentId)).code).toBe('not-found');
	});

	it('runs groups and tabs', async () => {
		value(await client.connection.connect());
		const { groupId } = value(await client.groups.create({ name: 'Work' }));
		value(await client.groups.moveAgent('a1', groupId));
		expect(value(await runtime.agents.get('a1')).groupId).toBe(groupId);
		value(await client.groups.rename(groupId, 'Play'));
		// Group names are stored upper-cased.
		expect(value(await runtime.groups.list()).map((group) => group.name)).toEqual(['PLAY']);
		value(await client.groups.remove(groupId));
		expect(value(await runtime.groups.list())).toEqual([]);

		const { tabId } = value(await client.tabs.create('a1'));
		value(await client.tabs.rename('a1', tabId, 'Notes'));
		value(await client.tabs.star('a1', tabId, true));
		value(await client.tabs.update('a1', tabId, { readOnly: true }));
		const tab = value(await runtime.tabs.list('a1')).find((candidate) => candidate.id === tabId);
		expect(tab).toMatchObject({ name: 'Notes', starred: true, readOnlyMode: true });
		value(await client.tabs.close('a1', tabId));
		expect(value(await runtime.tabs.list('a1')).map((candidate) => candidate.id)).toEqual(['t1']);
	});

	it('answers settings and providers', async () => {
		fs.writeFileSync(
			path.join(dir, 'maestro-settings.json'),
			JSON.stringify({ fontSize: 15, sshRemotes: [{ id: 'r1', name: 'box' }] })
		);
		value(await client.connection.connect());
		expect(value(await client.settings.get(['fontSize', 'missing']))).toEqual({ fontSize: 15 });
		expect(value(await client.settings.sshRemotes())).toEqual([{ id: 'r1', name: 'box' }]);
		const providers = value(await client.providers.list());
		expect(providers.find((provider) => provider.id === 'claude-code')?.available).toBe(true);
	});

	it('reports a missing agent as not found and a refused move as rejected', async () => {
		value(await client.connection.connect());
		expect(errorOf(await client.tabs.rename('nope', 't', 'x')).code).toBe('not-found');
		expect(errorOf(await client.turns.send('nope', 't', { text: 'hi' })).code).toBe('not-found');
		expect(errorOf(await client.autoRun.launchGoal('nope', { goal: 'x' })).code).toBe('not-found');
	});

	it('tells an attached client about a change another writer made', async () => {
		value(await client.connection.connect());
		const seen: MaestroEvent[] = [];
		client.events.subscribe((event) => seen.push(event), { types: ['agent.updated'] });
		value(await runtime.agents.rename('a1', 'Renamed'));
		await waitFor(
			() => seen.some((event) => event.type === 'agent.updated' && event.agent.name === 'Renamed'),
			'the rename'
		);
	});

	it('answers group chat and consult requests with a reason, not a crash', async () => {
		value(await client.connection.connect());
		expect(value(await client.groupChats.list())).toEqual([]);
		expect(errorOf(await client.groupChats.get('nope')).code).toBe('not-found');
		expect(errorOf(await client.groupChats.send('nope', 'hi')).code).toBe('rejected');
		expect(
			errorOf(await client.groupChats.create({ name: 'x', participantIds: ['nope'] })).code
		).toBe('not-found');
		expect(
			errorOf(await client.consults.ask({ targetAgentId: 'nope', question: 'hi' })).message
		).toMatch(/nope/);
	});

	describe('who may connect', () => {
		const url = (token = TOKEN) => `ws://127.0.0.1:${server.port}/${token}/ws`;

		/** Resolves with the HTTP status the upgrade was refused with, or 'open'. */
		function attempt(target: string, headers: Record<string, string>): Promise<number | 'open'> {
			return new Promise((resolve) => {
				const ws = new WebSocket(target, { headers });
				ws.on('open', () => {
					ws.close();
					resolve('open');
				});
				ws.on('unexpected-response', (_request, response) => resolve(response.statusCode ?? 0));
				ws.on('error', () => undefined);
			});
		}

		it('admits the token and the secret together', async () => {
			expect(await attempt(url(), { [CLI_SECRET_HEADER]: SECRET })).toBe('open');
		});

		it('refuses a wrong token, a wrong secret, and a missing secret', async () => {
			expect(await attempt(url('other'), { [CLI_SECRET_HEADER]: SECRET })).toBe(401);
			expect(await attempt(url(), { [CLI_SECRET_HEADER]: 'wrong' })).toBe(401);
			expect(await attempt(url(), {})).toBe(401);
		});

		it('refuses a browser, which always sends an Origin', async () => {
			expect(
				await attempt(url(), { [CLI_SECRET_HEADER]: SECRET, Origin: 'http://evil.example' })
			).toBe(403);
		});

		it('echoes a message it does not know, which a client reads as unsupported', async () => {
			const reply = await new Promise<Record<string, unknown>>((resolve, reject) => {
				const ws = new WebSocket(url(), { headers: { [CLI_SECRET_HEADER]: SECRET } });
				ws.on('error', reject);
				ws.on('open', () => ws.send(JSON.stringify({ type: 'no_such_message', requestId: 'r1' })));
				ws.on('message', (data) => {
					const frame = JSON.parse(data.toString()) as Record<string, unknown>;
					if (frame.type !== 'echo') return;
					ws.close();
					resolve(frame);
				});
			});
			expect(reply).toMatchObject({ originalType: 'no_such_message', originalRequestId: 'r1' });
		});
	});

	describe('host control', () => {
		it('reports the host', async () => {
			const report = await requestHostStatus(dir);
			expect(report).toMatchObject({
				pid: 100,
				version: '9.9.9',
				clients: 1,
				work: { turns: 0, runs: [] },
				cue: { state: 'disabled' },
			});
			expect(report.lock.mode).toBe('host');
		});

		it('refuses to stop while a turn is in flight, and stops when forced', async () => {
			inFlight.turns = 1;
			const refused = await requestHostStop(dir, {});
			expect(refused).toEqual({
				stopping: false,
				reason: 'work-in-flight',
				work: { turns: 1, runs: [], rounds: 0, consults: 0 },
			});
			expect(stopRequests).toBe(0);

			const forced = await requestHostStop(dir, { force: true });
			expect(forced).toEqual({ stopping: true });
			await vi.waitFor(() => expect(stopRequests).toBe(1));
		});

		it('stops an idle host without force', async () => {
			expect(await requestHostStop(dir, {})).toEqual({ stopping: true });
			await vi.waitFor(() => expect(stopRequests).toBe(1));
		});
	});
});

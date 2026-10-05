import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ClientResult, MaestroEvent } from '../../client/types';
import { DEFAULT_TAB_DEFAULTS } from '../../agents/rules';
import { STORE_SCHEMA_KEY } from '../../store/io';
import { RUNTIME_LOCK_FILE_NAME } from '../data-dir-lock';
import {
	createMaestroRuntime,
	type MaestroRuntime,
	type MaestroRuntimeOptions,
	type RuntimeDeps,
	type RuntimeRefusal,
} from '../index';
import type { WatchDirectory } from '../settings-watch';

const T0 = Date.parse('2026-10-04T12:00:00Z');
const BOOT = T0 - 3_600_000;
const confText = (doc: unknown) => JSON.stringify(doc, null, '\t');

function value<T>(result: ClientResult<T>): T {
	if (!result.ok) throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
	return result.value;
}
function errorOf(result: ClientResult<unknown>) {
	if (result.ok) throw new Error('expected a failure');
	return result.error;
}

describe('createMaestroRuntime', () => {
	let dir: string;
	let alive: Set<number>;
	let open: MaestroRuntime[];
	let watchListener: ((event: string, name: string | null) => void) | undefined;

	const lockFile = () => path.join(dir, RUNTIME_LOCK_FILE_NAME);
	const sessionsFile = () => path.join(dir, 'maestro-sessions.json');
	const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf-8'));

	const watchDirectory: WatchDirectory = (_dir, listener) => {
		watchListener = listener;
		return { close: () => undefined };
	};

	function deps(pid: number, extra: Partial<RuntimeDeps> = {}): Partial<RuntimeDeps> {
		let id = 0;
		let now = 1_000;
		return {
			pid,
			now: () => T0,
			bootTime: () => BOOT,
			isPidAlive: (candidate) => alive.has(candidate),
			hostname: () => 'testhost',
			rules: { newId: () => `id-${pid}-${++id}`, now: () => ++now, random: () => 0 },
			checkCwd: () => null,
			readTabDefaults: async () => DEFAULT_TAB_DEFAULTS,
			watchDirectory,
			...extra,
		};
	}

	async function start(
		pid = 100,
		extra: Partial<MaestroRuntimeOptions> = {},
		depsExtra: Partial<RuntimeDeps> = {}
	): Promise<MaestroRuntime> {
		const started = await createMaestroRuntime({
			dataDir: dir,
			mode: 'tui',
			deps: deps(pid, depsExtra),
			...extra,
		});
		if (!started.ok) throw new Error(`refused: ${started.refusal.message}`);
		open.push(started.runtime);
		return started.runtime;
	}

	async function refusal(
		pid = 200,
		extra: Partial<MaestroRuntimeOptions> = {}
	): Promise<RuntimeRefusal> {
		const started = await createMaestroRuntime({
			dataDir: dir,
			mode: 'tui',
			deps: deps(pid),
			...extra,
		});
		if (started.ok) {
			open.push(started.runtime);
			throw new Error('expected a refusal');
		}
		return started.refusal;
	}

	const seedAgent = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
		id,
		name,
		toolType: 'claude-code',
		cwd: `/work/${id}`,
		projectRoot: `/work/${id}`,
		aiTabs: [
			{
				id: `${id}-t1`,
				agentSessionId: null,
				name: null,
				starred: false,
				logs: [
					{ id: 'l1', timestamp: 10, source: 'user', text: 'one' },
					{ id: 'l2', timestamp: 20, source: 'ai', text: 'two' },
					{ id: 'l3', timestamp: 30, source: 'ai', text: 'three' },
				],
			},
		],
		activeTabId: `${id}-t1`,
		unifiedTabOrder: [{ type: 'ai', id: `${id}-t1` }],
		...extra,
	});

	function seed(sessions: unknown[] = [seedAgent('a1', 'Alpha')]) {
		fs.writeFileSync(sessionsFile(), confText({ sessions, activeSessionId: 'a1' }));
	}

	function collect(runtime: MaestroRuntime): MaestroEvent[] {
		const events: MaestroEvent[] = [];
		runtime.events.subscribe((event) => events.push(event));
		return events;
	}

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-runtime-test-'));
		alive = new Set([100, 200, 300]);
		open = [];
		watchListener = undefined;
	});
	afterEach(async () => {
		vi.useRealTimers();
		for (const runtime of open) await runtime.connection.close();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	// -----------------------------------------------------------------------

	describe('the start rule', () => {
		it('uses the directory it was given and never reads MAESTRO_USER_DATA', async () => {
			const other = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-runtime-other-'));
			const saved = process.env.MAESTRO_USER_DATA;
			process.env.MAESTRO_USER_DATA = other;
			try {
				const runtime = await start();
				expect(runtime.paths.userDataDir).toBe(dir);
				expect(fs.existsSync(lockFile())).toBe(true);
				expect(fs.readdirSync(other)).toEqual([]);
			} finally {
				if (saved === undefined) delete process.env.MAESTRO_USER_DATA;
				else process.env.MAESTRO_USER_DATA = saved;
				fs.rmSync(other, { recursive: true, force: true });
			}
		});

		it('refuses a data directory that is not there and creates nothing', async () => {
			const missing = path.join(dir, 'not-here');
			const started = await createMaestroRuntime({
				dataDir: missing,
				mode: 'tui',
				deps: deps(100),
			});
			if (started.ok) throw new Error('expected a refusal');
			expect(started.refusal).toMatchObject({ reason: 'data-dir-missing', tried: [missing] });
			expect(started.refusal.message).toContain(missing);
			expect(fs.existsSync(missing)).toBe(false);
		});

		it('creates the directory only when asked', async () => {
			const created = path.join(dir, 'fresh', 'maestro');
			const started = await createMaestroRuntime({
				dataDir: created,
				mode: 'tui',
				createDataDir: true,
				deps: deps(100),
			});
			if (!started.ok) throw new Error(started.refusal.message);
			open.push(started.runtime);
			expect(fs.existsSync(path.join(created, RUNTIME_LOCK_FILE_NAME))).toBe(true);
		});

		it('refuses a synced data directory unless allowed', async () => {
			fs.writeFileSync(
				path.join(dir, 'maestro-bootstrap.json'),
				JSON.stringify({ customSyncPath: '/Users/someone/Dropbox/maestro' })
			);
			const refused = await refusal(100);
			expect(refused).toMatchObject({
				reason: 'synced-data-dir',
				syncDir: '/Users/someone/Dropbox/maestro',
			});
			expect(fs.existsSync(lockFile())).toBe(false);
		});

		it('refuses while cli-server.json names a live desktop, and takes no lock', async () => {
			fs.writeFileSync(
				path.join(dir, 'cli-server.json'),
				JSON.stringify({ port: 7000, token: 't', pid: 300, startedAt: BOOT + 60_000 })
			);
			const refused = await refusal(100);
			expect(refused).toMatchObject({
				reason: 'host-running',
				attachable: true,
				host: { kind: 'desktop', pid: 300 },
			});
			expect(fs.existsSync(lockFile())).toBe(false);
			expect(fs.existsSync(sessionsFile())).toBe(false);
		});

		it('ignores a cli-server.json left by a desktop that is gone', async () => {
			fs.writeFileSync(
				path.join(dir, 'cli-server.json'),
				JSON.stringify({ port: 7000, token: 't', pid: 999, startedAt: BOOT + 60_000 })
			);
			await expect(start(100)).resolves.toBeTruthy();
		});

		it('refuses a second runtime on one directory and names the first', async () => {
			const first = await start(100);
			const refused = await refusal(200);
			expect(refused.reason).toBe('held');
			if (refused.reason !== 'held') throw new Error('unreachable');
			expect(refused.holder).toMatchObject({ pid: 100, mode: 'tui' });
			expect(refused.message).toContain('pid 100');
			expect(first.lock.pid).toBe(100);
		});

		it('lets a second runtime start once the first has closed', async () => {
			const first = await start(100);
			await first.connection.close();
			expect(fs.existsSync(lockFile())).toBe(false);
			const second = await start(200);
			expect(second.lock.pid).toBe(200);
		});

		it('names a holder that serves the bridge as a host to attach to', async () => {
			fs.writeFileSync(
				lockFile(),
				JSON.stringify({
					pid: 300,
					mode: 'host',
					startedAt: new Date(T0).toISOString(),
					heartbeatAt: new Date(T0).toISOString(),
					bootTime: BOOT,
				})
			);
			const refused = await refusal(100);
			expect(refused).toMatchObject({
				reason: 'host-running',
				attachable: false,
				host: { kind: 'headless', pid: 300 },
			});
		});

		it('takes the lock over from a holder that is gone', async () => {
			fs.writeFileSync(
				lockFile(),
				JSON.stringify({
					pid: 999,
					mode: 'tui',
					startedAt: new Date(T0).toISOString(),
					bootTime: BOOT,
				})
			);
			const runtime = await start(100);
			expect(readJson(lockFile()).pid).toBe(100);
			expect(runtime.lock.pid).toBe(100);
		});

		it('refuses a corrupt sessions file, names it, and releases the lock', async () => {
			fs.writeFileSync(sessionsFile(), '{ not json');
			const refused = await refusal(100);
			expect(refused).toMatchObject({ reason: 'store-corrupt', file: sessionsFile() });
			expect(fs.existsSync(lockFile())).toBe(false);
			expect(fs.readFileSync(sessionsFile(), 'utf-8')).toBe('{ not json');
		});

		it('quarantines a corrupt sessions file only when asked, and keeps the bytes', async () => {
			fs.writeFileSync(sessionsFile(), '{ not json');
			const runtime = await start(100, { quarantineCorruptStores: true });
			expect(value(await runtime.agents.list())).toEqual([]);
			const sidecars = fs.readdirSync(dir).filter((name) => name.includes('.corrupt-'));
			expect(sidecars).toHaveLength(1);
			expect(fs.readFileSync(path.join(dir, sidecars[0]), 'utf-8')).toBe('{ not json');
		});

		it('refuses a store written by a newer build', async () => {
			fs.writeFileSync(sessionsFile(), confText({ sessions: [], [STORE_SCHEMA_KEY]: 99 }));
			const refused = await refusal(100);
			expect(refused).toMatchObject({ reason: 'store-too-new', version: 99 });
			expect(fs.existsSync(lockFile())).toBe(false);
		});
	});

	// -----------------------------------------------------------------------

	describe('connection', () => {
		it('is the host: in process, labeled for the status bar, with no pid', async () => {
			const runtime = await start();
			const host = value(await runtime.connection.discover());
			expect(host).toMatchObject({ kind: 'in-process', label: 'this TUI' });
			expect(host.pid).toBeUndefined();
			expect(runtime.connection.state()).toBe('connected');
			expect(runtime.connection.host()).toEqual(host);
		});

		it('announces the host and then the whole state on the first connect only', async () => {
			seed();
			const runtime = await start();
			const events = collect(runtime);
			value(await runtime.connection.connect());
			value(await runtime.connection.connect());
			value(await runtime.connection.reconnect());
			expect(events.map((event) => event.type)).toEqual(['host.connected', 'snapshot']);
			const snapshot = events[1];
			if (snapshot.type !== 'snapshot') throw new Error('unreachable');
			expect(snapshot.agents.map((agent) => agent.id)).toEqual(['a1']);
			expect(snapshot.agents[0].aiTabs?.every((tab) => !('logs' in tab))).toBe(true);
		});

		it('answers host-unavailable after close, and close is safe to repeat', async () => {
			seed();
			const runtime = await start();
			await runtime.connection.close();
			await runtime.connection.close();
			expect(runtime.connection.state()).toBe('idle');
			expect(runtime.connection.host()).toBeUndefined();
			expect(errorOf(await runtime.agents.list()).code).toBe('host-unavailable');
			expect(
				errorOf(await runtime.agents.create({ name: 'x', provider: 'claude-code', cwd: '/x' })).code
			).toBe('host-unavailable');
			expect(errorOf(await runtime.connection.connect()).code).toBe('host-unavailable');
			expect(fs.existsSync(lockFile())).toBe(false);
		});

		it('lets a command already accepted finish writing before the lock is released', async () => {
			const runtime = await start();
			const pending = runtime.groups.create({ name: 'late' });
			await runtime.connection.close();
			expect(value(await pending).groupId).toBeTruthy();
			expect(readJson(path.join(dir, 'maestro-groups.json')).groups).toHaveLength(1);
			expect(fs.existsSync(lockFile())).toBe(false);
		});
	});

	// -----------------------------------------------------------------------

	describe('agents, groups, and tabs through the client', () => {
		it('creates an agent on disk, emits it, and lists it without transcripts', async () => {
			const runtime = await start();
			const events = collect(runtime);
			const { agentId } = value(
				await runtime.agents.create({ name: 'Fresh', provider: 'claude-code', cwd: dir })
			);
			expect(readJson(sessionsFile()).sessions.map((s: { id: string }) => s.id)).toEqual([agentId]);
			expect(events.map((event) => event.type)).toEqual(['agent.added']);
			const listed = value(await runtime.agents.list());
			expect(listed.map((agent) => agent.name)).toEqual(['Fresh']);
			expect(value(await runtime.agents.get(agentId)).id).toBe(agentId);
			expect(errorOf(await runtime.agents.get('nope')).code).toBe('not-found');
		});

		it('rejects an invalid create as a value and writes nothing', async () => {
			const runtime = await start();
			const error = errorOf(
				await runtime.agents.create({ name: '  ', provider: 'claude-code', cwd: dir })
			);
			expect(error.code).toBe('invalid');
			expect(fs.existsSync(sessionsFile())).toBe(false);
		});

		it('keeps unknown keys through a command (DD-5)', async () => {
			fs.writeFileSync(
				sessionsFile(),
				confText({
					sessions: [seedAgent('a1', 'Alpha', { rcOnlyAgentField: { keep: [1] } })],
					rcOnlyDocumentKey: 'stay',
				})
			);
			const runtime = await start();
			value(await runtime.agents.rename('a1', 'Beta'));
			const doc = readJson(sessionsFile());
			expect(doc.rcOnlyDocumentKey).toBe('stay');
			expect(doc.sessions[0]).toMatchObject({ name: 'Beta', rcOnlyAgentField: { keep: [1] } });
		});

		it('runs groups: create, move an agent in, remove the group without deleting the agent', async () => {
			seed();
			const runtime = await start();
			const { groupId } = value(await runtime.groups.create({ name: 'work' }));
			expect(value(await runtime.groups.list()).map((group) => group.name)).toEqual(['WORK']);
			value(await runtime.groups.moveAgent('a1', groupId));
			expect(value(await runtime.agents.get('a1')).groupId).toBe(groupId);
			value(await runtime.groups.remove(groupId));
			expect(value(await runtime.groups.list())).toEqual([]);
			const survivor = value(await runtime.agents.get('a1'));
			expect(survivor.groupId).toBeUndefined();
		});

		it('creates, renames, stars, and closes tabs, archiving the closed tab', async () => {
			seed();
			const runtime = await start();
			const { tabId } = value(await runtime.tabs.create('a1'));
			expect(value(await runtime.tabs.list('a1')).map((tab) => tab.id)).toContain(tabId);
			value(await runtime.tabs.rename('a1', tabId, 'scratch'));
			value(await runtime.tabs.star('a1', tabId, true));
			const tab = value(await runtime.tabs.list('a1')).find((entry) => entry.id === tabId);
			expect(tab).toMatchObject({ name: 'scratch', starred: true });
			value(await runtime.tabs.close('a1', 'a1-t1'));
			expect(value(await runtime.tabs.list('a1')).map((entry) => entry.id)).toEqual([tabId]);
			const archive = fs.readdirSync(path.join(dir, 'closed-tabs'));
			expect(archive).toHaveLength(1);
			expect(errorOf(await runtime.tabs.list('nobody')).code).toBe('not-found');
		});

		it('reads a transcript oldest first, with a window, and as a copy', async () => {
			seed();
			const runtime = await start();
			const all = value(await runtime.tabs.transcript('a1', 'a1-t1'));
			expect(all.map((entry) => entry.id)).toEqual(['l1', 'l2', 'l3']);
			expect(
				value(await runtime.tabs.transcript('a1', 'a1-t1', { sinceMs: 10, tail: 1 })).map(
					(e) => e.id
				)
			).toEqual(['l3']);
			all[0].text = 'edited by the caller';
			const again = value(await runtime.tabs.transcript('a1', 'a1-t1'));
			expect(again[0].text).toBe('one');
			expect(errorOf(await runtime.tabs.transcript('a1', 'missing')).code).toBe('not-found');
			expect(errorOf(await runtime.tabs.transcript('nobody', 'a1-t1')).code).toBe('not-found');
		});
	});

	// -----------------------------------------------------------------------

	describe('what waits for a later phase', () => {
		it('answers unsupported, as values, for group chats and consults (turns are in turns.test.ts, Auto Run in autorun.test.ts)', async () => {
			const runtime = await start();
			const results = await Promise.all([
				runtime.groupChats.list(),
				runtime.consults.ask({ targetAgentId: 'a1', question: '?' }),
				runtime.providers.models('claude-code'),
			]);
			for (const result of results) expect(errorOf(result).code).toBe('unsupported');
		});

		it('answers an Auto Run control for an agent with no run as not-found, since Auto Run is supported', async () => {
			const runtime = await start();
			expect(errorOf(await runtime.autoRun.stop('a1')).code).toBe('not-found');
		});
	});

	// -----------------------------------------------------------------------

	describe('settings and providers', () => {
		it('reads settings fresh on each call and omits keys the file does not hold', async () => {
			const runtime = await start();
			expect(value(await runtime.settings.get(['defaultShell']))).toEqual({});
			fs.writeFileSync(
				path.join(dir, 'maestro-settings.json'),
				confText({ defaultShell: 'zsh', sshRemotes: [{ id: 'r1', name: 'box', host: 'h' }] })
			);
			expect(value(await runtime.settings.get(['defaultShell', 'absent']))).toEqual({
				defaultShell: 'zsh',
			});
			expect(value(await runtime.settings.sshRemotes()).map((remote) => remote.id)).toEqual(['r1']);
		});

		it('fails, as a value, when the settings file is not readable JSON', async () => {
			const runtime = await start();
			fs.writeFileSync(path.join(dir, 'maestro-settings.json'), '{ nope');
			expect(errorOf(await runtime.settings.get(['defaultShell'])).code).toBe('failed');
		});

		it('tells subscribers when the settings file changes under it', async () => {
			fs.writeFileSync(path.join(dir, 'maestro-settings.json'), confText({ a: 1, b: 1 }));
			const runtime = await start();
			const seen: unknown[] = [];
			runtime.settings.subscribe(['a'], (change) => seen.push(change.keys));
			vi.useFakeTimers();
			fs.writeFileSync(path.join(dir, 'maestro-settings.json'), confText({ a: 2, b: 2 }));
			watchListener?.('change', 'maestro-settings.json');
			vi.advanceTimersByTime(300);
			fs.writeFileSync(path.join(dir, 'maestro-settings.json'), confText({ a: 2, b: 3 }));
			watchListener?.('change', 'maestro-settings.json');
			vi.advanceTimersByTime(300);
			expect(seen).toEqual([['a', 'b']]);
		});

		it('lists providers through the injected probe, using a custom path from the agent configs', async () => {
			fs.writeFileSync(
				path.join(dir, 'maestro-agent-configs.json'),
				confText({ configs: { codex: { customPath: '/opt/codex' } } })
			);
			const probe = vi.fn(async (binaryName: string, customPath?: string) => ({
				exists: Boolean(customPath) || binaryName === 'claude',
				path: customPath ?? `/bin/${binaryName}`,
			}));
			const runtime = await start(100, {}, { probeBinary: probe });
			const providers = value(await runtime.providers.list());
			expect(providers.find((info) => info.id === 'codex')).toMatchObject({
				available: true,
				path: '/opt/codex',
			});
			expect(providers.find((info) => info.id === 'claude-code')?.available).toBe(true);
			expect(providers.map((info) => info.id)).not.toContain('terminal');
		});

		it('does not probe an SSH remote', async () => {
			const runtime = await start();
			expect(errorOf(await runtime.providers.list({ sshRemoteId: 'r1' })).code).toBe('unsupported');
		});
	});

	// -----------------------------------------------------------------------

	describe('losing the directory (RT11)', () => {
		it('fences when another process takes the lock: host.lost, commands refused, reads still work', async () => {
			seed();
			const runtime = await start(100);
			const events = collect(runtime);
			fs.writeFileSync(
				lockFile(),
				JSON.stringify({
					pid: 200,
					mode: 'host',
					startedAt: new Date(T0).toISOString(),
					heartbeatAt: new Date(T0).toISOString(),
					bootTime: BOOT,
				})
			);
			const error = errorOf(await runtime.agents.rename('a1', 'Gamma'));
			expect(error.code).toBe('host-lost');
			expect(events.some((event) => event.type === 'host.lost')).toBe(true);
			expect(readJson(sessionsFile()).sessions[0].name).toBe('Alpha');
			expect(value(await runtime.agents.list())).toHaveLength(1);
			expect(runtime.connection.state()).toBe('idle');
			expect(errorOf(await runtime.connection.connect()).code).toBe('host-lost');
			// Closing must not delete the new owner's lock.
			await runtime.connection.close();
			expect(readJson(lockFile()).pid).toBe(200);
		});

		it('fences when a desktop starts serving the directory', async () => {
			seed();
			const runtime = await start(100);
			fs.writeFileSync(
				path.join(dir, 'cli-server.json'),
				JSON.stringify({ port: 7000, token: 't', pid: 300, startedAt: BOOT + 120_000 })
			);
			const error = errorOf(await runtime.groups.create({ name: 'x' }));
			expect(error.code).toBe('host-lost');
			expect(error.message).toContain('pid 300');
			expect(fs.existsSync(path.join(dir, 'maestro-groups.json'))).toBe(false);
		});
	});
});

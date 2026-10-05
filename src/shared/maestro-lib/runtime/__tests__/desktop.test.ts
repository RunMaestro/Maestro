import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DEFAULT_TAB_DEFAULTS } from '../../agents/rules';
import { createMaestroRuntime, type MaestroRuntime, type RuntimeDeps } from '../index';
import type { WatchDirectory } from '../settings-watch';
import type { ClientResult, MaestroEvent } from '../../client/types';

const T0 = Date.parse('2026-10-04T12:00:00Z');
const confText = (doc: unknown) => JSON.stringify(doc, null, '\t');

function value<T>(result: ClientResult<T>): T {
	if (!result.ok) throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
	return result.value;
}

const seedAgent = (id: string, name: string) => ({
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
			logs: [{ id: 'l1', timestamp: 10, source: 'user', text: 'one' }],
		},
	],
	activeTabId: `${id}-t1`,
	unifiedTabOrder: [{ type: 'ai', id: `${id}-t1` }],
});

describe('the desktop part of the runtime', () => {
	let dir: string;
	let open: MaestroRuntime[];
	const watchDirectory: WatchDirectory = () => ({ close: () => undefined });
	const sessionsFile = () => path.join(dir, 'maestro-sessions.json');

	function deps(): Partial<RuntimeDeps> {
		let id = 0;
		let now = 1_000;
		return {
			pid: 100,
			now: () => T0,
			bootTime: () => T0 - 3_600_000,
			isPidAlive: () => true,
			hostname: () => 'testhost',
			rules: { newId: () => `id-${++id}`, now: () => ++now, random: () => 0 },
			checkCwd: () => null,
			readTabDefaults: async () => DEFAULT_TAB_DEFAULTS,
			watchDirectory,
		};
	}

	async function start(mode: 'tui' | 'desktop'): Promise<MaestroRuntime> {
		const started = await createMaestroRuntime({ dataDir: dir, mode, deps: deps() });
		if (!started.ok) throw new Error(`refused: ${started.refusal.message}`);
		open.push(started.runtime);
		return started.runtime;
	}

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-runtime-desktop-test-'));
		open = [];
		fs.writeFileSync(
			sessionsFile(),
			confText({
				sessions: [seedAgent('a1', 'Alpha'), seedAgent('a2', 'Beta')],
				activeSessionId: 'a1',
			})
		);
	});
	afterEach(async () => {
		for (const runtime of open) await runtime.connection.close();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('is present only when the runtime was started in mode desktop', async () => {
		const tui = await start('tui');
		expect(tui.desktop).toBeUndefined();
		await tui.connection.close();
		const desktop = await start('desktop');
		expect(desktop.desktop).toBeDefined();
		expect(Object.keys(desktop.desktop ?? {}).sort()).toEqual(
			[
				'documents',
				'flush',
				'fold',
				'groupsRevision',
				'revisionOf',
				'snapshot',
				'updateGroup',
			].sort()
		);
	});

	it('answers a snapshot with transcripts and the revisions', async () => {
		const runtime = await start('desktop');
		const snapshot = runtime.desktop!.snapshot();
		expect(snapshot.agents.map((a) => a.id)).toEqual(['a1', 'a2']);
		expect(snapshot.agents[0].aiTabs?.[0].logs).toHaveLength(1);
		expect(snapshot.activeSessionId).toBe('a1');
		expect(snapshot.revs).toEqual({ a1: 0, a2: 0 });
	});

	it('lands a fold, emits what peers need, and makes it durable on flush', async () => {
		const runtime = await start('desktop');
		const events: MaestroEvent[] = [];
		runtime.events.subscribe((event) => events.push(event));

		const result = await runtime.desktop!.fold({
			agents: [
				{
					id: 'a1',
					baseRev: 0,
					provider: 'claude-code',
					fields: { inputMode: 'terminal' },
					tabs: { 'a1-t1': { scrollTop: 12 } },
					domain: { bookmarked: true },
				},
			],
			activeSessionId: 'a2',
		});
		expect(result.revs).toEqual({ a1: 1, a2: 0 });
		expect(result.drift).toEqual([]);
		expect(events).toMatchObject([
			{ type: 'agent.updated', agent: { id: 'a1', bookmarked: true } },
		]);
		expect(runtime.desktop!.revisionOf('a1')).toBe(1);

		await runtime.desktop!.flush();
		const stored = JSON.parse(fs.readFileSync(sessionsFile(), 'utf-8'));
		expect(stored.activeSessionId).toBe('a2');
		expect(stored.sessions[0]).toMatchObject({ inputMode: 'terminal', bookmarked: true });
		expect(stored.sessions[0].aiTabs[0].scrollTop).toBe(12);
		// The client API sees the same agent.
		expect(value(await runtime.agents.get('a1')).bookmarked).toBe(true);
	});

	it('lands a group update through the desktop api', async () => {
		const runtime = await start('desktop');
		const { groupId } = value(await runtime.groups.create({ name: 'work' }));
		value(await runtime.desktop!.updateGroup(groupId, { name: 'play' }));
		expect(value(await runtime.groups.list())[0].name).toBe('PLAY');
		expect(runtime.desktop!.groupsRevision()).toBe(2);
	});

	it('writes a pending fold at shutdown, before the lock goes', async () => {
		const runtime = await start('desktop');
		await runtime.desktop!.fold({
			agents: [{ id: 'a1', provider: 'claude-code', fields: { inputMode: 'folded' }, tabs: {} }],
		});
		await runtime.connection.close();
		expect(JSON.parse(fs.readFileSync(sessionsFile(), 'utf-8')).sessions[0].inputMode).toBe(
			'folded'
		);
	});

	it('throws the failure message when the runtime is closed', async () => {
		const runtime = await start('desktop');
		await runtime.connection.close();
		await expect(
			runtime.desktop!.fold({
				agents: [{ id: 'a1', provider: 'claude-code', fields: {}, tabs: {} }],
			})
		).rejects.toThrow('closed');
	});
});

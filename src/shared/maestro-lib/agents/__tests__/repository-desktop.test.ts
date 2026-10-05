import { GROUP_ICON_IDS } from '../../../groupAppearance';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createEventBus } from '../../client/event-bus';
import type { ClientResult, MaestroEvent } from '../../client/types';
import type { MaestroPaths } from '../../paths/resolve';
import * as io from '../../store/io';
import { archiveClosedTab, readClosedTabs, closedTabsFile } from '../closed-tabs';
import {
	createAgentRepository,
	type AgentRepository,
	type AgentRepositoryOptions,
} from '../repository';
import { DEFAULT_TAB_DEFAULTS, type RuleContext } from '../rules';

vi.mock('../../store/io', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../store/io')>();
	return { ...actual, writeStoreDocument: vi.fn(actual.writeStoreDocument) };
});

function makePaths(dir: string): MaestroPaths {
	return {
		userDataDir: dir,
		productionDataDir: dir,
		bootstrapFile: path.join(dir, 'maestro-bootstrap.json'),
		syncDir: dir,
		syncDirSource: 'userData',
		sessionsFile: path.join(dir, 'maestro-sessions.json'),
		groupsFile: path.join(dir, 'maestro-groups.json'),
		settingsFile: path.join(dir, 'maestro-settings.json'),
		agentConfigsFile: path.join(dir, 'maestro-agent-configs.json'),
		historyDir: path.join(dir, 'history'),
		statsFile: path.join(dir, 'stats.db'),
		groupChatsDir: path.join(dir, 'group-chats'),
		sessionImagesDir: path.join(dir, 'session-images'),
		cliServerFile: path.join(dir, 'cli-server.json'),
	};
}

function makeContext(): RuleContext {
	let id = 0;
	let now = 1_000;
	return { newId: () => `id-${++id}`, now: () => ++now, random: () => 0 };
}

const tab = (id: string, extra: Record<string, unknown> = {}) => ({
	id,
	agentSessionId: null,
	name: null,
	starred: false,
	logs: [{ id: `${id}-l1`, timestamp: 1, source: 'user', text: `hello from ${id}` }],
	...extra,
});

function seedAgent(id: string, name: string, extra: Record<string, unknown> = {}) {
	return {
		id,
		name,
		toolType: 'claude-code',
		cwd: `/work/${id}`,
		projectRoot: `/work/${id}`,
		aiTabs: [tab(`${id}-t1`), tab(`${id}-t2`)],
		activeTabId: `${id}-t1`,
		unifiedTabOrder: [
			{ type: 'ai', id: `${id}-t1` },
			{ type: 'ai', id: `${id}-t2` },
		],
		...extra,
	};
}

const confText = (doc: unknown) => JSON.stringify(doc, null, '\t');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('agent repository: the desktop surface', () => {
	let dir: string;
	let paths: MaestroPaths;
	let events: MaestroEvent[];
	const writeSpy = vi.mocked(io.writeStoreDocument);

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repository-desktop-test-'));
		paths = makePaths(dir);
		events = [];
		writeSpy.mockClear();
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	async function setup(
		seed: { sessions?: unknown; groups?: unknown } = {},
		extra: Partial<AgentRepositoryOptions> = {}
	): Promise<AgentRepository> {
		if (seed.sessions) fs.writeFileSync(paths.sessionsFile, confText(seed.sessions));
		if (seed.groups) fs.writeFileSync(paths.groupsFile, confText(seed.groups));
		const bus = createEventBus('[test]');
		bus.subscribe((event) => events.push(event));
		const repo = createAgentRepository({
			paths,
			bus,
			context: makeContext(),
			readTabDefaults: async () => DEFAULT_TAB_DEFAULTS,
			checkCwd: () => null,
			// A short wait, so a test can see the trailing write without a long sleep.
			foldWriteDelayMs: 15,
			...extra,
		});
		const loaded = await repo.load();
		if (!loaded.ok) throw new Error(`load failed: ${loaded.failure.message}`);
		return repo;
	}

	const sessionWrites = () =>
		writeSpy.mock.calls.filter(([file]) => file === paths.sessionsFile).length;
	const readSessions = () => JSON.parse(fs.readFileSync(paths.sessionsFile, 'utf-8'));
	const readGroups = () => JSON.parse(fs.readFileSync(paths.groupsFile, 'utf-8'));

	function value<T>(result: ClientResult<T>): T {
		if (!result.ok)
			throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
		return result.value;
	}
	function errorOf<T>(result: ClientResult<T>) {
		if (result.ok) throw new Error('expected a failure');
		return result.error;
	}

	const twoAgents = () => ({
		sessions: [seedAgent('a1', 'Alpha'), seedAgent('a2', 'Beta')],
		activeSessionId: 'a1',
	});
	const input = { name: 'Docs', provider: 'codex', cwd: '/p/docs' };

	// -----------------------------------------------------------------------

	describe('revisions', () => {
		it('start at 0 and bump once per committed change to that agent', async () => {
			const repo = await setup({ sessions: twoAgents() });
			expect(repo.revisionOf('a1')).toBe(0);
			expect(repo.revisionOf('unknown')).toBe(0);

			value(await repo.renameAgent('a1', 'Alpha 2'));
			expect(repo.revisionOf('a1')).toBe(1);
			expect(repo.revisionOf('a2')).toBe(0);

			value(await repo.updateAgent('a1', { model: 'opus' }));
			expect(repo.revisionOf('a1')).toBe(2);

			// A tab command emits tab.updated and one agent.updated: one bump.
			value(await repo.starTab('a1', 'a1-t1', true));
			expect(repo.revisionOf('a1')).toBe(3);
			value(await repo.createTab('a1'));
			expect(repo.revisionOf('a1')).toBe(4);
			value(await repo.closeTab('a1', 'a1-t2'));
			expect(repo.revisionOf('a1')).toBe(5);
		});

		it('do not move for a command that changes nothing or fails', async () => {
			const repo = await setup({ sessions: twoAgents() });
			value(await repo.renameAgent('a1', 'Alpha'));
			errorOf(await repo.renameAgent('a1', ''));
			errorOf(await repo.renameAgent('ghost', 'x'));
			expect(repo.revisionOf('a1')).toBe(0);
		});

		it('start a created agent at 1, and bump every agent that moves with a group change', async () => {
			const repo = await setup({
				sessions: {
					sessions: [seedAgent('a1', 'Alpha'), seedAgent('w1', 'Work', { parentSessionId: 'a1' })],
				},
				groups: { groups: [{ id: 'g1', name: 'G', collapsed: false }] },
			});
			const { agentId } = value(await repo.createAgent(input));
			expect(repo.revisionOf(agentId)).toBe(1);

			value(await repo.moveAgentToGroup('a1', 'g1'));
			expect(repo.revisionOf('a1')).toBe(1);
			expect(repo.revisionOf('w1')).toBe(1);
			expect(repo.groupsRevision()).toBe(0);
		});

		it('bump groupsRev for every groups.changed, and removing a group bumps its members', async () => {
			const repo = await setup({
				sessions: { sessions: [seedAgent('a1', 'Alpha', { groupId: 'g1' })] },
			});
			const { groupId } = value(await repo.createGroup({ name: 'work' }));
			expect(repo.groupsRevision()).toBe(1);
			value(await repo.renameGroup(groupId, 'play'));
			expect(repo.groupsRevision()).toBe(2);
			value(await repo.removeGroup(groupId));
			expect(repo.groupsRevision()).toBe(3);
			expect(repo.revisionOf('a1')).toBe(0);
		});

		it('are already the post-commit value inside an event callback', async () => {
			const seen: Array<[string, number]> = [];
			const bus = createEventBus('[test]');
			const repo = await setup(
				{ sessions: twoAgents() },
				{
					bus,
				}
			);
			bus.subscribe((event) => {
				if (event.type === 'agent.updated' || event.type === 'agent.added') {
					seen.push([event.type, repo.revisionOf(event.agent.id)]);
				}
				if (event.type === 'agent.removed') seen.push([event.type, repo.revisionOf(event.agentId)]);
				if (event.type === 'groups.changed') seen.push([event.type, repo.groupsRevision()]);
			});
			value(await repo.renameAgent('a1', 'Alpha 2'));
			const { agentId } = value(await repo.createAgent(input));
			value(await repo.createGroup({ name: 'g' }));
			value(await repo.removeAgent(agentId));
			expect(seen).toEqual([
				['agent.updated', 1],
				['agent.added', 1],
				['groups.changed', 1],
				// A removed agent has no revision left.
				['agent.removed', 0],
			]);
		});

		it('are forgotten when the agent is removed', async () => {
			const repo = await setup({ sessions: twoAgents() });
			value(await repo.renameAgent('a1', 'Alpha 2'));
			value(await repo.removeAgent('a1'));
			expect(repo.revisionOf('a1')).toBe(0);
			expect(repo.snapshot().revs).toEqual({ a2: 0 });
		});
	});

	describe('snapshot and documents', () => {
		it('hands out the stored records WITH transcripts, every revision, and the active agent', async () => {
			const repo = await setup({
				sessions: { ...twoAgents(), keep: 1 },
				groups: { groups: [{ id: 'g1', name: 'G' }] },
			});
			value(await repo.renameAgent('a1', 'Alpha 2'));
			const snapshot = repo.snapshot();
			expect(snapshot.agents.map((a) => a.id)).toEqual(['a1', 'a2']);
			expect(snapshot.agents[0].aiTabs?.[0].logs).toHaveLength(1);
			expect(snapshot.groups).toEqual([{ id: 'g1', name: 'G' }]);
			expect(snapshot.activeSessionId).toBe('a1');
			expect(snapshot.revs).toEqual({ a1: 1, a2: 0 });
			expect(snapshot.groupsRev).toBe(0);
		});

		it('says an empty active agent when the document has none, and exposes the whole documents', async () => {
			const repo = await setup({ sessions: { sessions: [seedAgent('a1', 'A')], zebra: { x: 1 } } });
			expect(repo.snapshot().activeSessionId).toBe('');
			expect(repo.documents().sessions).toMatchObject({ zebra: { x: 1 } });
			expect(repo.documents().groups).toEqual({ groups: [] });
		});
	});

	describe('the sessions write', () => {
		it('goes through the memoized serializer and is conf format on disk', async () => {
			const repo = await setup({ sessions: { ...twoAgents(), zebra: { n: [1] } } });
			value(await repo.renameAgent('a1', 'Alpha 2'));
			const text = fs.readFileSync(paths.sessionsFile, 'utf-8');
			expect(writeSpy.mock.calls.find(([file]) => file === paths.sessionsFile)?.[2]).toMatchObject({
				memoKey: 'sessions',
			});
			expect(text).toBe(confText(JSON.parse(text)));
		});
	});

	describe('client ids (DG10)', () => {
		it('createAgent uses the given agent and first tab ids', async () => {
			const repo = await setup();
			const { agentId } = value(
				await repo.createAgent({ ...input, id: 'client-agent', tabId: 'client-tab' })
			);
			expect(agentId).toBe('client-agent');
			const stored = readSessions().sessions[0];
			expect(stored.id).toBe('client-agent');
			expect(stored.aiTabs[0].id).toBe('client-tab');
			expect(stored.activeTabId).toBe('client-tab');
			expect(stored.unifiedTabOrder).toEqual([{ type: 'ai', id: 'client-tab' }]);
			expect(events[0]).toMatchObject({ type: 'agent.added', agent: { id: 'client-agent' } });
		});

		it('keeps generated ids when none is given', async () => {
			const repo = await setup();
			const { agentId } = value(await repo.createAgent(input));
			expect(agentId).toMatch(/^id-\d+$/);
		});

		it.each([
			['empty', ''],
			['blank', '   '],
			['a path separator', 'a/b'],
			['a backslash', 'a\\b'],
			['a dot segment', '..'],
		])('refuses an agent id that is %s', async (_label, id) => {
			const repo = await setup();
			expect(errorOf(await repo.createAgent({ ...input, id })).code).toBe('invalid');
			expect(fs.existsSync(paths.sessionsFile)).toBe(false);
		});

		it('refuses an agent id that is taken', async () => {
			const repo = await setup({ sessions: twoAgents() });
			const error = errorOf(await repo.createAgent({ ...input, id: 'a1' }));
			expect(error).toMatchObject({ code: 'invalid', method: 'agents.create' });
			expect(error.message).toContain('a1');
		});

		it('refuses an agent id that belonged to a removed agent', async () => {
			const repo = await setup({ sessions: twoAgents() });
			value(await repo.removeAgent('a1'));
			expect(errorOf(await repo.createAgent({ ...input, id: 'a1' })).code).toBe('invalid');
		});

		it.each([
			['empty', ''],
			['unsafe', '../x'],
		])('refuses a tab id that is %s', async (_label, tabId) => {
			const repo = await setup();
			expect(errorOf(await repo.createAgent({ ...input, tabId })).code).toBe('invalid');
		});

		it('createGroup uses the given id, and keeps the group- prefix only for generated ones', async () => {
			const repo = await setup();
			expect(value(await repo.createGroup({ id: 'my-group', name: 'one' })).groupId).toBe(
				'my-group'
			);
			expect(value(await repo.createGroup({ name: 'two' })).groupId).toMatch(/^group-/);
		});

		it('createGroup refuses a taken or empty id', async () => {
			const repo = await setup({ groups: { groups: [{ id: 'g1', name: 'G' }] } });
			expect(errorOf(await repo.createGroup({ id: 'g1', name: 'dup' })).code).toBe('invalid');
			expect(errorOf(await repo.createGroup({ id: ' ', name: 'blank' })).code).toBe('invalid');
			expect(readGroups().groups).toHaveLength(1);
		});
	});

	describe('create fields (DG6)', () => {
		it('stores what the New Agent flows set, only when given', async () => {
			const repo = await setup();
			const { agentId } = value(
				await repo.createAgent({
					...input,
					customProviderPath: '/bin/codex',
					customEnvVarsDisabled: { KEY: 'v', BLANK: '' },
					additionalDirectories: ['/extra'],
					retryOnAvailabilityErrors: false,
					retryOnTokenExhaustion: true,
					codexAutoResetOnExhaustion: true,
					parentSessionId: 'parent',
					worktreeBranch: 'feat',
					worktreeParentPath: '/wt',
					worktreeConfig: { basePath: '/wt' },
					isPianola: true,
					symphonyMetadata: { issue: 1 },
					enableMaestroP: true,
					maestroPPath: '/bin/p',
					maestroPMode: 'dynamic',
				})
			);
			expect(readSessions().sessions.find((a: { id: string }) => a.id === agentId)).toMatchObject({
				customProviderPath: '/bin/codex',
				customEnvVarsDisabled: { KEY: 'v' },
				additionalDirectories: ['/extra'],
				retryOnAvailabilityErrors: false,
				retryOnTokenExhaustion: true,
				codexAutoResetOnExhaustion: true,
				parentSessionId: 'parent',
				worktreeBranch: 'feat',
				worktreeParentPath: '/wt',
				worktreeConfig: { basePath: '/wt' },
				isPianola: true,
				symphonyMetadata: { issue: 1 },
				enableMaestroP: true,
				maestroPPath: '/bin/p',
				maestroPMode: 'dynamic',
			});
		});

		it('stores nothing extra for a plain create', async () => {
			const repo = await setup();
			value(await repo.createAgent(input));
			const stored = readSessions().sessions[0];
			for (const key of [
				'customProviderPath',
				'customEnvVarsDisabled',
				'additionalDirectories',
				'retryOnAvailabilityErrors',
				'codexAutoResetOnExhaustion',
				'parentSessionId',
				'isPianola',
				'enableMaestroP',
			]) {
				expect(key in stored).toBe(false);
			}
		});

		it('stores codexAutoResetOnExhaustion only when true', async () => {
			const repo = await setup();
			value(await repo.createAgent({ ...input, codexAutoResetOnExhaustion: false }));
			expect('codexAutoResetOnExhaustion' in readSessions().sessions[0]).toBe(false);
		});
	});

	describe('updateGroup (DG8)', () => {
		const groups = {
			groups: [
				{ id: 'root', name: 'ROOT', emoji: 'F', kind: 'user', collapsed: false },
				{ id: 'other', name: 'OTHER', emoji: 'F', kind: 'user', collapsed: true },
				{ id: 'child', name: 'CHILD', parentGroupId: 'root', kind: 'user', collapsed: false },
			],
		};

		it('is not-found for an unknown group', async () => {
			const repo = await setup({ groups });
			expect(errorOf(await repo.updateGroup('ghost', { name: 'x' }))).toMatchObject({
				code: 'not-found',
				method: 'groups.update',
			});
		});

		it('renames through the group name rule and emits groups.changed after bumping the revision', async () => {
			const repo = await setup({ groups });
			value(await repo.updateGroup('root', { name: '  platform ' }));
			expect(readGroups().groups[0].name).toBe('PLATFORM');
			expect(events.at(-1)).toMatchObject({ type: 'groups.changed' });
			expect(repo.groupsRevision()).toBe(1);
			expect(errorOf(await repo.updateGroup('root', { name: '  ' })).code).toBe('invalid');
		});

		it('sets the emoji, validated, and a blank emoji restores the default folder', async () => {
			const repo = await setup({ groups });
			value(await repo.updateGroup('root', { emoji: '🚀' }));
			expect(readGroups().groups[0].emoji).toBe('🚀');
			value(await repo.updateGroup('root', { emoji: ' ' }));
			expect(readGroups().groups[0].emoji).toBe('\u{1F4C2}');
		});

		it('sets and clears the icon and the color, validated, and keeps the emoji beside an icon', async () => {
			const repo = await setup({ groups });
			value(await repo.updateGroup('root', { icon: GROUP_ICON_IDS[0], color: '#aabbcc' }));
			expect(readGroups().groups[0]).toMatchObject({
				emoji: 'F',
				icon: GROUP_ICON_IDS[0],
				color: '#AABBCC',
			});
			expect(errorOf(await repo.updateGroup('root', { icon: 'no-such-icon' })).code).toBe(
				'invalid'
			);
			expect(errorOf(await repo.updateGroup('root', { color: 'blue-ish' })).code).toBe('invalid');
			value(await repo.updateGroup('root', { icon: null, color: null }));
			expect(readGroups().groups[0]).not.toHaveProperty('icon');
			expect(readGroups().groups[0]).not.toHaveProperty('color');
		});

		it('nests a top-level group under another and moves one back to the top with null or empty', async () => {
			const repo = await setup({ groups });
			value(await repo.updateGroup('other', { parentGroupId: 'root' }));
			expect(readGroups().groups[1].parentGroupId).toBe('root');
			value(await repo.updateGroup('other', { parentGroupId: null }));
			expect('parentGroupId' in readGroups().groups[1]).toBe(false);
			value(await repo.updateGroup('other', { parentGroupId: 'root' }));
			value(await repo.updateGroup('other', { parentGroupId: '' }));
			expect('parentGroupId' in readGroups().groups[1]).toBe(false);
		});

		it('refuses what canSetGroupParent refuses', async () => {
			const repo = await setup({ groups });
			// Under itself, under a child (two levels), a group that has children, a missing parent.
			expect(errorOf(await repo.updateGroup('root', { parentGroupId: 'root' })).code).toBe(
				'invalid'
			);
			expect(errorOf(await repo.updateGroup('other', { parentGroupId: 'child' })).code).toBe(
				'invalid'
			);
			expect(errorOf(await repo.updateGroup('root', { parentGroupId: 'other' })).code).toBe(
				'invalid'
			);
			expect(errorOf(await repo.updateGroup('other', { parentGroupId: 'ghost' })).code).toBe(
				'invalid'
			);
			expect(repo.groupsRevision()).toBe(0);
			expect(events).toEqual([]);
		});

		it('refuses a bad emoji before changing anything, even with a good name in the patch', async () => {
			const repo = await setup({ groups });
			const before = fs.readFileSync(paths.groupsFile, 'utf-8');
			// Appearance validation refuses an emoji with a color or icon alongside; here a bad parent does it.
			errorOf(await repo.updateGroup('root', { name: 'fine', parentGroupId: 'ghost' }));
			expect(fs.readFileSync(paths.groupsFile, 'utf-8')).toBe(before);
		});

		it('writes nothing and says nothing when the patch changes nothing', async () => {
			const repo = await setup({ groups });
			writeSpy.mockClear();
			value(await repo.updateGroup('root', { name: 'root', emoji: 'F' }));
			value(await repo.updateGroup('child', { parentGroupId: 'root' }));
			value(await repo.updateGroup('root', {}));
			expect(writeSpy).not.toHaveBeenCalled();
			expect(events).toEqual([]);
			expect(repo.groupsRevision()).toBe(0);
		});
	});

	// -----------------------------------------------------------------------

	describe('applyFold', () => {
		const touch = (id: string, fields: Record<string, unknown> = { inputMode: 'terminal' }) => ({
			id,
			provider: 'claude-code',
			fields,
			tabs: {},
		});

		it('replaces the in-memory documents at once, before anything is on disk', async () => {
			const repo = await setup({ sessions: twoAgents() }, { foldWriteDelayMs: 5_000 });
			const before = fs.readFileSync(paths.sessionsFile, 'utf-8');
			const result = value(await repo.applyFold({ agents: [touch('a1')] }));
			expect(result.drift).toEqual([]);
			expect(repo.documents().sessions.sessions?.[0]).toMatchObject({ inputMode: 'terminal' });
			expect(repo.snapshot().agents[0]).toMatchObject({ inputMode: 'terminal' });
			expect(fs.readFileSync(paths.sessionsFile, 'utf-8')).toBe(before);
			expect(sessionWrites()).toBe(0);
			await repo.flush();
			expect(readSessions().sessions[0].inputMode).toBe('terminal');
		});

		it('answers every revision, the groups revision, and the drift', async () => {
			const repo = await setup({ sessions: twoAgents() });
			value(await repo.renameAgent('a1', 'Alpha 2'));
			const result = value(
				await repo.applyFold({
					agents: [{ ...touch('a1'), baseRev: 0, domain: { name: 'Stale' } }],
				})
			);
			expect(result.revs).toEqual({ a1: 1, a2: 0 });
			expect(result.groupsRev).toBe(0);
			expect(result.drift).toMatchObject([{ kind: 'domain-dropped', agentId: 'a1' }]);
			expect(repo.getAgent('a1')?.name).toBe('Alpha 2');
		});

		it('coalesces two folds inside the delay into one write', async () => {
			const repo = await setup({ sessions: twoAgents() }, { foldWriteDelayMs: 40 });
			value(await repo.applyFold({ agents: [touch('a1', { inputMode: 'one' })] }));
			value(await repo.applyFold({ agents: [touch('a2', { inputMode: 'two' })] }));
			expect(sessionWrites()).toBe(0);
			await sleep(150);
			expect(sessionWrites()).toBe(1);
			const stored = readSessions().sessions;
			expect([stored[0].inputMode, stored[1].inputMode]).toEqual(['one', 'two']);
		});

		it('writes the groups document only when a fold changed it', async () => {
			const repo = await setup({
				sessions: twoAgents(),
				groups: { groups: [{ id: 'g1', name: 'G', collapsed: false }] },
			});
			value(await repo.applyFold({ agents: [touch('a1')] }));
			await repo.flush();
			expect(writeSpy.mock.calls.filter(([file]) => file === paths.groupsFile)).toHaveLength(0);

			value(await repo.applyFold({ agents: [], groups: { collapsed: { g1: true } } }));
			await repo.flush();
			expect(readGroups().groups[0].collapsed).toBe(true);
			expect(repo.groupsRevision()).toBe(0);
		});

		it('writes nothing for a fold that changes nothing', async () => {
			const repo = await setup({ sessions: twoAgents() });
			value(
				await repo.applyFold({
					agents: [touch('a1', { inputMode: undefined })],
					activeSessionId: 'a1',
				})
			);
			await sleep(60);
			await repo.flush();
			expect(sessionWrites()).toBe(0);
		});

		it('is cleared by a command write, which carries the fold state in the same document', async () => {
			const repo = await setup({ sessions: twoAgents() }, { foldWriteDelayMs: 40 });
			value(await repo.applyFold({ agents: [touch('a1', { inputMode: 'folded' })] }));
			value(await repo.renameAgent('a2', 'Beta 2'));
			expect(sessionWrites()).toBe(1);
			const stored = readSessions().sessions;
			expect(stored[0].inputMode).toBe('folded');
			expect(stored[1].name).toBe('Beta 2');
			// The timer finds nothing dirty.
			await sleep(120);
			expect(sessionWrites()).toBe(1);
		});

		it('is written by drain, so shutdown loses nothing', async () => {
			const repo = await setup({ sessions: twoAgents() }, { foldWriteDelayMs: 60_000 });
			value(await repo.applyFold({ agents: [touch('a1', { inputMode: 'folded' })] }));
			await repo.drain();
			expect(readSessions().sessions[0].inputMode).toBe('folded');
			expect(sessionWrites()).toBe(1);
		});

		it('keeps the fold dirty when the deferred write fails, and the next flush writes it', async () => {
			const repo = await setup({ sessions: twoAgents() }, { foldWriteDelayMs: 5 });
			writeSpy.mockImplementationOnce(async () => {
				throw new Error('disk full');
			});
			value(await repo.applyFold({ agents: [touch('a1', { inputMode: 'folded' })] }));
			await sleep(60);
			expect(sessionWrites()).toBe(1);
			expect(readSessions().sessions[0].inputMode).toBeUndefined();
			await repo.flush();
			expect(sessionWrites()).toBe(2);
			expect(readSessions().sessions[0].inputMode).toBe('folded');
		});

		it('retries on the next fold after a failed deferred write', async () => {
			const repo = await setup({ sessions: twoAgents() }, { foldWriteDelayMs: 5 });
			writeSpy.mockImplementationOnce(async () => {
				throw new Error('disk full');
			});
			value(await repo.applyFold({ agents: [touch('a1', { inputMode: 'one' })] }));
			await sleep(40);
			value(await repo.applyFold({ agents: [touch('a2', { inputMode: 'two' })] }));
			await sleep(60);
			const stored = readSessions().sessions;
			expect([stored[0].inputMode, stored[1].inputMode]).toEqual(['one', 'two']);
		});

		it('rejects flush when the write fails, and drain swallows it', async () => {
			const repo = await setup({ sessions: twoAgents() }, { foldWriteDelayMs: 60_000 });
			value(await repo.applyFold({ agents: [touch('a1')] }));
			writeSpy.mockImplementationOnce(async () => {
				throw new Error('disk full');
			});
			await expect(repo.flush()).rejects.toThrow('disk full');
			writeSpy.mockImplementationOnce(async () => {
				throw new Error('still full');
			});
			await expect(repo.drain()).resolves.toBeUndefined();
		});

		it('answers host-lost when fenced, lands nothing, and writes nothing', async () => {
			const repo = await setup({ sessions: twoAgents() });
			repo.fence('taken over');
			const error = errorOf(await repo.applyFold({ agents: [touch('a1')] }));
			expect(error).toMatchObject({ code: 'host-lost', method: 'desktop.fold' });
			expect(repo.snapshot().agents[0].inputMode).toBeUndefined();
			await repo.drain();
			expect(sessionWrites()).toBe(0);
		});

		it('never writes a fold once the fence closes between the fold and its timer', async () => {
			let verdict: { ok: true } | { ok: false; reason: string } = { ok: true };
			const repo = await setup(
				{ sessions: twoAgents() },
				{ foldWriteDelayMs: 20, fence: () => verdict as never }
			);
			value(await repo.applyFold({ agents: [touch('a1')] }));
			verdict = { ok: false, reason: 'lost' };
			await sleep(80);
			expect(sessionWrites()).toBe(0);
		});

		it('emits with the revisions already bumped, agent.removed first and groups.changed last', async () => {
			const seen: string[] = [];
			const bus = createEventBus('[test]');
			const repo = await setup(
				{
					sessions: {
						sessions: [seedAgent('a1', 'A'), seedAgent('a2', 'B'), seedAgent('a3', 'C')],
					},
					groups: { groups: [{ id: 'g1', name: 'G', collapsed: false }] },
				},
				{ bus }
			);
			bus.subscribe((event) => {
				if (event.type === 'agent.removed')
					seen.push(`removed:${event.agentId}:${repo.revisionOf(event.agentId)}`);
				else if (event.type === 'agent.updated' || event.type === 'agent.added') {
					seen.push(`${event.type}:${event.agent.id}:${repo.revisionOf(event.agent.id)}`);
					// The event is projected: no transcripts.
					expect(event.agent.aiTabs?.every((t) => !('logs' in t))).toBe(true);
				} else if (event.type === 'groups.changed') seen.push(`groups:${repo.groupsRevision()}`);
			});
			value(
				await repo.applyFold({
					agents: [{ ...touch('a1'), baseRev: 0, domain: { name: 'A2' } }],
					removeAgents: ['a3'],
					adoptAgents: [seedAgent('a4', 'D')],
					groups: { baseRev: 0, collapsed: {}, domain: [{ id: 'g1', name: 'G2' }] },
				})
			);
			expect(seen).toEqual(['removed:a3:0', 'agent.added:a4:1', 'agent.updated:a1:1', 'groups:1']);
		});

		it('emits nothing for desktop-owned keys alone, and no revision moves', async () => {
			const repo = await setup({ sessions: twoAgents() });
			value(await repo.applyFold({ agents: [touch('a1'), touch('a2')] }));
			expect(events).toEqual([]);
			expect(repo.revisionOf('a1')).toBe(0);
			expect(repo.revisionOf('a2')).toBe(0);
		});

		it('lands a domain change at the revision the sender holds, and a second stale fold is dropped', async () => {
			const repo = await setup({ sessions: twoAgents() });
			const first = value(
				await repo.applyFold({
					agents: [{ ...touch('a1'), baseRev: 0, domain: { bookmarked: true } }],
				})
			);
			expect(first.revs.a1).toBe(1);
			expect(repo.getAgent('a1')?.bookmarked).toBe(true);
			const second = value(
				await repo.applyFold({
					agents: [{ ...touch('a1'), baseRev: 0, domain: { bookmarked: false } }],
				})
			);
			expect(second.drift).toMatchObject([{ kind: 'domain-dropped' }]);
			expect(repo.getAgent('a1')?.bookmarked).toBe(true);
			// A command since then also makes a fold computed before it stale.
			value(await repo.renameAgent('a1', 'Alpha 2'));
			const third = value(
				await repo.applyFold({
					agents: [{ ...touch('a1'), baseRev: 1, domain: { bookmarked: false } }],
				})
			);
			expect(third.drift).toMatchObject([{ kind: 'domain-dropped' }]);
		});

		it('archives a closed tab before removing it from the record', async () => {
			const repo = await setup({ sessions: twoAgents() });
			value(
				await repo.applyFold({ agents: [{ ...touch('a1'), baseRev: 0, closeTabs: ['a1-t2'] }] })
			);
			const archive = await readClosedTabs(closedTabsFile(dir, 'a1'));
			expect(archive.map((entry) => entry.tab.id)).toEqual(['a1-t2']);
			expect(archive[0].tab.logs).toHaveLength(1);
			expect(repo.getTab('a1', 'a1-t2')).toBeUndefined();
			// The closed tab is now a tombstone: a stale client cannot adopt it back.
			const result = value(
				await repo.applyFold({ agents: [{ ...touch('a1'), adoptTabs: [tab('a1-t2')] }] })
			);
			expect(result.drift).toMatchObject([{ kind: 'tombstoned-tab', tabId: 'a1-t2' }]);
			expect(repo.getTab('a1', 'a1-t2')).toBeUndefined();
		});

		it('fails the fold without landing it when the archive cannot be written', async () => {
			const repo = await setup({ sessions: twoAgents() });
			// A file where the archive folder must be.
			fs.writeFileSync(path.join(dir, 'closed-tabs'), 'in the way');
			const result = await repo.applyFold({
				agents: [{ ...touch('a1'), baseRev: 0, closeTabs: ['a1-t2'] }],
			});
			expect(errorOf(result).code).toBe('failed');
			expect(repo.getTab('a1', 'a1-t2')).toBeDefined();
			expect(events).toEqual([]);
		});

		it('adopts a tab that was never archived, and an agent that was never removed', async () => {
			const repo = await setup({ sessions: twoAgents() });
			await archiveClosedTab(dir, 'a1', { tab: tab('old'), index: 0, closedAt: 1 });
			value(
				await repo.applyFold({
					agents: [{ ...touch('a1'), adoptTabs: [tab('old'), tab('new')] }],
					adoptAgents: [seedAgent('a3', 'Gamma')],
				})
			);
			expect(repo.getTab('a1', 'old')).toBeUndefined();
			expect(repo.getTab('a1', 'new')).toBeDefined();
			expect(repo.getAgent('a3')).toBeDefined();
			expect(repo.revisionOf('a3')).toBe(1);
		});

		it('removes an agent, tombstones it, and refuses its adoption and its id afterwards', async () => {
			const repo = await setup({ sessions: twoAgents() });
			value(await repo.applyFold({ agents: [], removeAgents: ['a1'] }));
			expect(repo.getAgent('a1')).toBeUndefined();
			expect(repo.snapshot().activeSessionId).toBe('a2');
			const again = value(
				await repo.applyFold({ agents: [], adoptAgents: [seedAgent('a1', 'Alpha')] })
			);
			expect(again.drift).toMatchObject([{ kind: 'tombstoned-agent', agentId: 'a1' }]);
			expect(errorOf(await repo.createAgent({ ...input, id: 'a1' })).code).toBe('invalid');
		});

		it('bounds the removed-agent tombstones at 1000, evicting the oldest', async () => {
			const repo = await setup({ sessions: twoAgents() });
			const ids = Array.from({ length: 1001 }, (_, i) => `gone-${i}`);
			value(await repo.applyFold({ agents: [], removeAgents: ids }));
			const oldest = value(
				await repo.applyFold({ agents: [], adoptAgents: [seedAgent('gone-0', 'Old')] })
			);
			expect(oldest.drift).toMatchObject([{ kind: 'adopted-agent' }]);
			const newest = value(
				await repo.applyFold({ agents: [], adoptAgents: [seedAgent('gone-1000', 'New')] })
			);
			expect(newest.drift).toMatchObject([{ kind: 'tombstoned-agent' }]);
		});

		it('tombstones a group removed by command or fold, so a stale list cannot adopt it back', async () => {
			const repo = await setup({
				groups: {
					groups: [
						{ id: 'g1', name: 'G1', collapsed: false },
						{ id: 'g2', name: 'G2', collapsed: false },
					],
				},
			});
			value(await repo.removeGroup('g1'));
			value(await repo.applyFold({ agents: [], groups: { collapsed: {}, removeGroups: ['g2'] } }));
			const result = value(
				await repo.applyFold({
					agents: [],
					groups: {
						baseRev: repo.groupsRevision(),
						collapsed: {},
						domain: [
							{ id: 'g1', name: 'G1' },
							{ id: 'g2', name: 'G2' },
						],
					},
				})
			);
			expect(result.drift).toEqual([]);
			expect(repo.listGroups()).toEqual([]);
		});

		it('a fold that removes the group emits groups.changed and bumps the groups revision', async () => {
			const repo = await setup({
				sessions: { sessions: [seedAgent('a1', 'A', { groupId: 'g1' })] },
				groups: { groups: [{ id: 'g1', name: 'G1', collapsed: false }] },
			});
			const result = value(
				await repo.applyFold({ agents: [], groups: { collapsed: {}, removeGroups: ['g1'] } })
			);
			expect(result.groupsRev).toBe(1);
			expect(result.revs.a1).toBe(1);
			expect(events.map((e) => e.type)).toEqual(['agent.updated', 'groups.changed']);
			expect(repo.getAgent('a1')?.groupId).toBeUndefined();
		});

		it('keeps an unchanged agent as the same object so the serializer can reuse its text', async () => {
			const repo = await setup({ sessions: twoAgents() });
			const a2 = repo.documents().sessions.sessions?.[1];
			value(await repo.applyFold({ agents: [touch('a1')] }));
			expect(repo.documents().sessions.sessions?.[1]).toBe(a2);
			expect(repo.documents().sessions.sessions?.[0]).not.toBe(twoAgents().sessions[0]);
		});

		it('runs in the command queue: a fold and a command racing do not interleave', async () => {
			const repo = await setup({ sessions: twoAgents() });
			const [rename, fold] = await Promise.all([
				repo.renameAgent('a1', 'Alpha 2'),
				repo.applyFold({ agents: [{ ...touch('a1'), baseRev: 0, domain: { name: 'Stale' } }] }),
			]);
			value(rename);
			// The command came first, so the fold's baseRev 0 is stale by the time it runs.
			expect(value(fold).drift).toMatchObject([{ kind: 'domain-dropped' }]);
			expect(repo.getAgent('a1')?.name).toBe('Alpha 2');
		});

		it('survives a bus listener that throws', async () => {
			const bus = createEventBus('[test]');
			bus.subscribe(() => {
				throw new Error('listener');
			});
			const repo = await setup({ sessions: twoAgents() }, { bus });
			const result = await repo.applyFold({
				agents: [{ ...touch('a1'), baseRev: 0, domain: { bookmarked: true } }],
			});
			expect(result.ok).toBe(true);
		});
	});
});

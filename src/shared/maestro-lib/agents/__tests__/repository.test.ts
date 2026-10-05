import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createEventBus } from '../../client/event-bus';
import type { ClientResult, MaestroEvent } from '../../client/types';
import type { MaestroPaths } from '../../paths/resolve';
import { STORE_SCHEMA_KEY } from '../../store/io';
import { closedTabsFile, archiveClosedTab, readClosedTabs } from '../closed-tabs';
import {
	createAgentRepository,
	type AgentRepository,
	type AgentRepositoryOptions,
	type RepositoryProcesses,
} from '../repository';
import { DEFAULT_TAB_DEFAULTS, type RuleContext } from '../rules';

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
		rcOnlyAgentField: { keep: [1, 2, 3] },
		...extra,
	};
}

const confText = (doc: unknown) => JSON.stringify(doc, null, '\t');

describe('agent repository', () => {
	let dir: string;
	let paths: MaestroPaths;
	let events: MaestroEvent[];
	let stopped: string[];
	let busy: Set<string>;

	const processes: RepositoryProcesses = {
		isBusy: (agentId, tabId) =>
			busy.has(tabId ? `${agentId}:${tabId}` : agentId) || busy.has(agentId),
		stopAgent: async (agentId) => {
			stopped.push(agentId);
		},
	};

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-repository-test-'));
		paths = makePaths(dir);
		events = [];
		stopped = [];
		busy = new Set();
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
			processes,
			context: makeContext(),
			readTabDefaults: async () => DEFAULT_TAB_DEFAULTS,
			checkCwd: () => null,
			...extra,
		});
		const loaded = await repo.load();
		if (!loaded.ok) throw new Error(`load failed: ${loaded.failure.message}`);
		return repo;
	}

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
		zebraDocumentKey: { nested: [1, { deep: true }] },
		sessions: [
			seedAgent('a1', 'Alpha'),
			{ weird: 'an entry this build does not recognize' },
			seedAgent('a2', 'Beta'),
		],
		activeSessionId: 'a1',
		alphaDocumentKey: 'after sessions',
	});

	// -----------------------------------------------------------------------

	describe('loading', () => {
		it('starts empty when no file exists, and writes nothing until a command runs', async () => {
			const repo = await setup();
			expect(repo.listAgents()).toEqual([]);
			expect(repo.listGroups()).toEqual([]);
			expect(fs.readdirSync(dir)).toEqual([]);
		});

		it('refuses a corrupt sessions file, names it, and leaves it alone', async () => {
			fs.writeFileSync(paths.sessionsFile, '{ torn');
			const repo = createAgentRepository({ paths, bus: createEventBus('[test]') });
			const loaded = await repo.load();
			expect(loaded).toMatchObject({
				ok: false,
				failure: { reason: 'store-corrupt', file: paths.sessionsFile },
			});
			expect(fs.readFileSync(paths.sessionsFile, 'utf-8')).toBe('{ torn');
		});

		it('refuses a sessions list that is not an array', async () => {
			fs.writeFileSync(paths.sessionsFile, confText({ sessions: 'nope' }));
			const loaded = await createAgentRepository({ paths, bus: createEventBus('[t]') }).load();
			expect(loaded).toMatchObject({ ok: false, failure: { reason: 'store-corrupt' } });
		});

		it('quarantines a corrupt file only when asked, then starts empty', async () => {
			fs.writeFileSync(paths.groupsFile, '{ torn');
			const repo = await setup({}, { quarantineCorruptStores: true });
			expect(repo.listGroups()).toEqual([]);
			expect(fs.existsSync(paths.groupsFile)).toBe(false);
			const sidecars = fs.readdirSync(dir).filter((name) => name.includes('.corrupt-'));
			expect(sidecars).toHaveLength(1);
		});

		it('refuses a file from a newer build, naming the version', async () => {
			fs.writeFileSync(paths.sessionsFile, confText({ [STORE_SCHEMA_KEY]: 9, sessions: [] }));
			const loaded = await createAgentRepository({ paths, bus: createEventBus('[t]') }).load();
			expect(loaded).toMatchObject({
				ok: false,
				failure: { reason: 'store-too-new', version: 9, file: paths.sessionsFile },
			});
		});
	});

	// -----------------------------------------------------------------------

	describe('createAgent', () => {
		const input = { name: 'Docs', provider: 'codex', cwd: '/p/docs' };

		it('writes the agent, then emits agent.added', async () => {
			// An event must never leave before its change is on disk (RT16).
			const seen: boolean[] = [];
			const bus = createEventBus('[test]');
			bus.subscribe((event) => {
				if (event.type === 'agent.added') {
					seen.push(readSessions().sessions.some((s: { id: string }) => s.id === event.agent.id));
				}
			});
			const repo = await setup({}, { bus });
			const { agentId } = value(await repo.createAgent(input));
			expect(seen).toEqual([true]);
			expect(readSessions().sessions[0]).toMatchObject({
				id: agentId,
				name: 'Docs',
				toolType: 'codex',
			});
			expect(repo.getAgent(agentId)?.aiTabs?.[0]).not.toHaveProperty('logs');
		});

		it('keeps every document key, and every entry it does not recognize, in place (DD-5)', async () => {
			const repo = await setup({ sessions: twoAgents() });
			const { agentId } = value(await repo.createAgent({ ...input, name: 'Gamma' }));
			const doc = readSessions();
			expect(Object.keys(doc)).toEqual([
				'zebraDocumentKey',
				'sessions',
				'activeSessionId',
				'alphaDocumentKey',
			]);
			expect(doc.zebraDocumentKey).toEqual({ nested: [1, { deep: true }] });
			expect(doc.sessions.map((s: { id?: string }) => s.id ?? 'unknown')).toEqual([
				'a1',
				'unknown',
				'a2',
				agentId,
			]);
			expect(doc.sessions[0].rcOnlyAgentField).toEqual({ keep: [1, 2, 3] });
			// Nothing about what the person is looking at moved (CO-4).
			expect(doc.activeSessionId).toBe('a1');
		});

		it('refuses a duplicate name, an unknown provider, an unknown group, and an unusable directory', async () => {
			const repo = await setup(
				{ sessions: twoAgents() },
				{ checkCwd: (cwd) => (cwd === '/gone' ? `Working directory does not exist: ${cwd}` : null) }
			);
			expect(errorOf(await repo.createAgent({ ...input, name: 'alpha' }))).toMatchObject({
				code: 'invalid',
				method: 'agents.create',
			});
			expect(errorOf(await repo.createAgent({ ...input, provider: 'nope' })).code).toBe('invalid');
			expect(errorOf(await repo.createAgent({ ...input, groupId: 'missing' })).code).toBe(
				'not-found'
			);
			expect(errorOf(await repo.createAgent({ ...input, cwd: '/gone' })).message).toContain(
				'does not exist'
			);
			expect(events).toEqual([]);
			expect(repo.listAgents()).toHaveLength(2);
		});

		it('does not check the directory of an SSH agent: it lives on another machine', async () => {
			const repo = await setup({}, { checkCwd: () => 'never exists here' });
			const result = await repo.createAgent({
				...input,
				ssh: { enabled: true, remoteId: 'r1' },
			});
			expect(result.ok).toBe(true);
			expect(readSessions().sessions[0].sessionSshRemoteConfig).toEqual({
				enabled: true,
				remoteId: 'r1',
			});
		});

		it('allows a directory another agent already uses (a warning for the form, not a refusal)', async () => {
			const repo = await setup({ sessions: twoAgents() });
			expect((await repo.createAgent({ ...input, name: 'Twin', cwd: '/work/a1' })).ok).toBe(true);
		});
	});

	// -----------------------------------------------------------------------

	describe('updateAgent', () => {
		it('applies name, config, and group in one write and reports what it applied', async () => {
			const repo = await setup({
				sessions: twoAgents(),
				groups: { groups: [{ id: 'g1', name: 'G', emoji: 'x', collapsed: false }] },
			});
			const receipt = value(
				await repo.updateAgent('a1', {
					name: 'Renamed',
					model: 'opus',
					env: { KEY: 'v', BLANK: '' },
					bookmarked: true,
					groupId: 'g1',
				})
			);
			expect(receipt.applied).toEqual(['model', 'env', 'bookmarked', 'name', 'groupId']);
			expect(readSessions().sessions[0]).toMatchObject({
				name: 'Renamed',
				customModel: 'opus',
				customEnvVars: { KEY: 'v' },
				bookmarked: true,
				groupId: 'g1',
				rcOnlyAgentField: { keep: [1, 2, 3] },
			});
			expect(events.map((event) => event.type)).toEqual(['agent.updated']);
		});

		it('clears a field on null and drops the window provenance with the window', async () => {
			const repo = await setup({
				sessions: {
					sessions: [
						seedAgent('a1', 'Alpha', {
							customModel: 'm',
							customContextWindow: 5,
							contextWindowSource: 'user-edited',
						}),
					],
				},
			});
			value(await repo.updateAgent('a1', { model: null, contextWindow: null }));
			const stored = readSessions().sessions[0];
			expect(stored).not.toHaveProperty('customModel');
			expect(stored).not.toHaveProperty('customContextWindow');
			expect(stored).not.toHaveProperty('contextWindowSource');
		});

		it('moves every path field with the working directory', async () => {
			const repo = await setup({
				sessions: {
					sessions: [
						seedAgent('a1', 'Alpha', {
							fullPath: '/work/a1',
							shellCwd: '/work/a1',
							autoRunFolderPath: '/work/a1/.maestro/playbooks',
						}),
					],
				},
			});
			value(await repo.updateAgent('a1', { cwd: '/work/moved' }));
			expect(readSessions().sessions[0]).toMatchObject({
				cwd: '/work/moved',
				fullPath: '/work/moved',
				shellCwd: '/work/moved',
				projectRoot: '/work/moved',
				autoRunFolderPath: '/work/moved/.maestro/playbooks',
			});
		});

		it('refuses a cwd or SSH change while a process runs, and changes nothing at all', async () => {
			const repo = await setup({ sessions: twoAgents() });
			const before = fs.readFileSync(paths.sessionsFile, 'utf-8');
			busy.add('a1');
			// The model is valid, but the cwd is refused, so the whole update fails (RT12).
			const refused = errorOf(await repo.updateAgent('a1', { model: 'x', cwd: '/work/else' }));
			expect(refused).toMatchObject({ code: 'rejected', method: 'agents.update' });
			expect(refused.message).toContain('Stop the agent');
			expect(refused.appliedFields).toBeUndefined();
			expect(errorOf(await repo.updateAgent('a1', { ssh: { enabled: true } })).code).toBe(
				'rejected'
			);
			expect(fs.readFileSync(paths.sessionsFile, 'utf-8')).toBe(before);
			expect(repo.getAgent('a1')).not.toHaveProperty('customModel');
			expect(events).toEqual([]);
			// Config fields are spawn-time settings: allowed while the agent runs.
			expect((await repo.updateAgent('a1', { model: 'x' })).ok).toBe(true);
		});

		it('merges SSH settings and always keeps enabled and remoteId', async () => {
			const repo = await setup({ sessions: twoAgents() });
			value(await repo.updateAgent('a1', { ssh: { workingDirOverride: '/r' } }));
			expect(readSessions().sessions[0].sessionSshRemoteConfig).toEqual({
				enabled: false,
				remoteId: null,
				workingDirOverride: '/r',
			});
		});

		it('switches provider through the swap: parks the session, reports notices, emits tab.updated first', async () => {
			const repo = await setup({
				sessions: {
					sessions: [
						seedAgent('a1', 'Alpha', {
							customModel: 'opus',
							aiTabs: [tab('t1', { agentSessionId: 'sess-claude' })],
							executionQueue: [{ id: 'q1', tabId: 't1', turnSettings: { model: 'opus' } }],
						}),
					],
				},
			});
			const receipt = value(await repo.updateAgent('a1', { provider: 'codex' }));
			expect(receipt.applied).toEqual(['provider']);
			expect(receipt.notices).toHaveLength(1);
			const stored = readSessions().sessions[0];
			expect(stored.toolType).toBe('codex');
			expect(stored).not.toHaveProperty('customModel');
			expect(stored.aiTabs[0].agentSessionId).toBeNull();
			expect(stored.aiTabs[0].logs).toHaveLength(1);
			expect(events.map((event) => event.type)).toEqual(['tab.updated', 'agent.updated']);

			value(await repo.updateAgent('a1', { provider: 'claude-code' }));
			const restored = readSessions().sessions[0];
			expect(restored.customModel).toBe('opus');
			expect(restored.aiTabs[0].agentSessionId).toBe('sess-claude');
		});

		it('moves worktree children with their parent when the group changes', async () => {
			const repo = await setup({
				sessions: {
					sessions: [
						seedAgent('p', 'Parent'),
						seedAgent('c', 'Child', { parentSessionId: 'p' }),
						seedAgent('x', 'Other'),
					],
				},
				groups: { groups: [{ id: 'g1', name: 'G', emoji: 'x', collapsed: false }] },
			});
			value(await repo.updateAgent('p', { groupId: 'g1' }));
			const byId = Object.fromEntries(
				readSessions().sessions.map((s: { id: string }) => [s.id, s])
			);
			expect(byId.p.groupId).toBe('g1');
			expect(byId.c.groupId).toBe('g1');
			expect(byId.x).not.toHaveProperty('groupId');
		});

		it('points the Auto Run folder at a folder that lists, and selects its first document', async () => {
			const runs = path.join(dir, 'runs');
			fs.mkdirSync(runs);
			fs.writeFileSync(path.join(runs, 'a.md'), '- [ ] one\n');
			fs.writeFileSync(path.join(runs, 'b.md'), '- [ ] two\n');
			const repo = await setup({
				sessions: {
					sessions: [
						seedAgent('a1', 'Alpha', { autoRunContent: 'stale', autoRunContentVersion: 3 }),
					],
				},
			});
			value(await repo.updateAgent('a1', { autoRunFolderPath: runs }));
			const stored = readSessions().sessions[0];
			expect(stored).toMatchObject({
				autoRunFolderPath: runs,
				autoRunSelectedFile: 'a',
				autoRunContentVersion: 4,
			});
			expect(stored).not.toHaveProperty('autoRunContent');
			expect(
				errorOf(await repo.updateAgent('a1', { autoRunFolderPath: path.join(dir, 'nope') })).code
			).toBe('invalid');
		});

		it('answers unsupported for the Auto Run folder of an SSH agent', async () => {
			const repo = await setup({
				sessions: {
					sessions: [
						seedAgent('a1', 'Alpha', { sessionSshRemoteConfig: { enabled: true, remoteId: 'r' } }),
					],
				},
			});
			expect(errorOf(await repo.updateAgent('a1', { autoRunFolderPath: '/x' })).code).toBe(
				'unsupported'
			);
		});

		it('validates before changing anything', async () => {
			const repo = await setup({ sessions: twoAgents() });
			const before = fs.readFileSync(paths.sessionsFile, 'utf-8');
			expect(errorOf(await repo.updateAgent('a1', { provider: 'terminal' })).code).toBe('invalid');
			expect(errorOf(await repo.updateAgent('a1', { name: 'beta' })).code).toBe('invalid');
			expect(errorOf(await repo.updateAgent('a1', { cwd: '  ' })).code).toBe('invalid');
			expect(errorOf(await repo.updateAgent('a1', { groupId: 'missing' })).code).toBe('not-found');
			expect(errorOf(await repo.updateAgent('nope', { model: 'm' })).code).toBe('not-found');
			expect(fs.readFileSync(paths.sessionsFile, 'utf-8')).toBe(before);
		});

		it('writes and emits nothing for an empty patch', async () => {
			const repo = await setup({ sessions: twoAgents() });
			fs.rmSync(paths.sessionsFile);
			expect(value(await repo.updateAgent('a1', {}))).toEqual({ applied: [] });
			expect(fs.existsSync(paths.sessionsFile)).toBe(false);
			expect(events).toEqual([]);
		});
	});

	// -----------------------------------------------------------------------

	describe('renameAgent', () => {
		it('renames, refusing a taken name and an empty one', async () => {
			const repo = await setup({ sessions: twoAgents() });
			value(await repo.renameAgent('a1', '  Gamma '));
			expect(readSessions().sessions[0].name).toBe('Gamma');
			expect(errorOf(await repo.renameAgent('a1', 'beta')).code).toBe('invalid');
			expect(errorOf(await repo.renameAgent('a1', '  ')).code).toBe('invalid');
			expect(errorOf(await repo.renameAgent('nope', 'X')).code).toBe('not-found');
			expect(events.map((event) => event.type)).toEqual(['agent.updated']);
		});

		it('writes and emits nothing when the name does not change', async () => {
			const repo = await setup({ sessions: twoAgents() });
			value(await repo.renameAgent('a1', 'Alpha'));
			expect(events).toEqual([]);
		});
	});

	// -----------------------------------------------------------------------

	describe('removeAgent', () => {
		it('stops every process, removes the record, and moves the active pointer to the first survivor', async () => {
			const repo = await setup({ sessions: twoAgents() });
			value(await repo.removeAgent('a1'));
			expect(stopped).toEqual(['a1']);
			const doc = readSessions();
			expect(doc.sessions.map((s: { id?: string }) => s.id ?? 'unknown')).toEqual([
				'unknown',
				'a2',
			]);
			// The first survivor is the first RECOGNIZED agent; the pointer never names a stranger entry.
			expect(doc.activeSessionId).toBe('a2');
			expect(events).toEqual([{ type: 'agent.removed', agentId: 'a1' }]);
			expect(Object.keys(doc)).toEqual([
				'zebraDocumentKey',
				'sessions',
				'activeSessionId',
				'alphaDocumentKey',
			]);
		});

		it('leaves the pointer alone when it names another agent, and empties it when none survive', async () => {
			const repo = await setup({ sessions: twoAgents() });
			value(await repo.removeAgent('a2'));
			expect(readSessions().activeSessionId).toBe('a1');
			value(await repo.removeAgent('a1'));
			expect(readSessions().activeSessionId).toBe('');
		});

		it('deletes the agent playbooks file and closed-tab archive, and nothing else', async () => {
			const repo = await setup({ sessions: twoAgents() });
			fs.mkdirSync(path.join(dir, 'playbooks'));
			fs.writeFileSync(path.join(dir, 'playbooks', 'a1.json'), '{}');
			fs.writeFileSync(path.join(dir, 'playbooks', 'a2.json'), '{}');
			await archiveClosedTab(dir, 'a1', { tab: { id: 'x' }, index: 0, closedAt: 1 });
			fs.mkdirSync(paths.historyDir);
			fs.writeFileSync(path.join(paths.historyDir, 'a1.jsonl'), '{"kept":true}\n');

			value(await repo.removeAgent('a1'));
			expect(fs.existsSync(path.join(dir, 'playbooks', 'a1.json'))).toBe(false);
			expect(fs.existsSync(path.join(dir, 'playbooks', 'a2.json'))).toBe(true);
			expect(fs.existsSync(closedTabsFile(dir, 'a1'))).toBe(false);
			expect(fs.existsSync(path.join(paths.historyDir, 'a1.jsonl'))).toBe(true);
		});

		it('never reaches outside the playbooks folder for an odd id', async () => {
			const odd = '../escape';
			const repo = await setup({ sessions: { sessions: [seedAgent(odd, 'Odd')] } });
			// `<userData>/playbooks/../escape.json` would be this file.
			fs.mkdirSync(path.join(dir, 'playbooks'));
			fs.writeFileSync(path.join(dir, 'escape.json'), '{}');
			value(await repo.removeAgent(odd));
			expect(fs.existsSync(path.join(dir, 'escape.json'))).toBe(true);
		});

		it('keeps a removal that landed even when cleanup fails', async () => {
			const repo = await setup({ sessions: twoAgents() });
			fs.mkdirSync(path.join(dir, 'playbooks'));
			// A directory where the file should be makes `rm` without `recursive` fail.
			fs.mkdirSync(path.join(dir, 'playbooks', 'a1.json'));
			expect((await repo.removeAgent('a1')).ok).toBe(true);
			expect(repo.getAgent('a1')).toBeUndefined();
		});
	});

	// -----------------------------------------------------------------------

	describe('groups', () => {
		it('creates a group, upper-cased, with an id and the default emoji', async () => {
			const repo = await setup({});
			const { groupId } = value(await repo.createGroup({ name: ' infra ' }));
			expect(groupId).toBe('group-id-1');
			expect(readGroups().groups).toEqual([
				{ id: groupId, name: 'INFRA', emoji: '\u{1F4C2}', kind: 'user', collapsed: false },
			]);
			expect(events).toEqual([{ type: 'groups.changed', groups: readGroups().groups }]);
		});

		it('allows one level of nesting', async () => {
			const repo = await setup({});
			const { groupId: root } = value(await repo.createGroup({ name: 'root' }));
			const { groupId: child } = value(
				await repo.createGroup({ name: 'child', parentGroupId: root })
			);
			expect(errorOf(await repo.createGroup({ name: 'deep', parentGroupId: child })).code).toBe(
				'invalid'
			);
			expect(errorOf(await repo.createGroup({ name: '  ' })).code).toBe('invalid');
		});

		it('renames a group', async () => {
			const repo = await setup({
				groups: { groups: [{ id: 'g1', name: 'OLD', emoji: 'x', extra: 1 }] },
			});
			value(await repo.renameGroup('g1', 'fresh'));
			expect(readGroups().groups[0]).toEqual({ id: 'g1', name: 'FRESH', emoji: 'x', extra: 1 });
			expect(errorOf(await repo.renameGroup('nope', 'x')).code).toBe('not-found');
			expect(errorOf(await repo.renameGroup('g1', ' ')).code).toBe('invalid');
		});

		it('deleting a group deletes no agent: members become ungrouped, children move up', async () => {
			const repo = await setup({
				sessions: {
					sessions: [
						seedAgent('a1', 'Alpha', { groupId: 'g1' }),
						seedAgent('a2', 'Beta', { groupId: 'g2' }),
						seedAgent('a3', 'Gamma'),
					],
				},
				groups: {
					groups: [
						{ id: 'g1', name: 'ONE', emoji: 'x', collapsed: false },
						{ id: 'g2', name: 'TWO', emoji: 'x', collapsed: false, parentGroupId: 'g1' },
					],
				},
			});
			value(await repo.removeGroup('g1'));
			const sessions = readSessions().sessions;
			expect(sessions.map((s: { id: string }) => s.id)).toEqual(['a1', 'a2', 'a3']);
			expect(sessions[0]).not.toHaveProperty('groupId');
			expect(sessions[1].groupId).toBe('g2');
			expect(sessions[0].rcOnlyAgentField).toEqual({ keep: [1, 2, 3] });
			const groups = readGroups().groups;
			expect(groups.map((g: { id: string }) => g.id)).toEqual(['g2']);
			expect(groups[0]).not.toHaveProperty('parentGroupId');
			expect(events.map((event) => event.type)).toEqual(['agent.updated', 'groups.changed']);
		});

		it('does not rewrite the sessions file when the group has no members', async () => {
			const repo = await setup({ groups: { groups: [{ id: 'g1', name: 'ONE', emoji: 'x' }] } });
			value(await repo.removeGroup('g1'));
			expect(fs.existsSync(paths.sessionsFile)).toBe(false);
			expect(readGroups().groups).toEqual([]);
			expect(errorOf(await repo.removeGroup('g1')).code).toBe('not-found');
		});

		it('moves an agent between groups, and its worktree children with it', async () => {
			const repo = await setup({
				sessions: {
					sessions: [
						seedAgent('p', 'Parent'),
						seedAgent('c', 'Child', { parentSessionId: 'p' }),
						seedAgent('x', 'Other'),
					],
				},
				groups: { groups: [{ id: 'g1', name: 'ONE', emoji: 'x' }] },
			});
			value(await repo.moveAgentToGroup('p', 'g1'));
			let byId = Object.fromEntries(readSessions().sessions.map((s: { id: string }) => [s.id, s]));
			expect([byId.p.groupId, byId.c.groupId]).toEqual(['g1', 'g1']);
			expect(byId.x).not.toHaveProperty('groupId');
			expect(events.map((event) => event.type)).toEqual(['agent.updated', 'agent.updated']);

			events.length = 0;
			value(await repo.moveAgentToGroup('p', null));
			byId = Object.fromEntries(readSessions().sessions.map((s: { id: string }) => [s.id, s]));
			expect(byId.p).not.toHaveProperty('groupId');
			expect(byId.c).not.toHaveProperty('groupId');

			events.length = 0;
			value(await repo.moveAgentToGroup('p', null));
			expect(events).toEqual([]);
			expect(errorOf(await repo.moveAgentToGroup('p', 'missing')).code).toBe('not-found');
			expect(errorOf(await repo.moveAgentToGroup('nope', null)).code).toBe('not-found');
		});
	});

	// -----------------------------------------------------------------------

	describe('tabs', () => {
		it('creates a tab at the end without making it active, and emits tab.added then agent.updated', async () => {
			const repo = await setup({ sessions: twoAgents() });
			const { tabId } = value(await repo.createTab('a1'));
			const stored = readSessions().sessions[0];
			expect(stored.aiTabs.map((t: { id: string }) => t.id)).toEqual(['a1-t1', 'a1-t2', tabId]);
			expect(stored.activeTabId).toBe('a1-t1');
			expect(stored.unifiedTabOrder.at(-1)).toEqual({ type: 'ai', id: tabId });
			expect(events.map((event) => event.type)).toEqual(['tab.added', 'agent.updated']);
			expect(errorOf(await repo.createTab('nope')).code).toBe('not-found');
		});

		it('lists only the tabs a person sees, in strip order, without transcripts', async () => {
			const repo = await setup({
				sessions: {
					sessions: [
						seedAgent('a1', 'Alpha', {
							aiTabs: [tab('t1'), tab('hid', { hidden: true }), tab('t2')],
							unifiedTabOrder: [
								{ type: 'ai', id: 't2' },
								{ type: 'ai', id: 'hid' },
								{ type: 'ai', id: 't1' },
							],
						}),
					],
				},
			});
			expect(repo.listTabs('a1')?.map((t) => t.id)).toEqual(['t2', 't1']);
			expect(repo.listTabs('a1')?.[0]).not.toHaveProperty('logs');
			expect(repo.getTab('a1', 'hid')?.logs).toHaveLength(1);
			expect(repo.listTabs('nope')).toBeUndefined();
		});

		it('renames a tab, and an empty name clears it', async () => {
			const repo = await setup({ sessions: twoAgents() });
			value(await repo.renameTab('a1', 'a1-t1', ' Plan '));
			expect(readSessions().sessions[0].aiTabs[0].name).toBe('Plan');
			expect(events.map((event) => event.type)).toEqual(['tab.updated', 'agent.updated']);
			value(await repo.renameTab('a1', 'a1-t1', ''));
			expect(readSessions().sessions[0].aiTabs[0].name).toBeNull();
			expect(readSessions().sessions[0].aiTabs[0].logs).toHaveLength(1);
		});

		it('stars to a value, so a retry is harmless', async () => {
			const repo = await setup({ sessions: twoAgents() });
			value(await repo.starTab('a1', 'a1-t2', true));
			events.length = 0;
			value(await repo.starTab('a1', 'a1-t2', true));
			expect(events).toEqual([]);
			expect(readSessions().sessions[0].aiTabs[1].starred).toBe(true);
			value(await repo.starTab('a1', 'a1-t2', false));
			expect(readSessions().sessions[0].aiTabs[1].starred).toBe(false);
		});

		it('updates composer settings, clears on null, and refuses a bad value as a whole', async () => {
			const repo = await setup({ sessions: twoAgents() });
			value(
				await repo.updateTab('a1', 'a1-t1', {
					readOnly: true,
					thinking: 'sticky',
					model: 'm',
					saveToHistory: false,
				})
			);
			expect(readSessions().sessions[0].aiTabs[0]).toMatchObject({
				readOnlyMode: true,
				showThinking: 'sticky',
				customModel: 'm',
				saveToHistory: false,
			});
			value(await repo.updateTab('a1', 'a1-t1', { model: null }));
			expect(readSessions().sessions[0].aiTabs[0]).not.toHaveProperty('customModel');
			const before = fs.readFileSync(paths.sessionsFile, 'utf-8');
			expect(errorOf(await repo.updateTab('a1', 'a1-t1', { thinking: 'loud' as never })).code).toBe(
				'invalid'
			);
			expect(fs.readFileSync(paths.sessionsFile, 'utf-8')).toBe(before);
			events.length = 0;
			value(await repo.updateTab('a1', 'a1-t1', {}));
			expect(events).toEqual([]);
		});

		it('answers not-found for a tab that is hidden or missing, and for a missing agent', async () => {
			const repo = await setup({
				sessions: {
					sessions: [
						seedAgent('a1', 'Alpha', { aiTabs: [tab('t1'), tab('hid', { hidden: true })] }),
					],
				},
			});
			expect(errorOf(await repo.renameTab('a1', 'hid', 'x')).code).toBe('not-found');
			expect(errorOf(await repo.starTab('a1', 'nope', true)).code).toBe('not-found');
			expect(errorOf(await repo.updateTab('nope', 't1', {})).code).toBe('not-found');
			expect(errorOf(await repo.closeTab('a1', 'hid')).code).toBe('not-found');
		});

		describe('appendTranscript', () => {
			const entry = (id: string, text: string) => ({
				id,
				timestamp: 10,
				source: 'user',
				text,
			});

			it('adds entries after the ones the tab holds, in order, and keeps every other field', async () => {
				const repo = await setup({ sessions: twoAgents() });
				events.length = 0;
				value(await repo.appendTranscript('a1', 'a1-t1', [entry('n1', 'one'), entry('n2', 'two')]));
				const stored = readSessions().sessions[0].aiTabs[0];
				expect(stored.logs.map((l: { id: string }) => l.id)).toEqual(['a1-t1-l1', 'n1', 'n2']);
				expect(readSessions().sessions[0].rcOnlyAgentField).toEqual({ keep: [1, 2, 3] });
				expect(repo.getTab('a1', 'a1-t1')?.logs).toHaveLength(3);
				expect(events.map((event) => event.type)).toEqual(['tab.updated', 'agent.updated']);
				const updated = events[0] as Extract<MaestroEvent, { type: 'tab.updated' }>;
				expect(updated.tab).not.toHaveProperty('logs');
			});

			it('writes a hidden consult tab and raises no tab event for it', async () => {
				const repo = await setup({
					sessions: {
						sessions: [
							seedAgent('a1', 'Alpha', { aiTabs: [tab('t1'), tab('hid', { hidden: true })] }),
						],
					},
				});
				events.length = 0;
				value(await repo.appendTranscript('a1', 'hid', [entry('n1', 'answer')]));
				expect(repo.getTab('a1', 'hid')?.logs).toHaveLength(2);
				expect(events.map((event) => event.type)).toEqual(['agent.updated']);
			});

			it('starts a transcript on a tab that has none, and writes nothing for no entries', async () => {
				const repo = await setup({
					sessions: { sessions: [seedAgent('a1', 'Alpha', { aiTabs: [{ id: 't1' }] })] },
				});
				value(await repo.appendTranscript('a1', 't1', []));
				expect(readSessions().sessions[0].aiTabs[0]).not.toHaveProperty('logs');
				value(await repo.appendTranscript('a1', 't1', [entry('n1', 'first')]));
				expect(readSessions().sessions[0].aiTabs[0].logs).toHaveLength(1);
			});

			it('answers not-found for an agent or a tab that is not there', async () => {
				const repo = await setup({ sessions: twoAgents() });
				expect(errorOf(await repo.appendTranscript('nope', 'a1-t1', [entry('n', 'x')])).code).toBe(
					'not-found'
				);
				expect(errorOf(await repo.appendTranscript('a1', 'nope', [entry('n', 'x')])).code).toBe(
					'not-found'
				);
			});

			it('answers host-lost and writes nothing once fenced', async () => {
				const repo = await setup({ sessions: twoAgents() });
				repo.fence('lost');
				expect(errorOf(await repo.appendTranscript('a1', 'a1-t1', [entry('n', 'x')])).code).toBe(
					'host-lost'
				);
				expect(readSessions().sessions[0].aiTabs[0].logs).toHaveLength(1);
			});
		});

		describe('beginTurn and recordTabSession', () => {
			const userEntry = { id: 'u1', timestamp: 10, source: 'user', text: 'hello' };

			it('writes the message, the owning provider, and the spent merge in one write', async () => {
				const repo = await setup({
					sessions: {
						sessions: [
							seedAgent('a1', 'Alpha', {
								aiTabs: [tab('t1', { pendingMergedContext: 'carried over' })],
							}),
						],
					},
				});
				events.length = 0;
				value(
					await repo.beginTurn('a1', 't1', {
						userEntry,
						provider: 'claude-code',
						consumedMergedContext: true,
					})
				);
				const stored = readSessions().sessions[0].aiTabs[0];
				expect(stored.logs.map((l: { id: string }) => l.id)).toEqual(['t1-l1', 'u1']);
				expect(stored.turnProvider).toBe('claude-code');
				expect(stored).not.toHaveProperty('pendingMergedContext');
				expect(events.map((event) => event.type)).toEqual(['tab.updated', 'agent.updated']);
			});

			it('records a session id on the current provider, and on a parked slot for a late turn', async () => {
				const repo = await setup({ sessions: twoAgents() });
				value(await repo.recordTabSession('a1', 'a1-t1', 'claude-code', { agentSessionId: 'S1' }));
				expect(readSessions().sessions[0].aiTabs[0].agentSessionId).toBe('S1');

				value(await repo.recordTabSession('a1', 'a1-t1', 'codex', { agentSessionId: 'C1' }));
				const stored = readSessions().sessions[0].aiTabs[0];
				expect(stored.agentSessionId).toBe('S1');
				expect(stored.providerSessions.codex.agentSessionId).toBe('C1');
			});

			it('answers not-found and writes nothing for an agent or tab that is gone', async () => {
				const repo = await setup({ sessions: twoAgents() });
				expect(
					errorOf(
						await repo.beginTurn('nope', 'a1-t1', {
							userEntry,
							provider: 'claude-code',
							consumedMergedContext: false,
						})
					).code
				).toBe('not-found');
				expect(
					errorOf(await repo.recordTabSession('a1', 'nope', 'claude-code', { agentSessionId: 'x' }))
						.code
				).toBe('not-found');
				expect(readSessions().sessions[0].aiTabs[0].logs).toHaveLength(1);
			});
		});

		describe('closeTab', () => {
			it('archives the whole tab, removes it, and moves the active tab left', async () => {
				const repo = await setup({
					sessions: { sessions: [seedAgent('a1', 'Alpha', { activeTabId: 'a1-t2' })] },
				});
				value(await repo.closeTab('a1', 'a1-t2'));
				const stored = readSessions().sessions[0];
				expect(stored.aiTabs.map((t: { id: string }) => t.id)).toEqual(['a1-t1']);
				expect(stored.activeTabId).toBe('a1-t1');
				const archived = await readClosedTabs(closedTabsFile(dir, 'a1'));
				expect(archived).toHaveLength(1);
				expect(archived[0]).toMatchObject({ index: 1, tab: { id: 'a1-t2' } });
				// The transcript went with it. Closing never deletes one.
				expect(archived[0].tab.logs).toEqual([
					{ id: 'a1-t2-l1', timestamp: 1, source: 'user', text: 'hello from a1-t2' },
				]);
				expect(events.map((event) => event.type)).toEqual(['tab.removed', 'agent.updated']);
			});

			it('creates a replacement only when no tab of any kind survives', async () => {
				const repo = await setup({
					sessions: {
						sessions: [
							seedAgent('a1', 'Alpha', {
								aiTabs: [tab('t1')],
								activeTabId: 't1',
								unifiedTabOrder: [{ type: 'ai', id: 't1' }],
							}),
						],
					},
				});
				value(await repo.closeTab('a1', 't1'));
				const stored = readSessions().sessions[0];
				expect(stored.aiTabs).toHaveLength(1);
				expect(stored.aiTabs[0].id).not.toBe('t1');
				expect(stored.activeTabId).toBe(stored.aiTabs[0].id);
				expect(events.map((event) => event.type)).toEqual([
					'tab.removed',
					'tab.added',
					'agent.updated',
				]);
			});

			it('writes the archive before the sessions record, so a failed second write loses nothing', async () => {
				const repo = await setup({ sessions: twoAgents() });
				// The sessions write will fail: a directory sits where the file is.
				fs.rmSync(paths.sessionsFile);
				fs.mkdirSync(paths.sessionsFile);
				const error = errorOf(await repo.closeTab('a1', 'a1-t1'));
				expect(error.code).toBe('failed');
				const archived = await readClosedTabs(closedTabsFile(dir, 'a1'));
				expect(archived.map((entry) => entry.tab.id)).toEqual(['a1-t1']);
				// The tab is still open in memory, and no event announced a close.
				expect(repo.listTabs('a1')?.map((t) => t.id)).toEqual(['a1-t1', 'a1-t2']);
				expect(events).toEqual([]);
			});

			it('refuses to close a tab that has a turn running', async () => {
				const repo = await setup({ sessions: twoAgents() });
				busy.add('a1:a1-t1');
				const error = errorOf(await repo.closeTab('a1', 'a1-t1'));
				expect(error.code).toBe('rejected');
				expect(repo.listTabs('a1')).toHaveLength(2);
				expect(fs.existsSync(closedTabsFile(dir, 'a1'))).toBe(false);
				// Another tab of the same agent is free to close.
				expect((await repo.closeTab('a1', 'a1-t2')).ok).toBe(true);
			});
		});
	});

	// -----------------------------------------------------------------------

	describe('writes and ordering', () => {
		it('leaves memory and listeners as they were when a write fails', async () => {
			const repo = await setup({ sessions: twoAgents() });
			fs.rmSync(paths.sessionsFile);
			fs.mkdirSync(paths.sessionsFile);
			const error = errorOf(
				await repo.createAgent({ name: 'Gamma', provider: 'codex', cwd: '/p' })
			);
			expect(error).toMatchObject({ code: 'failed', method: 'agents.create' });
			expect(repo.listAgents().map((a) => a.id)).toEqual(['a1', 'a2']);
			expect(events).toEqual([]);
		});

		it('refuses to overwrite a file a newer build wrote after this process read it', async () => {
			const repo = await setup({ sessions: twoAgents() });
			fs.writeFileSync(paths.sessionsFile, confText({ [STORE_SCHEMA_KEY]: 5, sessions: [] }));
			const error = errorOf(await repo.renameAgent('a1', 'Gamma'));
			expect(error.code).toBe('failed');
			expect(error.message).toContain('newer than this build knows');
			expect(JSON.parse(fs.readFileSync(paths.sessionsFile, 'utf-8')).sessions).toEqual([]);
		});

		it('runs commands one at a time: parallel creates all land, with distinct ids', async () => {
			const repo = await setup({});
			const results = await Promise.all(
				['a', 'b', 'c', 'd', 'e'].map((name) => repo.createGroup({ name }))
			);
			const ids = results.map((result) => value(result).groupId);
			expect(new Set(ids).size).toBe(5);
			expect(readGroups().groups.map((g: { id: string }) => g.id)).toEqual(ids);
		});

		it('backs up the sessions list before an emptying write', async () => {
			const repo = await setup({ sessions: { sessions: [seedAgent('a1', 'Alpha')] } });
			value(await repo.removeAgent('a1'));
			const backup = JSON.parse(
				fs.readFileSync(path.join(dir, 'maestro-sessions.backup.json'), 'utf-8')
			);
			expect(backup.entries.map((s: { id: string }) => s.id)).toEqual(['a1']);
		});
	});

	// -----------------------------------------------------------------------

	describe('the fence (RT11)', () => {
		it('answers host-lost and writes nothing when the fence says another process took over', async () => {
			const repo = await setup(
				{},
				{ fence: () => ({ ok: false, reason: 'Another Maestro took over.' }) }
			);
			const error = errorOf(await repo.createGroup({ name: 'x' }));
			expect(error).toMatchObject({ code: 'host-lost', message: 'Another Maestro took over.' });
			expect(fs.existsSync(paths.groupsFile)).toBe(false);
			expect(events).toEqual([]);
		});

		it('is checked before every write, not only at the start', async () => {
			let allowed = true;
			const repo = await setup(
				{},
				{ fence: () => (allowed ? { ok: true } : { ok: false, reason: 'lost' }) }
			);
			value(await repo.createGroup({ name: 'one' }));
			allowed = false;
			expect(errorOf(await repo.createGroup({ name: 'two' })).code).toBe('host-lost');
			expect(readGroups().groups).toHaveLength(1);
		});

		it('stays fenced once told, even if the fence function would now pass, and reads still work', async () => {
			const repo = await setup({ sessions: twoAgents() });
			repo.fence('The heartbeat answered lost.');
			expect(errorOf(await repo.renameAgent('a1', 'Gamma'))).toMatchObject({
				code: 'host-lost',
				message: 'The heartbeat answered lost.',
			});
			expect(errorOf(await repo.removeAgent('a1')).code).toBe('host-lost');
			expect(stopped).toEqual([]);
			expect(repo.listAgents()).toHaveLength(2);
		});
	});

	// -----------------------------------------------------------------------

	describe('consult tabs', () => {
		const KEY = { sourceSessionId: 'a2', sourceTabId: 'a2-t1' };
		const question = (text: string) => ({
			id: `q-${text}`,
			timestamp: 5,
			source: 'user',
			text,
		});
		const open = (text = 'what do you think?') => ({
			key: KEY,
			name: '↩ Beta',
			question: question(text),
		});
		const answer = (text: string, extra: Record<string, unknown> = {}) => ({
			entry: { id: `a-${text}`, timestamp: 6, source: 'ai', text },
			provider: 'claude-code',
			...extra,
		});

		it('creates a hidden tab that no person-visible surface can see (XM-2)', async () => {
			const repo = await setup({ sessions: twoAgents() });
			const before = repo.getAgent('a1')!;

			const opened = value(await repo.openConsultTab('a1', open()));

			// Not listed, not announced, not focused.
			expect(repo.listTabs('a1')?.map((t) => t.id)).toEqual(['a1-t1', 'a1-t2']);
			expect(events.map((event) => event.type)).toEqual(['agent.updated']);
			const after = repo.getAgent('a1')!;
			expect(after.activeTabId).toBe(before.activeTabId);
			expect(after.activeFileTabId).toBe(before.activeFileTabId);
			expect(after.activeTerminalTabId).toBe(before.activeTerminalTabId);

			// Held on disk, keyed and named like the desktop's consult tab.
			const stored = readSessions().sessions[0].aiTabs.find(
				(t: { id: string }) => t.id === opened.tabId
			);
			expect(stored).toMatchObject({
				hidden: true,
				name: '↩ Beta',
				saveToHistory: false,
				consultOrigin: KEY,
				logs: [{ text: 'what do you think?', source: 'user' }],
			});
			expect(stored.hasUnread).toBeUndefined();
			expect(readSessions().sessions[0].unifiedTabOrder).toContainEqual({
				type: 'ai',
				id: opened.tabId,
			});
			expect(opened.resumeAgentSessionId).toBeUndefined();
		});

		it('reuses the tab for the same pairing and hands back the session to resume', async () => {
			const repo = await setup({ sessions: twoAgents() });
			const first = value(await repo.openConsultTab('a1', open('first')));
			value(
				await repo.recordConsultAnswer(
					'a1',
					first.tabId,
					answer('one', { agentSessionId: 'sess-1' })
				)
			);

			const second = value(await repo.openConsultTab('a1', open('second')));

			expect(second.tabId).toBe(first.tabId);
			expect(second.resumeAgentSessionId).toBe('sess-1');
			const tabs = readSessions().sessions[0].aiTabs;
			expect(tabs).toHaveLength(3);
			expect(
				tabs
					.find((t: { id: string }) => t.id === first.tabId)
					.logs.map((l: { text: string }) => l.text)
			).toEqual(['first', 'one', 'second']);
		});

		it('keeps a separate tab per asking tab', async () => {
			const repo = await setup({ sessions: twoAgents() });
			const one = value(await repo.openConsultTab('a1', open()));
			const other = value(
				await repo.openConsultTab('a1', {
					...open(),
					key: { sourceSessionId: 'a2', sourceTabId: 'a2-t2' },
				})
			);
			expect(other.tabId).not.toBe(one.tabId);
		});

		it('records the session id only for a consult that succeeded (B18)', async () => {
			const repo = await setup({ sessions: twoAgents() });
			const { tabId } = value(await repo.openConsultTab('a1', open()));

			value(await repo.recordConsultAnswer('a1', tabId, answer('it failed')));
			expect(repo.getTab('a1', tabId)?.agentSessionId ?? null).toBeNull();

			value(
				await repo.recordConsultAnswer('a1', tabId, answer('it worked', { agentSessionId: 's9' }))
			);
			expect(repo.getTab('a1', tabId)?.agentSessionId).toBe('s9');
		});

		it('never raises unread or a tab event when an answer lands', async () => {
			const repo = await setup({ sessions: twoAgents() });
			const { tabId } = value(await repo.openConsultTab('a1', open()));
			events.length = 0;

			value(await repo.recordConsultAnswer('a1', tabId, answer('done', { agentSessionId: 's1' })));

			expect(events.map((event) => event.type)).toEqual(['agent.updated']);
			expect(repo.getTab('a1', tabId)?.hasUnread).toBeUndefined();
			// The agent's visible tabs are exactly what they were.
			expect(repo.getAgent('a1')?.aiTabs?.filter((t) => t.hidden !== true)).toHaveLength(2);
			expect(repo.listTabs('a1')?.some((t) => t.hasUnread)).toBe(false);
		});

		it('answers not-found for an unknown agent or tab', async () => {
			const repo = await setup({ sessions: twoAgents() });
			expect(errorOf(await repo.openConsultTab('nobody', open())).code).toBe('not-found');
			expect(errorOf(await repo.recordConsultAnswer('a1', 'nope', answer('x'))).code).toBe(
				'not-found'
			);
		});

		it('refuses to write once fenced, like every other command', async () => {
			const repo = await setup({ sessions: twoAgents() });
			repo.fence('lost');
			expect(errorOf(await repo.openConsultTab('a1', open())).code).toBe('host-lost');
		});
	});

	it('drain resolves only after every accepted command has been written', async () => {
		const repo = await setup({ sessions: twoAgents() });
		const pending = [repo.renameAgent('a1', 'Gamma'), repo.createGroup({ name: 'late' })];
		await repo.drain();
		expect(readSessions().sessions[0].name).toBe('Gamma');
		expect(readGroups().groups).toHaveLength(1);
		await Promise.all(pending);
	});

	it('hands out projections, never the stored objects', async () => {
		const repo = await setup({ sessions: twoAgents() });
		const first = repo.getAgent('a1')!;
		expect(first.aiTabs?.every((t) => !('logs' in t))).toBe(true);
		(first as { name: string }).name = 'mutated by a caller';
		expect(repo.getAgent('a1')?.name).toBe('Alpha');
		expect(repo.getTab('a1', 'a1-t1')?.logs).toHaveLength(1);
	});
});

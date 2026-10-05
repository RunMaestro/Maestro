import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('../../../main/storage/session-image-store', () => ({
	relocateSessionImages: async (sessions: unknown[]) => ({ sessions, relocated: 0 }),
}));
vi.mock('../../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { DEFAULT_TAB_DEFAULTS } from '../../../shared/maestro-lib/agents/rules';
import { createMaestroRuntime, type MaestroRuntime } from '../../../shared/maestro-lib/runtime';
import {
	createDesktopBinding,
	type DesktopBinding,
	type DesktopRuntime,
} from '../../../main/library-runtime/desktop-binding';
import type { LibraryRuntimeEventMessage } from '../../../shared/libraryRuntime';

const T0 = Date.parse('2026-10-04T12:00:00Z');
const confText = (doc: unknown) => JSON.stringify(doc, null, '\t');

const seedAgent = (id: string, name: string) => ({
	id,
	name,
	toolType: 'claude-code',
	cwd: `/work/${id}`,
	projectRoot: `/work/${id}`,
	inputMode: 'ai',
	aiTabs: [{ id: `${id}-t1`, agentSessionId: null, name: null, starred: false, logs: [] }],
	activeTabId: `${id}-t1`,
	unifiedTabOrder: [{ type: 'ai', id: `${id}-t1` }],
});

describe('the desktop binding', () => {
	let dir: string;
	let runtime: MaestroRuntime;
	let binding: DesktopBinding;
	let seen: LibraryRuntimeEventMessage[];

	beforeEach(async () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-binding-test-'));
		fs.writeFileSync(
			path.join(dir, 'maestro-sessions.json'),
			confText({ sessions: [seedAgent('a1', 'Alpha')], activeSessionId: 'a1' })
		);
		let id = 0;
		let now = 1_000;
		const started = await createMaestroRuntime({
			dataDir: dir,
			mode: 'desktop',
			deps: {
				pid: 100,
				now: () => T0,
				bootTime: () => T0 - 3_600_000,
				isPidAlive: () => true,
				hostname: () => 'testhost',
				rules: { newId: () => `id-${++id}`, now: () => ++now, random: () => 0 },
				checkCwd: () => null,
				readTabDefaults: async () => DEFAULT_TAB_DEFAULTS,
				watchDirectory: () => ({ close: () => undefined }),
			},
		});
		if (!started.ok) throw new Error(started.refusal.message);
		runtime = started.runtime;
		binding = createDesktopBinding(runtime as DesktopRuntime);
		seen = [];
		binding.onEvent((message) => seen.push(message));
	});

	afterEach(async () => {
		binding.dispose();
		await runtime.connection.close();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('answers a command with the stamped events it caused, tagged with the command id', async () => {
		const answer = await binding.command({
			commandId: 'c-1',
			command: { method: 'agents.rename', agentId: 'a1', name: 'Renamed' },
		});
		expect(answer.result.ok).toBe(true);
		expect(answer.changes).toHaveLength(1);
		const [change] = answer.changes;
		expect(change.event).toMatchObject({
			type: 'agent.updated',
			agent: { id: 'a1', name: 'Renamed' },
		});
		expect(change.origin).toEqual({ commandId: 'c-1' });
		expect(change.rev).toBe((runtime as DesktopRuntime).desktop.revisionOf('a1'));
		expect(change.rev).toBeGreaterThan(0);
		expect(seen).toEqual(answer.changes);
	});

	it('stamps the revision after the commit and keeps two commands apart', async () => {
		const [first, second] = await Promise.all([
			binding.command({
				commandId: 'c-1',
				command: { method: 'agents.rename', agentId: 'a1', name: 'One' },
			}),
			binding.command({
				commandId: 'c-2',
				command: { method: 'agents.rename', agentId: 'a1', name: 'Two' },
			}),
		]);
		expect(first.changes.map((c) => c.origin?.commandId)).toEqual(['c-1']);
		expect(second.changes.map((c) => c.origin?.commandId)).toEqual(['c-2']);
		expect(second.changes[0].rev).toBe(first.changes[0].rev! + 1);
	});

	it('creates an agent with the client-chosen ids and a group with a client-chosen id', async () => {
		const created = await binding.command({
			commandId: 'c-3',
			command: {
				method: 'agents.create',
				input: {
					id: 'mine',
					tabId: 'mine-tab',
					name: 'Mine',
					provider: 'claude-code',
					cwd: '/work/mine',
				},
			},
		});
		expect(created.result).toMatchObject({ ok: true, value: { agentId: 'mine' } });
		const added = created.changes.find((c) => c.event.type === 'agent.added');
		expect(added?.event).toMatchObject({ agent: { id: 'mine', aiTabs: [{ id: 'mine-tab' }] } });

		const group = await binding.command({
			commandId: 'c-4',
			command: { method: 'groups.create', input: { id: 'group-mine', name: 'Team' } },
		});
		expect(group.result).toMatchObject({ ok: true, value: { groupId: 'group-mine' } });
		expect(group.changes[0].groupsRev).toBe((runtime as DesktopRuntime).desktop.groupsRevision());
	});

	it('reports a refused command as a failed result with no events', async () => {
		const answer = await binding.command({
			commandId: 'c-5',
			command: { method: 'agents.rename', agentId: 'missing', name: 'x' },
		});
		expect(answer.result).toMatchObject({ ok: false, error: { code: 'not-found' } });
		expect(answer.changes).toEqual([]);
	});

	it('runs a group update through the desktop api', async () => {
		await binding.command({
			commandId: 'c-6',
			command: { method: 'groups.create', input: { id: 'g1', name: 'Team' } },
		});
		const answer = await binding.command({
			commandId: 'c-7',
			command: { method: 'groups.update', groupId: 'g1', patch: { name: 'Squad' } },
		});
		expect(answer.result.ok).toBe(true);
		expect(answer.changes[0].event).toMatchObject({
			type: 'groups.changed',
			groups: [{ id: 'g1', name: 'SQUAD' }],
		});
	});

	it('marks the events of a fold, which no command caused', async () => {
		const rev = (runtime as DesktopRuntime).desktop.revisionOf('a1');
		const answer = await binding.writeSessions([
			{ ...seedAgent('a1', 'Alpha'), name: 'Folded', inputMode: 'terminal' },
		]);
		expect(answer.ok).toBe(true);
		const updated = seen.find((m) => m.event.type === 'agent.updated');
		expect(updated?.fromFold).toBe(true);
		expect(updated?.origin).toBeUndefined();
		expect(updated?.rev).toBe(rev + 1);
		const agent = (runtime as DesktopRuntime).desktop.snapshot().agents[0];
		expect(agent).toMatchObject({ name: 'Folded', inputMode: 'terminal' });
	});

	it('lands only desktop-owned keys from a legacy flush and drops its domain edits', async () => {
		const answer = await binding.foldLegacySessions([
			{ ...seedAgent('a1', 'Stale name'), inputMode: 'terminal' },
			seedAgent('a2', 'Adopted'),
		]);
		expect(answer.drift.map((d) => d.kind)).toContain('domain-dropped');
		const agents = (runtime as DesktopRuntime).desktop.snapshot().agents;
		expect(agents.find((a) => a.id === 'a1')).toMatchObject({
			name: 'Alpha',
			inputMode: 'terminal',
		});
		expect(agents.map((a) => a.id)).toEqual(['a1', 'a2']);
	});

	it('removes agents named by a legacy flush and tombstones them against resurrection', async () => {
		await binding.foldLegacySessions([], ['a1']);
		expect((runtime as DesktopRuntime).desktop.snapshot().agents).toEqual([]);
		const again = await binding.foldLegacySessions([seedAgent('a1', 'Alpha')]);
		expect(again.drift.map((d) => d.kind)).toContain('tombstoned-agent');
		expect((runtime as DesktopRuntime).desktop.snapshot().agents).toEqual([]);
	});

	it('writes collapsed from a legacy groups flush and sets the active agent', async () => {
		await binding.command({
			commandId: 'c-8',
			command: { method: 'groups.create', input: { id: 'g1', name: 'Team' } },
		});
		await binding.foldLegacyGroups([{ id: 'g1', collapsed: true }]);
		await binding.setActiveSessionId('a1');
		const { groups, sessions } = (runtime as DesktopRuntime).desktop.documents();
		expect((groups.groups as Array<{ collapsed?: boolean }>)[0].collapsed).toBe(true);
		expect(sessions.activeSessionId).toBe('a1');
	});

	describe('tab commands (Phase 9, task 4)', () => {
		const desktop = () => (runtime as DesktopRuntime).desktop;
		const tabsOf = () =>
			desktop()
				.snapshot()
				.agents[0].aiTabs?.map((tab) => tab.id);

		it('creates a tab under the client-chosen id, where the window put it', async () => {
			const answer = await binding.command({
				commandId: 'c-tab-1',
				command: {
					method: 'tabs.create',
					agentId: 'a1',
					options: { tabId: 'mine', placeAfter: null },
				},
			});
			expect(answer.result).toMatchObject({ ok: true, value: { tabId: 'mine' } });
			expect(answer.changes.map((c) => c.event.type)).toEqual(['tab.added', 'agent.updated']);
			expect(answer.changes.every((c) => c.origin?.commandId === 'c-tab-1')).toBe(true);
			expect(desktop().snapshot().agents[0].unifiedTabOrder?.[0]).toEqual({
				type: 'ai',
				id: 'mine',
			});
		});

		it('renames, stars, reorders, and closes through the repository', async () => {
			await binding.command({
				commandId: 'c1',
				command: { method: 'tabs.create', agentId: 'a1', options: { tabId: 'second' } },
			});
			const renamed = await binding.command({
				commandId: 'c2',
				command: { method: 'tabs.rename', agentId: 'a1', tabId: 'second', name: ' Docs ' },
			});
			expect(renamed.result.ok).toBe(true);
			const starred = await binding.command({
				commandId: 'c3',
				command: { method: 'tabs.star', agentId: 'a1', tabId: 'second', starred: true },
			});
			expect(starred.result.ok).toBe(true);
			expect(desktop().snapshot().agents[0].aiTabs?.[1]).toMatchObject({
				id: 'second',
				name: 'Docs',
				starred: true,
			});
			const moved = await binding.command({
				commandId: 'c4',
				command: {
					method: 'tabs.reorder',
					agentId: 'a1',
					ref: { type: 'ai', id: 'second' },
					toIndex: 0,
				},
			});
			expect(moved.result.ok).toBe(true);
			expect(desktop().snapshot().agents[0].unifiedTabOrder?.[0]).toEqual({
				type: 'ai',
				id: 'second',
			});
			const closed = await binding.command({
				commandId: 'c5',
				command: {
					method: 'tabs.close',
					agentId: 'a1',
					tabId: 'second',
					options: { busy: 'orphan' },
				},
			});
			expect(closed.result.ok).toBe(true);
			expect(tabsOf()).toEqual(['a1-t1']);
		});

		it('hands a refused command the agent as the runtime has it, so an optimistic window can snap back', async () => {
			const answer = await binding.command({
				commandId: 'c6',
				command: { method: 'tabs.rename', agentId: 'a1', tabId: 'ghost', name: 'x' },
			});
			expect(answer.result).toMatchObject({ ok: false, error: { code: 'not-found' } });
			expect(answer.changes).toEqual([]);
			expect(answer.authoritative).toMatchObject({
				agent: { id: 'a1', aiTabs: [{ id: 'a1-t1' }] },
				rev: desktop().revisionOf('a1'),
			});
		});

		it('leaves the authoritative agent out of a success, and out of a refusal that names no agent', async () => {
			const fine = await binding.command({
				commandId: 'c7',
				command: { method: 'tabs.create', agentId: 'a1' },
			});
			expect(fine.authoritative).toBeUndefined();
			const noAgent = await binding.command({
				commandId: 'c8',
				command: { method: 'groups.rename', groupId: 'nope', name: 'x' },
			});
			expect(noAgent.result.ok).toBe(false);
			expect(noAgent.authoritative).toBeUndefined();
		});

		it('waits for a listener that returns a promise before it answers', async () => {
			let release!: () => void;
			let finished = false;
			binding.onEvent((message) => {
				if (message.event.type !== 'agent.updated') return;
				return new Promise<void>((resolve) => {
					release = () => {
						finished = true;
						resolve();
					};
				});
			});
			let answered = false;
			const pending = binding
				.command({
					commandId: 'c9',
					command: { method: 'tabs.rename', agentId: 'a1', tabId: 'a1-t1', name: 'Named' },
				})
				.then((answer) => {
					answered = true;
					return answer;
				});
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(answered).toBe(false);
			release();
			const answer = await pending;
			expect(finished).toBe(true);
			expect(answer.result.ok).toBe(true);
		});

		it('still answers when a listener rejects', async () => {
			binding.onEvent(() => Promise.reject(new Error('side effect failed')));
			const answer = await binding.command({
				commandId: 'c10',
				command: { method: 'tabs.rename', agentId: 'a1', tabId: 'a1-t1', name: 'Named' },
			});
			expect(answer.result.ok).toBe(true);
		});
	});

	it('a snapshot carries records, revisions, and the active agent', async () => {
		const snapshot = await binding.loadSnapshot();
		expect(snapshot.agents.map((a) => a.id)).toEqual(['a1']);
		expect(snapshot.activeSessionId).toBe('a1');
		expect(snapshot.revs).toHaveProperty('a1');
	});
});

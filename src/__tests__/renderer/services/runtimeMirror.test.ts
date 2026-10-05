import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../renderer/stores/notificationStore', async () => {
	const actual = await vi.importActual('../../../renderer/stores/notificationStore');
	return { ...actual, notifyToast: vi.fn() };
});

let idCounter = 0;
vi.mock('../../../renderer/utils/ids', () => ({ generateId: () => `cmd-${++idCounter}` }));

vi.mock('../../../renderer/services/libraryRuntime', () => ({
	isLibraryRuntimeHosting: vi.fn(() => true),
	loadLibraryRuntimeStatus: vi.fn(async () => ({ hosting: true })),
}));

import {
	applyRuntimeMessage,
	buildGroupsFold,
	buildRuntimeFold,
	isRuntimeFenced,
	markRuntimeMirrorLoaded,
	persistGroupsToRuntime,
	resetRuntimeMirror,
	runtimeKnowsAgent,
	runtimeRevisionOf,
	sendRuntimeCommand,
	sendRuntimeFold,
	seedRuntimeMirror,
	setRuntimeMirrorHost,
	startRuntimeEventStream,
} from '../../../renderer/services/runtimeMirror';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { notifyToast } from '../../../renderer/stores/notificationStore';
import type { DesktopSnapshot } from '../../../shared/maestro-lib/agents/desktop-fold-types';
import type { LibraryRuntimeEventMessage } from '../../../shared/libraryRuntime';
import type { Group, Session } from '../../../renderer/types';

const tabRecord = (id: string, extra: Record<string, unknown> = {}) => ({
	id,
	name: null,
	starred: false,
	agentSessionId: null,
	...extra,
});

const agentRecord = (id: string, extra: Record<string, unknown> = {}) =>
	({
		id,
		name: id.toUpperCase(),
		toolType: 'claude-code',
		cwd: `/work/${id}`,
		fullPath: `/work/${id}`,
		projectRoot: `/work/${id}`,
		activeTabId: `${id}-t1`,
		aiTabs: [tabRecord(`${id}-t1`)],
		unifiedTabOrder: [{ type: 'ai', id: `${id}-t1` }],
		...extra,
	}) as any;

const session = (id: string, extra: Record<string, unknown> = {}): Session =>
	({
		...agentRecord(id),
		state: 'idle',
		inputMode: 'ai',
		aiTabs: [
			{ ...tabRecord(`${id}-t1`), logs: [], inputValue: '', stagedImages: [], state: 'idle' },
		],
		...extra,
	}) as unknown as Session;

const group = (id: string, extra: Record<string, unknown> = {}): Group =>
	({ id, name: id.toUpperCase(), emoji: 'F', collapsed: false, ...extra }) as unknown as Group;

const snapshotOf = (
	agents: any[],
	groups: Group[] = [],
	revs: Record<string, number> = {}
): DesktopSnapshot => ({
	agents,
	groups: groups as any,
	activeSessionId: agents[0]?.id ?? '',
	revs: Object.fromEntries(agents.map((a) => [a.id, revs[a.id] ?? 1])),
	groupsRev: 1,
});

const message = (
	event: LibraryRuntimeEventMessage['event'],
	extra: Partial<LibraryRuntimeEventMessage> = {}
): LibraryRuntimeEventMessage => ({ event, ...extra });

const store = () => useSessionStore.getState();

describe('the runtime mirror', () => {
	let command: ReturnType<typeof vi.fn>;
	let fold: ReturnType<typeof vi.fn>;
	let onEvent: ReturnType<typeof vi.fn>;
	const restoreSession = vi.fn(async (s: Session) => s);

	beforeEach(() => {
		resetRuntimeMirror();
		idCounter = 0;
		command = vi.fn(async () => ({ result: { ok: true, value: undefined }, changes: [] }));
		fold = vi.fn(async () => ({ ok: true, revs: {}, groupsRev: 1, drift: [] }));
		onEvent = vi.fn(() => () => undefined);
		(window as any).maestro = {
			libraryRuntime: { command, fold, onEvent },
			sessions: {
				getDeferredContent: vi.fn().mockRejectedValue(new Error('none')),
				setActiveSessionId: vi.fn(),
			},
		};
		restoreSession.mockClear();
		setRuntimeMirrorHost({ restoreSession });
		vi.mocked(notifyToast).mockClear();
		store().setSessions([]);
		store().setGroups([]);
	});

	afterEach(() => {
		resetRuntimeMirror();
		(window as any).maestro = {};
	});

	function seed(agents: any[], groups: Group[] = [], revs: Record<string, number> = {}) {
		seedRuntimeMirror(snapshotOf(agents, groups, revs));
		store().setSessions(agents.map((a) => session(a.id)));
		store().setGroups(groups);
		markRuntimeMirrorLoaded();
	}

	describe('events', () => {
		it('waits for the snapshot to be marked loaded, then applies what arrived meanwhile in order', async () => {
			seedRuntimeMirror(snapshotOf([agentRecord('a1')]));
			store().setSessions([session('a1')]);
			await applyRuntimeMessage(
				message({ type: 'agent.updated', agent: agentRecord('a1', { name: 'Early' }) }, { rev: 2 })
			);
			expect(store().sessions[0].name).toBe('A1');
			markRuntimeMirrorLoaded();
			await vi.waitFor(() => expect(store().sessions[0].name).toBe('Early'));
		});

		it('applies an agent.updated to the held agent and records the revision', async () => {
			seed([agentRecord('a1')]);
			await applyRuntimeMessage(
				message(
					{ type: 'agent.updated', agent: agentRecord('a1', { name: 'Renamed' }) },
					{ rev: 2 }
				)
			);
			expect(store().sessions[0].name).toBe('Renamed');
			expect(runtimeRevisionOf('a1')).toBe(2);
		});

		it('skips an event at or below the revision it already holds', async () => {
			seed([agentRecord('a1')], [], { a1: 5 });
			await applyRuntimeMessage(
				message({ type: 'agent.updated', agent: agentRecord('a1', { name: 'Old' }) }, { rev: 5 })
			);
			await applyRuntimeMessage(
				message({ type: 'agent.updated', agent: agentRecord('a1', { name: 'Older' }) }, { rev: 4 })
			);
			expect(store().sessions[0].name).toBe('A1');
		});

		it('does not touch the session object when the record changes nothing', async () => {
			seed([agentRecord('a1')]);
			const before = store().sessions[0];
			await applyRuntimeMessage(
				message({ type: 'agent.updated', agent: agentRecord('a1') }, { rev: 2 })
			);
			expect(store().sessions[0]).toBe(before);
		});

		it('builds a session for an agent this window never held, through restoreSession', async () => {
			seed([agentRecord('a1')]);
			await applyRuntimeMessage(
				message({ type: 'agent.added', agent: agentRecord('b2') }, { rev: 1 })
			);
			expect(restoreSession).toHaveBeenCalledTimes(1);
			expect(store().sessions.map((s) => s.id)).toEqual(['a1', 'b2']);
			expect(store().sessions[1].aiTabs[0]).toMatchObject({ logs: [], inputValue: '' });
			expect(runtimeKnowsAgent('b2')).toBe(true);
		});

		it('reads the stored transcript of each tab of an agent that arrives', async () => {
			seed([agentRecord('a1')]);
			(window as any).maestro.sessions.getDeferredContent = vi
				.fn()
				.mockResolvedValue({ logs: [{ id: 'l1', text: 'hello' }] });
			await applyRuntimeMessage(
				message({ type: 'agent.added', agent: agentRecord('b2') }, { rev: 1 })
			);
			expect(store().sessions[1].aiTabs[0].logs).toEqual([{ id: 'l1', text: 'hello' }]);
		});

		it('removes an agent, re-points the active agent, and ignores a late event for it', async () => {
			seed([agentRecord('a1'), agentRecord('a2')]);
			store().setActiveSessionId('a1');
			await applyRuntimeMessage(message({ type: 'agent.removed', agentId: 'a1' }));
			expect(store().sessions.map((s) => s.id)).toEqual(['a2']);
			expect(store().activeSessionId).toBe('a2');
			expect(runtimeKnowsAgent('a1')).toBe(false);
			await applyRuntimeMessage(
				message({ type: 'agent.updated', agent: agentRecord('a1') }, { rev: 9 })
			);
			expect(store().sessions.map((s) => s.id)).toEqual(['a2']);
		});

		it('ignores tab events: an agent.updated that carries the whole agent follows each', async () => {
			seed([agentRecord('a1')]);
			const before = store().sessions;
			await applyRuntimeMessage(
				message({ type: 'tab.added', agentId: 'a1', tab: tabRecord('x') as any })
			);
			expect(store().sessions).toBe(before);
		});

		it('raises one sticky error when the host is lost, and refuses commands and folds after', async () => {
			seed([agentRecord('a1')]);
			await applyRuntimeMessage(
				message({ type: 'host.lost', reason: 'Another Maestro took over.' })
			);
			await applyRuntimeMessage(message({ type: 'host.lost', reason: 'again' }));
			expect(isRuntimeFenced()).toBe(true);
			expect(notifyToast).toHaveBeenCalledTimes(1);
			expect(notifyToast).toHaveBeenCalledWith(expect.objectContaining({ dismissible: true }));
			const answer = await sendRuntimeCommand({ method: 'agents.remove', agentId: 'a1' });
			expect(answer.result).toMatchObject({ ok: false, error: { code: 'host-lost' } });
			expect(command).not.toHaveBeenCalled();
			await expect(sendRuntimeFold({ agents: [] })).rejects.toThrow(/lost/);
		});
	});

	describe('groups', () => {
		it('takes the runtime domain keys, keeps the local collapsed state, and keeps a group only this window holds', async () => {
			// `mine` was made here and never folded: the runtime's list does not have it.
			seedRuntimeMirror(snapshotOf([], [group('g1')]));
			store().setGroups([group('g1', { collapsed: true }), group('mine')]);
			markRuntimeMirrorLoaded();
			await applyRuntimeMessage(
				message(
					{
						type: 'groups.changed',
						groups: [group('g1', { name: 'RENAMED', icon: 'star' }), group('g2')] as any,
					},
					{ groupsRev: 2 }
				)
			);
			const groups = store().groups;
			expect(groups.map((g) => g.id)).toEqual(['g1', 'g2', 'mine']);
			expect(groups[0]).toMatchObject({ name: 'RENAMED', icon: 'star', collapsed: true });
			expect(groups[1].collapsed).toBe(false);
		});

		it('drops a group the runtime knew and no longer holds', async () => {
			seed([], [group('g1'), group('g2')]);
			await applyRuntimeMessage(
				message({ type: 'groups.changed', groups: [group('g1')] as any }, { groupsRev: 2 })
			);
			expect(store().groups.map((g) => g.id)).toEqual(['g1']);
		});

		it('clears an icon the runtime no longer carries', async () => {
			seed([], [group('g1', { icon: 'star', color: '#fff' })]);
			await applyRuntimeMessage(
				message({ type: 'groups.changed', groups: [group('g1')] as any }, { groupsRev: 2 })
			);
			expect(store().groups[0]).not.toHaveProperty('icon');
			expect(store().groups[0]).not.toHaveProperty('color');
		});

		it('skips a stale groups revision', async () => {
			seed([], [group('g1')]);
			await applyRuntimeMessage(
				message(
					{ type: 'groups.changed', groups: [group('g1', { name: 'STALE' })] as any },
					{ groupsRev: 1 }
				)
			);
			expect(store().groups[0].name).toBe('G1');
		});
	});

	describe('commands', () => {
		it("applies the answer's changes at once and tags the request with a command id", async () => {
			seed([agentRecord('a1')]);
			command.mockResolvedValue({
				result: { ok: true, value: undefined },
				changes: [
					message(
						{ type: 'agent.updated', agent: agentRecord('a1', { name: 'Two' }) },
						{ rev: 2, origin: { commandId: 'cmd-1' } }
					),
				],
			});
			const answer = await sendRuntimeCommand(
				{ method: 'agents.rename', agentId: 'a1', name: 'Two' },
				{ agentIds: ['a1'] }
			);
			expect(answer.result.ok).toBe(true);
			expect(command).toHaveBeenCalledWith({
				commandId: 'cmd-1',
				command: { method: 'agents.rename', agentId: 'a1', name: 'Two' },
			});
			expect(store().sessions[0].name).toBe('Two');
		});

		it('holds a broadcast event for an agent with a command in flight and applies the newest afterwards', async () => {
			seed([agentRecord('a1')]);
			let answer!: (value: unknown) => void;
			command.mockReturnValue(new Promise((resolve) => (answer = resolve)));
			const pending = sendRuntimeCommand(
				{ method: 'agents.rename', agentId: 'a1', name: 'Two' },
				{ agentIds: ['a1'] }
			);
			// Two broadcasts arrive before the answer: neither shows, the newer waits.
			await applyRuntimeMessage(
				message(
					{ type: 'agent.updated', agent: agentRecord('a1', { name: 'One-ish' }) },
					{ rev: 2 }
				)
			);
			await applyRuntimeMessage(
				message({ type: 'agent.updated', agent: agentRecord('a1', { name: 'Three' }) }, { rev: 3 })
			);
			expect(store().sessions[0].name).toBe('A1');
			answer({ result: { ok: true, value: undefined }, changes: [] });
			await pending;
			await vi.waitFor(() => expect(store().sessions[0].name).toBe('Three'));
		});

		it('does not let a held event undo a newer answer', async () => {
			seed([agentRecord('a1')]);
			command.mockImplementation(async () => {
				// The broadcast of the first change arrives while the command is in flight.
				await applyRuntimeMessage(
					message({ type: 'agent.updated', agent: agentRecord('a1', { name: 'Old' }) }, { rev: 2 })
				);
				return {
					result: { ok: true, value: undefined },
					changes: [
						message(
							{ type: 'agent.updated', agent: agentRecord('a1', { name: 'New' }) },
							{ rev: 3 }
						),
					],
				};
			});
			await sendRuntimeCommand(
				{ method: 'agents.rename', agentId: 'a1', name: 'New' },
				{ agentIds: ['a1'] }
			);
			await vi.waitFor(() => expect(store().sessions[0].name).toBe('New'));
			expect(runtimeRevisionOf('a1')).toBe(3);
		});

		it('adds the agent a create command makes as the rich local copy, with the runtime domain keys on it', async () => {
			seed([agentRecord('a1')]);
			const rich = session('new', { fileExplorerScrollPos: 5, name: 'typed' });
			command.mockResolvedValue({
				result: { ok: true, value: { agentId: 'new' } },
				changes: [
					message(
						{ type: 'agent.added', agent: agentRecord('new', { name: 'Normalized' }) },
						{ rev: 1 }
					),
				],
			});
			await sendRuntimeCommand(
				{
					method: 'agents.create',
					input: { id: 'new', name: 'typed', provider: 'claude-code', cwd: '/w' },
				},
				{ agentIds: ['new'], creating: rich }
			);
			const added = store().sessions.find((s) => s.id === 'new')!;
			expect(added.name).toBe('Normalized');
			expect((added as any).fileExplorerScrollPos).toBe(5);
			expect(restoreSession).not.toHaveBeenCalled();
		});
	});

	describe('the fold', () => {
		it('adopts an agent the runtime never told this window about and names baseRev for the rest', () => {
			seed([agentRecord('a1')], [], { a1: 4 });
			const built = buildRuntimeFold({ sessions: [session('a1'), session('fresh')] });
			expect(built.agents).toHaveLength(1);
			expect(built.agents[0]).toMatchObject({ id: 'a1', baseRev: 4, provider: 'claude-code' });
			expect(built.adoptAgents?.map((a) => a.id)).toEqual(['fresh']);
		});

		it('carries a local domain edit as drift-checked domain, and not an unchanged key', () => {
			seed([agentRecord('a1')], [], { a1: 4 });
			const built = buildRuntimeFold({ sessions: [session('a1', { nudgeMessage: 'hi' })] });
			expect(built.agents[0].domain).toEqual({ nudgeMessage: 'hi' });
		});

		it('removes only agents the runtime still holds', () => {
			seed([agentRecord('a1')]);
			expect(
				buildRuntimeFold({ sessions: [], removedIds: ['a1', 'never-known'] }).removeAgents
			).toEqual(['a1']);
		});

		it('leaves out the turn state of an agent this window does not own', () => {
			seed([agentRecord('a1')]);
			const built = buildRuntimeFold({
				sessions: [session('a1', { state: 'busy' })],
				ownsAgent: () => false,
			});
			expect(built.agents[0].fields).not.toHaveProperty('state');
		});

		it('skips an agent the runtime reported removed', async () => {
			seed([agentRecord('a1')]);
			await applyRuntimeMessage(message({ type: 'agent.removed', agentId: 'a1' }));
			const built = buildRuntimeFold({ sessions: [session('a1')] });
			expect(built.agents).toEqual([]);
			expect(built.adoptAgents).toBeUndefined();
		});

		it('sends the fold, forgets a removal it carried, and throws when the runtime refuses', async () => {
			seed([agentRecord('a1')]);
			await sendRuntimeFold({ agents: [], removeAgents: ['a1'] });
			expect(fold).toHaveBeenCalledWith({ agents: [], removeAgents: ['a1'] });
			expect(runtimeKnowsAgent('a1')).toBe(false);
			fold.mockResolvedValue({ ok: false, revs: {}, groupsRev: 0, drift: [] });
			await expect(sendRuntimeFold({ agents: [] })).rejects.toThrow();
		});

		it('builds the groups part: collapsed always, the list only when it differs, and removals', () => {
			seed([], [group('g1'), group('g2')]);
			const same = buildGroupsFold([group('g1', { collapsed: true }), group('g2')]);
			expect(same).toEqual({ baseRev: 1, collapsed: { g1: true, g2: false } });
			const edited = buildGroupsFold([group('g1', { name: 'NEW' })]);
			expect(edited.baseRev).toBe(1);
			expect(edited.domain).toHaveLength(1);
			expect(edited.removeGroups).toEqual(['g2']);
		});

		it('persists the groups alone through the fold', async () => {
			seed([], [group('g1')]);
			await persistGroupsToRuntime([group('g1', { collapsed: true })]);
			expect(fold).toHaveBeenCalledWith({
				agents: [],
				groups: { baseRev: 1, collapsed: { g1: true } },
			});
		});
	});

	it('subscribes to the runtime events and applies each', async () => {
		seed([agentRecord('a1')]);
		const stop = startRuntimeEventStream();
		expect(onEvent).toHaveBeenCalledTimes(1);
		const listener = onEvent.mock.calls[0][0];
		listener(
			message({ type: 'agent.updated', agent: agentRecord('a1', { name: 'Streamed' }) }, { rev: 2 })
		);
		await vi.waitFor(() => expect(store().sessions[0].name).toBe('Streamed'));
		expect(stop).toBeTypeOf('function');
	});
});

/**
 * Moving a hosted agent back from its host (`runReturnFromHost()`, `withReturnedFromHost()`): the
 * refusals, the host read, the merge by tab id, the host copy's removal, and the offline path.
 * `maestro-cli unlift` and the desktop's Move Back from Host both run these.
 */
import { describe, expect, it, vi } from 'vitest';

import type { AgentRecord, AITabRecord } from '../../store/records';
import { LiftRunError } from '../lift-run';
import {
	hostDraftsNotKept,
	readReturnedFromHost,
	RETURN_TRANSCRIPT_RETRY_TIMEOUT_MS,
	returnRestoreRefusal,
	runReturnFromHost,
	withReturnedFromHost,
	type ReturnRunDeps,
} from '../lift-return';

const ok = <T>(value: T) => ({ ok: true as const, value });
const fail = (code: string, message = 'nope') => ({
	ok: false as const,
	error: { code, message, method: 'agents.get' },
});

const log = (id: string, timestamp = 1) => ({ id, timestamp, source: 'user', text: id });
const NOW = 5_000;
/** The marker a restore writes for the host copy still to remove. */
const copyLeft = (fetched: boolean, carried?: string[]) => ({
	peer: 'build-box',
	agentId: 'host-1',
	at: 1,
	fetched,
	returnedAt: NOW,
	...(carried ? { carried } : {}),
});

function hostedAgent(overrides: Partial<AgentRecord> = {}): AgentRecord {
	return {
		id: 'agent-1',
		name: 'Docs',
		toolType: 'claude-code',
		cwd: '/home/me/docs',
		sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
		liftedTo: { peer: 'build-box', agentId: 'host-1', at: 1 },
		activeTabId: 'tab-1',
		unifiedTabOrder: [{ type: 'ai', id: 'tab-1' }],
		aiTabs: [
			{ id: 'tab-1', name: 'Main', agentSessionId: 'sess-1', logs: [log('l1')] },
			{ id: 'tab-old', name: 'Closed on host', logs: [log('o1')] },
		],
		...overrides,
	} as AgentRecord;
}

function hostClient(
	overrides: {
		agent?: unknown;
		queue?: unknown;
		tabs?: AITabRecord[];
		transcripts?: Record<string, unknown[]>;
		remove?: unknown;
		setPaused?: unknown;
	} = {}
) {
	const tabs = overrides.tabs ?? [
		{ id: 'tab-1', name: 'Main', agentSessionId: 'sess-1', starred: true },
		{ id: 'tab-new', name: 'Started on host', agentSessionId: 'sess-2', state: 'idle' },
	];
	const transcripts = overrides.transcripts ?? {
		'tab-1': [log('l1'), log('l2')],
		'tab-new': [log('n1')],
	};
	return {
		agents: {
			get: vi
				.fn()
				.mockResolvedValue(
					overrides.agent ?? ok({ id: 'host-1', activeTabId: 'tab-new', aiTabs: tabs })
				),
			remove: vi.fn().mockResolvedValue(overrides.remove ?? ok(undefined)),
		},
		tabs: {
			list: vi.fn().mockResolvedValue(ok(tabs)),
			transcript: vi.fn(async (_agentId: string, tabId: string) => ok(transcripts[tabId] ?? [])),
		},
		turns: {
			queue: {
				list: vi.fn().mockResolvedValue(overrides.queue ?? ok([])),
				setPaused: vi.fn(
					async (_agentId: string, _itemId: string, paused: boolean) =>
						overrides.setPaused ?? ok({ found: true, paused })
				),
				remove: vi.fn().mockResolvedValue(ok({ removed: true })),
			},
		},
	};
}

function deps(agent: AgentRecord, client = hostClient()) {
	const release = vi.fn().mockResolvedValue(undefined);
	const restore = vi.fn().mockResolvedValue(undefined);
	const connect = vi.fn().mockResolvedValue({ peer: 'build-box', client, release });
	const value: ReturnRunDeps = {
		readAgents: () => [agent],
		connect,
		restore,
		now: () => NOW,
	};
	return { value, client, connect, restore, release };
}

describe('withReturnedFromHost', () => {
	it('drops the pointer, opts out of automatic moves, and merges the host tabs by id', () => {
		const record = hostedAgent() as unknown as Record<string, unknown>;
		const merged = withReturnedFromHost(record, {
			tabs: [
				{
					id: 'tab-1',
					name: 'Renamed',
					agentSessionId: 'sess-1',
					starred: true,
					logs: [log('l1'), log('l2')],
				},
				{ id: 'tab-new', agentSessionId: 'sess-2', state: 'busy', logs: [log('n1')] },
			],
			activeTabId: 'tab-new',
		});
		expect(merged.liftedTo).toBeUndefined();
		expect(merged.hostedOptOut).toBe(true);
		const tabs = merged.aiTabs as AITabRecord[];
		expect(tabs.map((tab) => tab.id)).toEqual(['tab-1', 'tab-old', 'tab-new']);
		expect(tabs[0]).toMatchObject({ name: 'Renamed', starred: true, logs: [log('l1'), log('l2')] });
		// A tab the host closed stays here.
		expect(tabs[1].logs).toEqual([log('o1')]);
		// A new tab arrives idle, with the fields a local tab needs.
		expect(tabs[2]).toMatchObject({
			agentSessionId: 'sess-2',
			name: null,
			starred: false,
			state: 'idle',
			inputValue: '',
			stagedImages: [],
		});
		expect(merged.unifiedTabOrder).toEqual([
			{ type: 'ai', id: 'tab-1' },
			{ type: 'ai', id: 'tab-new' },
		]);
		expect(merged.activeTabId).toBe('tab-new');
	});

	it('brings the host draft and staged images into a tab that has none here, and never overwrites a local draft (R2)', () => {
		const record = hostedAgent({
			aiTabs: [
				{ id: 'tab-1', name: 'Main', logs: [], inputValue: '', stagedImages: [] },
				{
					id: 'tab-old',
					name: 'Mine',
					logs: [],
					inputValue: 'typed here',
					stagedImages: ['img-a'],
				},
			],
		}) as unknown as Record<string, unknown>;
		const returned = {
			tabs: [
				{ id: 'tab-1', logs: [], inputValue: 'typed on host', stagedImages: ['img-h'] },
				{ id: 'tab-old', logs: [], inputValue: 'host draft', stagedImages: ['img-a', 'img-b'] },
			],
		};
		const tabs = withReturnedFromHost(record, returned).aiTabs as AITabRecord[];
		expect(tabs[0]).toMatchObject({ inputValue: 'typed on host', stagedImages: ['img-h'] });
		// The local draft stays; every image of both sides is kept, each once.
		expect(tabs[1]).toMatchObject({ inputValue: 'typed here', stagedImages: ['img-a', 'img-b'] });
		// The host draft that was not put in a tab is named, with its text.
		expect(hostDraftsNotKept((record as unknown as AgentRecord).aiTabs ?? [], returned)).toEqual([
			{ tabId: 'tab-old', tabName: 'Mine', draft: 'host draft' },
		]);
	});

	it('on an agent already home, keeps the tab running here and every row of both sides', () => {
		const record = {
			...hostedAgent(),
			liftedTo: undefined,
			hostCopyLeft: copyLeft(false),
			aiTabs: [{ id: 'tab-1', state: 'busy', logs: [log('l1'), log('m2', 3)] }],
		} as unknown as Record<string, unknown>;
		const merged = withReturnedFromHost(record, {
			tabs: [{ id: 'tab-1', logs: [log('l1'), log('h2', 2)] }],
		});
		const tab = (merged.aiTabs as AITabRecord[])[0];
		expect(tab.state).toBe('busy');
		expect(tab.logs).toEqual([log('l1'), log('h2', 2), log('m2', 3)]);
		expect(merged.hostCopyLeft).toBeUndefined();
	});

	it('on an agent already home, a tab keeps its own provider session and the active tab stays', () => {
		const record = {
			...hostedAgent(),
			liftedTo: undefined,
			hostCopyLeft: copyLeft(false),
			activeTabId: 'tab-1',
			aiTabs: [
				{ id: 'tab-1', agentSessionId: 'sess-here', logs: [] },
				{ id: 'tab-2', agentSessionId: null, logs: [] },
			],
		} as unknown as Record<string, unknown>;
		const merged = withReturnedFromHost(record, {
			activeTabId: 'tab-2',
			tabs: [
				{ id: 'tab-1', agentSessionId: 'sess-host', logs: [] },
				{ id: 'tab-2', agentSessionId: 'sess-host-2', logs: [] },
			],
		});
		const tabs = merged.aiTabs as AITabRecord[];
		expect(tabs.map((tab) => tab.agentSessionId)).toEqual(['sess-here', 'sess-host-2']);
		expect(merged.activeTabId).toBe('tab-1');
	});

	it('keeps every row of both sides when rows have no id, each one once', () => {
		const record = hostedAgent({
			aiTabs: [
				{
					id: 'tab-1',
					logs: [
						{ text: 'a', timestamp: 1 },
						{ text: 'b', timestamp: 3 },
					],
				},
				{ id: 'tab-old', logs: [{ text: 'x' }] },
			],
		}) as unknown as Record<string, unknown>;
		const merged = withReturnedFromHost(record, {
			tabs: [
				{
					id: 'tab-1',
					logs: [
						{ timestamp: 1, text: 'a' },
						{ text: 'h', timestamp: 2 },
					],
				},
				{ id: 'tab-old', logs: [{ text: 'y' }] },
			],
		});
		const tabs = merged.aiTabs as AITabRecord[];
		// Matched by content (key order does not matter), in time order.
		expect(tabs[0].logs).toEqual([
			{ timestamp: 1, text: 'a' },
			{ text: 'h', timestamp: 2 },
			{ text: 'b', timestamp: 3 },
		]);
		// Rows with no time: the host's, then this machine's.
		expect(tabs[1].logs).toEqual([{ text: 'y' }, { text: 'x' }]);
	});

	it('finishing a host copy keeps a local rename and star, and does not bring back a tab closed here since', () => {
		const record = {
			...hostedAgent(),
			liftedTo: undefined,
			hostCopyLeft: { ...copyLeft(false), homeTabIds: ['tab-1', 'tab-closed'] },
			unifiedTabOrder: [{ type: 'ai', id: 'tab-1' }],
			aiTabs: [{ id: 'tab-1', name: 'Mine', starred: false, logs: [] }],
		} as unknown as Record<string, unknown>;
		const merged = withReturnedFromHost(record, {
			tabs: [
				{ id: 'tab-1', name: 'Host name', starred: true, logs: [] },
				{ id: 'tab-closed', name: 'Closed here', logs: [log('c1')] },
				{ id: 'tab-host-new', logs: [log('n1')] },
			],
			hostCopyLeft: copyLeft(true),
		});
		const tabs = merged.aiTabs as AITabRecord[];
		expect(tabs.map((tab) => tab.id)).toEqual(['tab-1', 'tab-host-new']);
		expect(tabs[0]).toMatchObject({ name: 'Mine', starred: false });
		expect(merged.unifiedTabOrder).toEqual([
			{ type: 'ai', id: 'tab-1' },
			{ type: 'ai', id: 'tab-host-new' },
		]);
		// The tabs that were home stay named, so a later pass does not bring the closed one back either.
		expect(merged.hostCopyLeft).toEqual({
			...copyLeft(true),
			homeTabIds: ['tab-1', 'tab-closed', 'tab-host-new'],
		});
	});

	it('keeps a local transcript the host has less of', () => {
		const record = hostedAgent() as unknown as Record<string, unknown>;
		const merged = withReturnedFromHost(record, { tabs: [{ id: 'tab-1', logs: [] }] });
		expect((merged.aiTabs as AITabRecord[])[0].logs).toEqual([log('l1')]);
		expect(merged.activeTabId).toBe('tab-1');
	});

	it('when both sides went on, keeps every row of both, and one entry stored under two ids once', () => {
		// The same turn under another id on the host (a headless host's transcript read), then a
		// turn each side took while the agent was away: neither side holds the other.
		const shared = { id: 'local-a', timestamp: 1, source: 'user', text: 'start' };
		const record = hostedAgent({
			aiTabs: [{ id: 'tab-1', logs: [shared, log('local-turn', 3)] }],
		} as unknown as Partial<AgentRecord>) as unknown as Record<string, unknown>;
		const merged = withReturnedFromHost(record, {
			tabs: [{ id: 'tab-1', logs: [{ ...shared, id: 'host-a' }, log('host-turn', 2)] }],
		});
		expect(
			((merged.aiTabs as AITabRecord[])[0].logs ?? []).map((row) => (row as { id: string }).id)
		).toEqual(['host-a', 'host-turn', 'local-turn']);
	});

	it('keeps the local transcript whose reply streamed further, though both count the same turns and rows (#2195)', () => {
		const ask = { id: 'u1', timestamp: 1, source: 'user', text: 'explain' };
		const reply = { id: 'r1', timestamp: 2, source: 'ai', text: 'The answer is' };
		const finished = { ...reply, text: 'The answer is 42, because of the tests.' };
		const record = hostedAgent({
			aiTabs: [{ id: 'tab-1', logs: [ask, finished] }],
		} as unknown as Partial<AgentRecord>) as unknown as Record<string, unknown>;
		const merged = withReturnedFromHost(record, { tabs: [{ id: 'tab-1', logs: [ask, reply] }] });
		expect((merged.aiTabs as AITabRecord[])[0].logs).toEqual([ask, finished]);
		// The same the other way round: the host's further reply wins.
		const back = withReturnedFromHost(
			hostedAgent({
				aiTabs: [{ id: 'tab-1', logs: [ask, reply] }],
			} as unknown as Partial<AgentRecord>) as unknown as Record<string, unknown>,
			{ tabs: [{ id: 'tab-1', logs: [ask, finished] }] }
		);
		expect((back.aiTabs as AITabRecord[])[0].logs).toEqual([ask, finished]);
	});

	it('when one side holds the other, keeps that side as it was (no reordering, no merge)', () => {
		const record = hostedAgent({
			aiTabs: [{ id: 'tab-1', logs: [log('a', 1)] }],
		} as unknown as Partial<AgentRecord>) as unknown as Record<string, unknown>;
		const hostLogs = [log('a', 1), log('b', 9), log('c', 5)];
		const merged = withReturnedFromHost(record, { tabs: [{ id: 'tab-1', logs: hostLogs }] });
		expect((merged.aiTabs as AITabRecord[])[0].logs).toEqual(hostLogs);
	});
});

describe('the host copy a move back leaves (T5)', () => {
	it('is recorded on the agent, and cleared by a move back that leaves none', () => {
		const left = { peer: 'build-box', agentId: 'host-1', at: 1 };
		const kept = withReturnedFromHost(hostedAgent(), { tabs: [], leftOnHost: left });
		expect(kept.leftOnHost).toEqual(left);
		expect(withReturnedFromHost(kept, { tabs: [] }).leftOnHost).toBeUndefined();
	});
});

describe('readReturnedFromHost and returnRestoreRefusal', () => {
	it('reads a well-formed value and refuses a malformed one', () => {
		expect(readReturnedFromHost({ tabs: [{ id: 't1' }], activeTabId: 't1' })).toEqual({
			tabs: [{ id: 't1' }],
			activeTabId: 't1',
		});
		// T5: the host copy a move back left, checked like a pointer; a malformed one is dropped.
		expect(
			readReturnedFromHost({ tabs: [], leftOnHost: { peer: 'box', agentId: 'h1', at: 2 } })
		).toEqual({ tabs: [], leftOnHost: { peer: 'box', agentId: 'h1', at: 2 } });
		expect(readReturnedFromHost({ tabs: [], leftOnHost: { peer: 'box' } })).toEqual({ tabs: [] });
		expect(readReturnedFromHost({ tabs: [], hostCopyLeft: copyLeft(true) })).toEqual({
			tabs: [],
			hostCopyLeft: copyLeft(true),
		});
		expect(
			readReturnedFromHost({ tabs: [], hostCopyLeft: { ...copyLeft(true), fetched: 'yes' } })
		).toBeUndefined();
		expect(readReturnedFromHost({ tabs: [{ name: 'no id' }] })).toBeUndefined();
		expect(readReturnedFromHost({ tabs: 'x' })).toBeUndefined();
		expect(readReturnedFromHost(null)).toBeUndefined();
	});

	it('refuses a record that is not hosted', () => {
		expect(returnRestoreRefusal({})).toBe('Agent is not hosted');
		expect(returnRestoreRefusal(hostedAgent())).toBeUndefined();
		// Home with a host copy still to remove: the finishing restore is accepted.
		expect(returnRestoreRefusal({ hostCopyLeft: copyLeft(true) })).toBeUndefined();
	});
});

describe('runReturnFromHost', () => {
	it('reads the host tabs, restores here, then removes the host copy', async () => {
		const agent = hostedAgent();
		const d = deps(agent);
		const result = await runReturnFromHost('agent-1', {}, d.value);
		expect(d.connect).toHaveBeenCalledWith('remote-1', 'build-box');
		expect(d.restore).toHaveBeenNthCalledWith(1, 'agent-1', {
			tabs: [
				expect.objectContaining({ id: 'tab-1', logs: [log('l1'), log('l2')] }),
				expect.objectContaining({ id: 'tab-new', logs: [log('n1')] }),
			],
			activeTabId: 'tab-new',
			// Recorded until the removal below is confirmed (harmless once the copy is gone).
			leftOnHost: { peer: 'build-box', agentId: 'host-1', at: 1 },
			hostCopyLeft: copyLeft(true),
		});
		expect(d.client.agents.remove).toHaveBeenCalledWith('host-1');
		expect(d.restore.mock.invocationCallOrder[0]).toBeLessThan(
			d.client.agents.remove.mock.invocationCallOrder[0]
		);
		// Once the copy is gone, the marker is written away.
		expect(d.restore).toHaveBeenNthCalledWith(2, 'agent-1', { tabs: [] });
		expect(d.restore).toHaveBeenCalledTimes(2);
		expect(result).toEqual({
			agent: { id: 'agent-1', name: 'Docs' },
			from: 'build-box:host-1',
			tabs: 2,
			newTabs: 1,
			hostCopyRemoved: true,
		});
		expect(d.release).toHaveBeenCalled();
	});

	it('names a host draft that a local draft kept out of its tab, so it is not dropped unseen (R2)', async () => {
		const agent = hostedAgent({
			aiTabs: [{ id: 'tab-1', name: 'Main', logs: [log('l1')], inputValue: 'mine' }],
		});
		const client = hostClient({
			tabs: [{ id: 'tab-1', name: 'Main', agentSessionId: 'sess-1', inputValue: 'from host' }],
		});
		const d = deps(agent, client);
		const result = await runReturnFromHost('agent-1', {}, d.value);
		expect(result.notices).toEqual([
			'A draft typed on the host in tab "Main" was not put in that tab, because it has a draft of its own here. The host\'s draft was: from host',
		]);
	});

	it('a transcript read that times out is read again with a longer wait, not taken as a host gone (R7)', async () => {
		const client = hostClient();
		client.tabs.transcript.mockResolvedValueOnce(fail('timeout') as never);
		const d = deps(hostedAgent(), client);
		const result = await runReturnFromHost('agent-1', {}, d.value);
		expect(client.tabs.transcript).toHaveBeenNthCalledWith(2, 'host-1', 'tab-1', {
			timeoutMs: RETURN_TRANSCRIPT_RETRY_TIMEOUT_MS,
		});
		expect(d.restore.mock.calls[0][1].tabs[0]).toMatchObject({
			id: 'tab-1',
			logs: [log('l1'), log('l2')],
		});
		expect(result.hostCopyRemoved).toBe(true);
	});

	it('a transcript read that times out twice fails the return, and the agent is not written here (R7)', async () => {
		const client = hostClient();
		client.tabs.transcript.mockResolvedValue(fail('timeout') as never);
		const d = deps(hostedAgent(), client);
		await expect(runReturnFromHost('agent-1', {}, d.value)).rejects.toThrow();
		expect(client.tabs.transcript).toHaveBeenCalledTimes(2);
		expect(d.restore).not.toHaveBeenCalled();
		expect(client.agents.remove).not.toHaveBeenCalled();
	});

	it('keeps the host copy when asked, and says so', async () => {
		const d = deps(hostedAgent());
		const result = await runReturnFromHost('agent-1', { keepHostCopy: true }, d.value);
		expect(d.client.agents.remove).not.toHaveBeenCalled();
		expect(result.hostCopyRemoved).toBe(false);
		expect(result.notices?.[0]).toMatch(/keeps its copy/);
	});

	it('refuses an agent that is not hosted, or has no SSH remote, before dialing', async () => {
		for (const [agent, code] of [
			[hostedAgent({ liftedTo: undefined }), 'RETURN_NOT_HOSTED'],
			[hostedAgent({ sessionSshRemoteConfig: undefined } as Partial<AgentRecord>), 'RETURN_NO_SSH'],
		] as const) {
			const d = deps(agent);
			await expect(runReturnFromHost('agent-1', {}, d.value)).rejects.toMatchObject({ code });
			expect(d.connect).not.toHaveBeenCalled();
		}
	});

	it('refuses a running turn on the host, and changes nothing', async () => {
		const client = hostClient({
			agent: ok({ id: 'host-1', aiTabs: [{ id: 'tab-1', state: 'busy' }] }),
		});
		const d = deps(hostedAgent(), client);
		await expect(runReturnFromHost('agent-1', {}, d.value)).rejects.toMatchObject({
			code: 'RETURN_BUSY',
		});
		expect(d.restore).not.toHaveBeenCalled();
		expect(client.agents.remove).not.toHaveBeenCalled();
	});

	describe("the host's queue", () => {
		const waiting = { itemId: 'q1', tabId: 'tab-1', queuedAt: 10, text: 'next', paused: false };
		const held = { itemId: 'q2', tabId: 'tab-new', queuedAt: 20, text: 'later', paused: true };

		it('holds each waiting message on the host, brings both back, then removes the host copy', async () => {
			const client = hostClient({ queue: ok([waiting, held]) });
			const d = deps(hostedAgent(), client);
			const result = await runReturnFromHost('agent-1', {}, d.value);
			// Only the one the host could still start is held; the held one already is.
			expect(client.turns.queue.setPaused).toHaveBeenCalledTimes(1);
			expect(client.turns.queue.setPaused).toHaveBeenCalledWith('host-1', 'q1', true);
			expect(client.turns.queue.setPaused.mock.invocationCallOrder[0]).toBeLessThan(
				d.restore.mock.invocationCallOrder[0]
			);
			expect(d.restore.mock.calls[0][1].queue).toEqual([waiting, held]);
			expect(client.agents.remove).toHaveBeenCalledWith('host-1');
			expect(result.queued).toBe(2);
		});

		it('a message queued on the host while its transcripts were read comes home too, held; one removed there does not', async () => {
			const late = {
				itemId: 'q3',
				tabId: 'tab-1',
				queuedAt: 30,
				text: 'typed on host',
				paused: false,
			};
			const client = hostClient();
			client.turns.queue.list
				.mockResolvedValueOnce(ok([waiting, held]))
				// The second look: q1 is held by this return, q2 was removed on the host, q3 is new.
				.mockResolvedValueOnce(ok([{ ...waiting, paused: true }, late]));
			const d = deps(hostedAgent(), client);
			const result = await runReturnFromHost('agent-1', {}, d.value);
			expect(client.turns.queue.list).toHaveBeenCalledTimes(2);
			expect(client.turns.queue.setPaused.mock.calls).toEqual([
				['host-1', 'q1', true],
				['host-1', 'q3', true],
			]);
			expect(client.turns.queue.setPaused.mock.invocationCallOrder[1]).toBeLessThan(
				d.restore.mock.invocationCallOrder[0]
			);
			// Both come home as the user left them (not held by the user), the removed one does not.
			expect(d.restore.mock.calls[0][1].queue).toEqual([waiting, late]);
			expect(d.restore.mock.calls[0][1].hostCopyLeft?.carried).toEqual(['q1', 'q3']);
			expect(result.queued).toBe(2);
		});

		it('messages from a desktop host come home held, because its queue does not send their images (R2)', async () => {
			const client = hostClient({ queue: ok([waiting, held]) });
			const desktop = {
				...client,
				connection: { host: () => ({ kind: 'desktop' as const, label: 'desktop pid 1' }) },
			};
			const d = deps(hostedAgent(), desktop as unknown as typeof client);
			const result = await runReturnFromHost('agent-1', {}, d.value);
			expect(d.restore.mock.calls[0][1].queue).toEqual([{ ...waiting, paused: true }, held]);
			expect(result.notices?.join(' ')).toMatch(
				/build-box:host-1 is a Maestro desktop.*2 messages from its queue wait here, held/
			);
		});

		it('messages from a headless host keep their state: it takes no images (R2)', async () => {
			const client = hostClient({ queue: ok([waiting]) });
			const headless = {
				...client,
				connection: { host: () => ({ kind: 'headless' as const, label: 'headless pid 1' }) },
			};
			const d = deps(hostedAgent(), headless as unknown as typeof client);
			const result = await runReturnFromHost('agent-1', {}, d.value);
			expect(d.restore.mock.calls[0][1].queue).toEqual([waiting]);
			expect(result.notices).toBeUndefined();
		});

		it('the stored record ends home with both messages queued, the held one still held', async () => {
			const store = new Map<string, AgentRecord>([['agent-1', hostedAgent()]]);
			const client = hostClient({ queue: ok([waiting, held]) });
			const d = deps(hostedAgent(), client);
			d.value.readAgents = () => [...store.values()];
			d.restore.mockImplementation(async (id: string, returned) => {
				const record = store.get(id) as unknown as Record<string, unknown>;
				store.set(id, withReturnedFromHost(record, returned) as unknown as AgentRecord);
			});
			await runReturnFromHost('agent-1', {}, d.value);
			const home = store.get('agent-1') as AgentRecord & { executionQueue?: unknown[] };
			expect(home.liftedTo).toBeUndefined();
			expect(home.executionQueue).toEqual([
				{ id: 'q1', timestamp: 10, tabId: 'tab-1', type: 'message', text: 'next' },
				{ id: 'q2', timestamp: 20, tabId: 'tab-new', type: 'message', text: 'later', paused: true },
			]);
			// A second run finds it home and touches nothing.
			await expect(runReturnFromHost('agent-1', {}, d.value)).rejects.toMatchObject({
				code: 'RETURN_NOT_HOSTED',
			});
		});

		it('a message that started on the host before it was held is a running turn: nothing changes', async () => {
			const client = hostClient({
				queue: ok([held, waiting]),
				setPaused: ok({ found: false, paused: false }),
			});
			const d = deps(hostedAgent(), client);
			await expect(runReturnFromHost('agent-1', {}, d.value)).rejects.toMatchObject({
				code: 'RETURN_BUSY',
			});
			expect(d.restore).not.toHaveBeenCalled();
			expect(client.agents.remove).not.toHaveBeenCalled();
		});

		it('releases what it held when the restore fails, so the host can still run them', async () => {
			const client = hostClient({ queue: ok([waiting, held]) });
			const d = deps(hostedAgent(), client);
			d.restore.mockRejectedValue(new Error('window gone'));
			await expect(runReturnFromHost('agent-1', {}, d.value)).rejects.toMatchObject({
				code: 'RETURN_RESTORE_FAILED',
			});
			expect(client.turns.queue.setPaused.mock.calls).toEqual([
				['host-1', 'q1', true],
				['host-1', 'q1', false],
			]);
			expect(client.agents.remove).not.toHaveBeenCalled();
		});

		it('a restore that reports a failure but was written (a late window): the host keeps them held, nothing runs twice (R8)', async () => {
			const client = hostClient({ queue: ok([waiting, held]) });
			const d = deps(hostedAgent(), client);
			const store = new Map<string, AgentRecord>([['agent-1', hostedAgent()]]);
			d.value.readAgents = () => [...store.values()];
			d.restore.mockImplementationOnce(async (id: string, returned) => {
				const record = store.get(id) as unknown as Record<string, unknown>;
				store.set(id, withReturnedFromHost(record, returned) as unknown as AgentRecord);
				throw new Error('The window did not answer in time');
			});
			const result = await runReturnFromHost('agent-1', {}, d.value);
			expect(client.turns.queue.setPaused.mock.calls).toEqual([['host-1', 'q1', true]]);
			expect(client.agents.remove).toHaveBeenCalledWith('host-1');
			expect(result.hostCopyRemoved).toBe(true);
			const home = store.get('agent-1') as unknown as {
				liftedTo?: unknown;
				executionQueue: Array<{ id: string }>;
			};
			expect(home.liftedTo).toBeUndefined();
			expect(home.executionQueue.map((item) => item.id)).toEqual(['q1', 'q2']);
		});

		it('a turn that starts on the host during the return: nothing is written here, and what it held is released', async () => {
			const client = hostClient({ queue: ok([waiting]) });
			client.agents.get
				.mockResolvedValueOnce(ok({ id: 'host-1', aiTabs: [{ id: 'tab-1', state: 'idle' }] }))
				.mockResolvedValueOnce(ok({ id: 'host-1', aiTabs: [{ id: 'tab-1', state: 'busy' }] }));
			const d = deps(hostedAgent(), client);
			await expect(runReturnFromHost('agent-1', {}, d.value)).rejects.toMatchObject({
				code: 'RETURN_BUSY',
			});
			expect(d.restore).not.toHaveBeenCalled();
			expect(client.agents.remove).not.toHaveBeenCalled();
			expect(client.turns.queue.setPaused.mock.calls).toEqual([
				['host-1', 'q1', true],
				['host-1', 'q1', false],
			]);
		});

		it('a host read that fails releases what it held before the connection closes', async () => {
			const client = hostClient({ queue: ok([waiting]) });
			client.tabs.list.mockResolvedValue(fail('timeout'));
			const order: string[] = [];
			client.turns.queue.setPaused.mockImplementation(
				async (_agentId: string, itemId: string, paused: boolean) => {
					await Promise.resolve();
					order.push(`${itemId}:${paused}`);
					return ok({ found: true, paused });
				}
			);
			const d = deps(hostedAgent(), client);
			d.release.mockImplementation(async () => {
				order.push('release');
			});
			await expect(runReturnFromHost('agent-1', {}, d.value)).rejects.toThrow();
			expect(order).toEqual(['q1:true', 'q1:false', 'release']);
		});

		it('takes the messages out of a kept host copy, so they cannot run twice', async () => {
			const client = hostClient({ queue: ok([waiting, held]) });
			const d = deps(hostedAgent(), client);
			await runReturnFromHost('agent-1', { keepHostCopy: true }, d.value);
			expect(client.turns.queue.remove.mock.calls).toEqual([
				['host-1', 'q1'],
				['host-1', 'q2'],
			]);
			expect(client.agents.remove).not.toHaveBeenCalled();
		});
	});

	describe('withReturnedFromHost with a queue', () => {
		it('puts the host messages first, keeps held ones held, skips a duplicate, and re-targets a lost tab', () => {
			const record = hostedAgent({
				executionQueue: [
					{ id: 'local-1', timestamp: 50, tabId: 'tab-1', type: 'message', text: 'held here' },
					// The host's card for q1, drawn while hosted agents were on: replaced, not kept.
					{
						id: 'q1',
						timestamp: 10,
						tabId: 'tab-1',
						type: 'message',
						text: 'next',
						hostQueued: true,
					},
				],
			} as Partial<AgentRecord>) as unknown as Record<string, unknown>;
			const merged = withReturnedFromHost(record, {
				tabs: [],
				queue: [
					{ itemId: 'q1', tabId: 'tab-1', queuedAt: 10, text: 'next', paused: false },
					{ itemId: 'q2', tabId: 'tab-gone', queuedAt: 20, text: 'later', paused: true },
					{ itemId: 'local-1', tabId: 'tab-1', queuedAt: 30, text: 'dup', paused: false },
				],
			});
			expect(merged.executionQueue).toEqual([
				{ id: 'q1', timestamp: 10, tabId: 'tab-1', type: 'message', text: 'next' },
				{ id: 'q2', timestamp: 20, tabId: 'tab-1', type: 'message', text: 'later', paused: true },
				{ id: 'local-1', timestamp: 50, tabId: 'tab-1', type: 'message', text: 'held here' },
			]);
		});

		it('a slash command from the host queue comes home as a command, not as prompt text', () => {
			const merged = withReturnedFromHost(hostedAgent() as unknown as Record<string, unknown>, {
				tabs: [],
				queue: [
					{
						itemId: 'c1',
						tabId: 'tab-1',
						queuedAt: 10,
						text: '/speckit.plan the login page',
						paused: false,
						kind: 'command',
					},
					{
						itemId: 'c2',
						tabId: 'tab-1',
						queuedAt: 11,
						text: '/commit',
						paused: true,
						kind: 'command',
					},
				],
			});
			expect(merged.executionQueue).toEqual([
				{
					id: 'c1',
					timestamp: 10,
					tabId: 'tab-1',
					type: 'command',
					command: '/speckit.plan',
					commandArgs: 'the login page',
				},
				{
					id: 'c2',
					timestamp: 11,
					tabId: 'tab-1',
					paused: true,
					type: 'command',
					command: '/commit',
					commandArgs: '',
				},
			]);
			const stored = readReturnedFromHost({
				tabs: [],
				queue: [{ itemId: 'c1', tabId: 'tab-1', queuedAt: 10, text: '/commit', kind: 'command' }],
			});
			expect(stored?.queue?.[0]?.kind).toBe('command');
		});

		it('readReturnedFromHost keeps a valid queue and refuses a malformed one', () => {
			const queue = [{ itemId: 'q1', tabId: 'tab-1', queuedAt: 10, text: 'next', paused: true }];
			expect(readReturnedFromHost({ tabs: [], queue })).toEqual({ tabs: [], queue });
			expect(readReturnedFromHost({ tabs: [], queue: [{ itemId: 'q1' }] })).toBeUndefined();
			expect(readReturnedFromHost({ tabs: [], queue: 'nope' })).toBeUndefined();
		});
	});

	// Parity R50, with the come-home rule (R2): a message the person held on the host comes home
	// held, with its model, effort and images; one waiting to run is held on the host first and
	// comes home too, so nothing waits on the host and nothing runs twice.
	it('brings a held host message home held with its settings and images, and a waiting one too (R50)', async () => {
		const heldItem = {
			itemId: 'h1',
			tabId: 'tab-1',
			queuedAt: 7,
			kind: 'message',
			text: 'later',
			paused: true,
			turnSettings: { model: 'opus' },
			images: ['data:image/png;base64,AAAA'],
		};
		const d = deps(hostedAgent(), hostClient({ queue: ok([heldItem]) }));
		await runReturnFromHost('agent-1', {}, d.value);
		const returned = d.restore.mock.calls[0][1];
		expect(returned.queue).toEqual([
			{
				itemId: 'h1',
				tabId: 'tab-1',
				queuedAt: 7,
				text: 'later',
				paused: true,
				turnSettings: { model: 'opus' },
				images: ['data:image/png;base64,AAAA'],
			},
		]);
		const restored = withReturnedFromHost(
			hostedAgent({ executionQueue: [] } as Partial<AgentRecord>) as unknown as Record<
				string,
				unknown
			>,
			readReturnedFromHost(JSON.parse(JSON.stringify(returned)))!
		);
		expect(restored.executionQueue).toEqual([
			{
				id: 'h1',
				timestamp: 7,
				tabId: 'tab-1',
				type: 'message',
				text: 'later',
				turnSettings: { model: 'opus' },
				images: ['data:image/png;base64,AAAA'],
				paused: true,
			},
		]);

		// Held for a tab the host does not list (a hidden tab): it comes home on the active tab,
		// never refused and never dropped.
		const hidden = deps(
			hostedAgent(),
			hostClient({ queue: ok([{ ...heldItem, tabId: 'tab-hidden' }]) })
		);
		await runReturnFromHost('agent-1', {}, hidden.value);
		const hiddenQueue = withReturnedFromHost(
			hostedAgent() as unknown as Record<string, unknown>,
			hidden.restore.mock.calls[0][1]
		).executionQueue as { id: string; tabId: string }[];
		expect(hiddenQueue.map((item) => item.id)).toEqual(['h1']);
		expect(hiddenQueue[0].tabId).not.toBe('tab-hidden');

		// A held message and one waiting to run: the waiting one is held on the host first, and
		// both come home; the user's own hold is kept, the return's is not.
		const both = hostClient({
			queue: ok([heldItem, { ...heldItem, itemId: 'r1', paused: false }]),
		});
		const bothDeps = deps(hostedAgent(), both);
		await runReturnFromHost('agent-1', {}, bothDeps.value);
		expect(both.turns.queue.setPaused).toHaveBeenCalledWith('host-1', 'r1', true);
		expect(
			(bothDeps.restore.mock.calls[0][1].queue as { itemId: string; paused: boolean }[]).map(
				(item) => [item.itemId, item.paused]
			)
		).toEqual([
			['h1', true],
			['r1', false],
		]);

		// With the host copy kept, the held message comes home and leaves the host's queue, so it is
		// never held on both.
		const kept = hostClient({ queue: ok([heldItem]) });
		const keptDeps = deps(hostedAgent(), kept);
		await runReturnFromHost('agent-1', { keepHostCopy: true }, keptDeps.value);
		expect(keptDeps.restore).toHaveBeenCalled();
		expect(kept.turns.queue.remove).toHaveBeenCalledWith('host-1', 'h1');
	});

	it('comes back with this machine copy when the host no longer has the agent', async () => {
		const client = hostClient({ agent: fail('not-found') });
		const d = deps(hostedAgent(), client);
		const result = await runReturnFromHost('agent-1', {}, d.value);
		expect(d.restore).toHaveBeenCalledWith('agent-1', { tabs: [] });
		expect(client.agents.remove).not.toHaveBeenCalled();
		expect(result.notices?.[0]).toMatch(/no longer has build-box:host-1/);
	});

	it('leaves the host untouched when the restore fails', async () => {
		const d = deps(hostedAgent());
		d.restore.mockRejectedValue(new Error('window gone'));
		await expect(runReturnFromHost('agent-1', {}, d.value)).rejects.toMatchObject({
			code: 'RETURN_RESTORE_FAILED',
		});
		expect(d.client.agents.remove).not.toHaveBeenCalled();
	});

	it('reports a host copy it could not remove, after the agent is back', async () => {
		const d = deps(hostedAgent(), hostClient({ remove: fail('host-lost', 'socket closed') }));
		const result = await runReturnFromHost('agent-1', {}, d.value);
		// Recorded until the removal is confirmed, so a later Move to Host replaces it (T5 review).
		expect(d.restore).toHaveBeenCalledWith(
			'agent-1',
			expect.objectContaining({ leftOnHost: { peer: 'build-box', agentId: 'host-1', at: 1 } })
		);
		expect(result.hostCopyRemoved).toBe(false);
		expect(result.notices?.[0]).toMatch(/could not be removed: socket closed/);
		expect(result.notices?.[0]).toContain('maestro-cli remove-agent build-box:host-1');
		// The marker stays, so the next launch removes the copy.
		expect(d.restore).toHaveBeenCalledTimes(1);
		expect(d.restore.mock.calls[0][1].hostCopyLeft).toEqual(copyLeft(true));
	});

	it('moves back offline without dialing, and keeps the host copy', async () => {
		const d = deps(hostedAgent());
		const result = await runReturnFromHost('agent-1', { offline: true }, d.value);
		expect(d.connect).not.toHaveBeenCalled();
		// The copy left on the host is recorded twice: for the come-home job, and so a later Move to
		// Host replaces it (T5).
		expect(d.restore).toHaveBeenCalledWith('agent-1', {
			tabs: [],
			hostCopyLeft: copyLeft(false),
			leftOnHost: { peer: 'build-box', agentId: 'host-1', at: 1 },
		});
		expect(result.hostCopyRemoved).toBe(false);
		// A command run on this machine: `peer:agent` reaches a headless host too.
		expect(result.notices?.[0]).toContain('maestro-cli remove-agent build-box:host-1');
		expect(result.notices?.[0]).toContain('maestro-cli show agent build-box:host-1');
		expect(result.notices?.[0]).toContain('Moving the agent to the host again replaces that copy');
	});

	it.each([
		['no SSH settings', { sessionSshRemoteConfig: undefined }],
		['SSH turned off', { sessionSshRemoteConfig: { enabled: false, remoteId: 'remote-1' } }],
		['no remote id', { sessionSshRemoteConfig: { enabled: true, remoteId: '' } }],
	])('moves back offline with %s, so no agent stays moved (R1)', async (_label, patch) => {
		const d = deps(hostedAgent(patch as Partial<AgentRecord>));
		const result = await runReturnFromHost('agent-1', { offline: true }, d.value);
		expect(d.connect).not.toHaveBeenCalled();
		expect(d.restore).toHaveBeenCalledWith('agent-1', {
			tabs: [],
			hostCopyLeft: copyLeft(false),
			leftOnHost: { peer: 'build-box', agentId: 'host-1', at: 1 },
		});
		expect(result.hostCopyRemoved).toBe(false);
	});

	describe('a host copy left behind (I3, I4)', () => {
		/** A store the restore writes through `withReturnedFromHost()`, as the window does. */
		function stored(agent: AgentRecord, client = hostClient()) {
			const store = new Map<string, AgentRecord>([[agent.id, agent]]);
			const d = deps(agent, client);
			d.value.readAgents = () => [...store.values()];
			d.restore.mockImplementation(async (id: string, returned) => {
				const record = store.get(id) as unknown as Record<string, unknown>;
				store.set(id, withReturnedFromHost(record, returned) as unknown as AgentRecord);
			});
			return { ...d, store };
		}

		it('a crash after the restore leaves the agent home and marked; the next return removes the copy and brings nothing twice', async () => {
			const waiting = { itemId: 'q1', tabId: 'tab-1', queuedAt: 10, text: 'next', paused: false };
			const client = hostClient({ queue: ok([waiting]) });
			const d = stored(hostedAgent(), client);
			// The link dies while removing the host copy: the agent is home, and says so.
			client.agents.remove.mockRejectedValueOnce(new Error('link lost'));
			const first = await runReturnFromHost('agent-1', {}, d.value);
			expect(first.hostCopyRemoved).toBe(false);
			expect(first.notices?.join(' ')).toMatch(/stopped answering before its copy was removed/);
			expect(d.release).toHaveBeenCalledTimes(1);
			const home = d.store.get('agent-1') as AgentRecord & { executionQueue?: unknown[] };
			expect(home.liftedTo).toBeUndefined();
			expect(home.hostCopyLeft).toEqual({
				...copyLeft(true, ['q1']),
				homeTabIds: ['tab-1', 'tab-old', 'tab-new'],
			});
			expect(home.executionQueue).toHaveLength(1);

			// The next launch: the copy is read again, the message that came home is not held or
			// carried a second time, and the copy is removed.
			client.turns.queue.setPaused.mockClear();
			const result = await runReturnFromHost('agent-1', {}, d.value);
			expect(client.turns.queue.setPaused).not.toHaveBeenCalled();
			expect(client.agents.remove).toHaveBeenLastCalledWith('host-1');
			expect(result.hostCopyRemoved).toBe(true);
			const done = d.store.get('agent-1') as AgentRecord & { executionQueue?: unknown[] };
			expect(done.hostCopyLeft).toBeUndefined();
			expect(done.executionQueue).toHaveLength(1);
			expect(d.release).toHaveBeenCalledTimes(2);
			// Settled: a third run touches nothing.
			await expect(runReturnFromHost('agent-1', {}, d.value)).rejects.toMatchObject({
				code: 'RETURN_NOT_HOSTED',
			});
		});

		it('a copy left behind that took turns and messages since: they come home, the carried message does not come twice', async () => {
			const first = { itemId: 'q1', tabId: 'tab-1', queuedAt: 10, text: 'first', paused: false };
			const client = hostClient({
				queue: ok([first]),
				transcripts: { 'tab-1': [log('l1')], 'tab-new': [log('n1')] },
			});
			const d = stored(hostedAgent(), client);
			// The removal is refused: the agent is home, the copy stays on the host.
			client.agents.remove.mockResolvedValueOnce(fail('rejected'));
			const back = await runReturnFromHost('agent-1', {}, d.value);
			expect(back.hostCopyRemoved).toBe(false);
			expect(d.store.get('agent-1')?.hostCopyLeft).toEqual({
				...copyLeft(true, ['q1']),
				homeTabIds: ['tab-1', 'tab-old', 'tab-new'],
			});
			// The carried message runs here, and leaves the local queue.
			const home = d.store.get('agent-1') as AgentRecord & { executionQueue?: unknown[] };
			d.store.set('agent-1', { ...home, executionQueue: [] } as AgentRecord);

			// Meanwhile the host copy ran a turn and took a new message; the carried one still waits
			// there, held.
			client.tabs.transcript.mockImplementation(async (_agentId: string, tabId: string) =>
				ok(tabId === 'tab-1' ? [log('l1'), log('h2', 2)] : [log('n1')])
			);
			const later = { itemId: 'q2', tabId: 'tab-1', queuedAt: 20, text: 'later', paused: false };
			client.turns.queue.list.mockResolvedValue(ok([{ ...first, paused: true }, later]));
			client.turns.queue.setPaused.mockClear();

			const result = await runReturnFromHost('agent-1', {}, d.value);
			expect(result.hostCopyRemoved).toBe(true);
			expect(result.queued).toBe(1);
			expect(client.turns.queue.setPaused).toHaveBeenCalledTimes(1);
			expect(client.turns.queue.setPaused).toHaveBeenCalledWith('host-1', 'q2', true);
			const done = d.store.get('agent-1') as AgentRecord & {
				executionQueue?: { id: string; text: string }[];
			};
			expect(done.hostCopyLeft).toBeUndefined();
			expect(done.aiTabs?.find((tab) => tab.id === 'tab-1')?.logs).toEqual([
				log('l1'),
				log('h2', 2),
			]);
			expect(done.executionQueue?.map((item) => [item.id, item.text])).toEqual([['q2', 'later']]);
		});

		it('a cleanup call that throws after the restore is a notice, and the connection is released once', async () => {
			const waiting = { itemId: 'q1', tabId: 'tab-1', queuedAt: 10, text: 'next', paused: false };
			const client = hostClient({ queue: ok([waiting]) });
			client.turns.queue.remove.mockRejectedValueOnce(new Error('socket closed'));
			const d = stored(hostedAgent(), client);
			d.release.mockRejectedValueOnce(new Error('forward stuck'));
			const result = await runReturnFromHost('agent-1', { keepHostCopy: true }, d.value);
			expect(d.store.get('agent-1')?.liftedTo).toBeUndefined();
			expect(result.notices?.join(' ')).toMatch(/stopped answering before the messages/);
			expect(result.notices?.join(' ')).toMatch(/did not close: forward stuck/);
			expect(d.release).toHaveBeenCalledTimes(1);
		});

		it('a copy kept on purpose loses the messages that came home earlier too', async () => {
			const home = {
				...hostedAgent(),
				liftedTo: undefined,
				hostCopyLeft: copyLeft(true, ['q1']),
			};
			const held = { itemId: 'q1', tabId: 'tab-1', queuedAt: 10, text: 'first', paused: true };
			const client = hostClient({ queue: ok([held]) });
			const d = stored(home as AgentRecord, client);
			const result = await runReturnFromHost('agent-1', { keepHostCopy: true }, d.value);
			expect(result.hostCopyRemoved).toBe(false);
			expect(client.agents.remove).not.toHaveBeenCalled();
			expect(client.turns.queue.remove).toHaveBeenCalledWith('host-1', 'q1');
			expect(d.store.get('agent-1')?.hostCopyLeft).toBeUndefined();
		});

		it('a copy left behind that runs a turn is waited out, never removed mid-turn', async () => {
			const home = { ...hostedAgent(), liftedTo: undefined, hostCopyLeft: copyLeft(true) };
			const busy = hostClient({
				agent: ok({ id: 'host-1', aiTabs: [{ id: 'tab-1', state: 'busy' }] }),
			});
			const d = stored(home as AgentRecord, busy);
			await expect(runReturnFromHost('agent-1', {}, d.value)).rejects.toMatchObject({
				code: 'RETURN_BUSY',
			});
			expect(busy.agents.remove).not.toHaveBeenCalled();
			expect(d.store.get('agent-1')?.hostCopyLeft).toEqual(copyLeft(true));
		});

		it('offline, then the host answers: what the host wrote since comes home, rows written here meanwhile stay, and the copy is removed', async () => {
			const client = hostClient({
				tabs: [{ id: 'tab-1', name: 'Main', agentSessionId: 'sess-1' }],
				transcripts: { 'tab-1': [log('l1'), log('h2', 2)] },
			});
			const d = stored(hostedAgent(), client);
			await runReturnFromHost('agent-1', { offline: true }, d.value);
			expect(d.store.get('agent-1')?.hostCopyLeft).toEqual({
				...copyLeft(false),
				homeTabIds: ['tab-1', 'tab-old'],
			});
			// The agent works here while the host is down: a new row on its tab.
			const away = d.store.get('agent-1') as AgentRecord;
			d.store.set('agent-1', {
				...away,
				aiTabs: (away.aiTabs ?? []).map((tab) =>
					tab.id === 'tab-1' ? { ...tab, logs: [...(tab.logs ?? []), log('m3', 3)] } : tab
				),
			});
			// A return offline again does nothing: it is home.
			await expect(runReturnFromHost('agent-1', { offline: true }, d.value)).rejects.toMatchObject({
				code: 'RETURN_NOT_HOSTED',
			});

			const result = await runReturnFromHost('agent-1', {}, d.value);
			expect(result.hostCopyRemoved).toBe(true);
			const done = d.store.get('agent-1') as AgentRecord;
			expect(done.hostCopyLeft).toBeUndefined();
			expect(done.aiTabs?.find((tab) => tab.id === 'tab-1')?.logs).toEqual([
				log('l1'),
				log('h2', 2),
				log('m3', 3),
			]);
			expect(done.aiTabs?.map((tab) => tab.id)).toEqual(['tab-1', 'tab-old']);
		});

		it('a copy the host no longer has clears the marker without a word', async () => {
			const home = { ...hostedAgent(), liftedTo: undefined, hostCopyLeft: copyLeft(true) };
			const d = stored(home as AgentRecord, hostClient({ agent: fail('not-found') }));
			const result = await runReturnFromHost('agent-1', {}, d.value);
			expect(result.notices).toBeUndefined();
			expect(d.store.get('agent-1')?.hostCopyLeft).toBeUndefined();
		});
	});

	it('throws a LiftRunError for an unknown agent', async () => {
		const d = deps(hostedAgent());
		await expect(runReturnFromHost('missing', {}, d.value)).rejects.toBeInstanceOf(LiftRunError);
	});
});

/**
 * Moving a hosted agent back from its host (`runReturnFromHost()`, `withReturnedFromHost()`): the
 * refusals, the host read, the merge by tab id, the host copy's removal, and the offline path.
 * `maestro-cli unlift` and the desktop's Move Back from Host both run these.
 */
import { describe, expect, it, vi } from 'vitest';

import type { AgentRecord, AITabRecord } from '../../store/records';
import { queuedItemRunsReadOnly } from '../../../queuedTurnSettings';
import { LiftRunError } from '../lift-run';
import {
	hostDraftsNotKept,
	readReturnedFromHost,
	RestoreUnsettledError,
	RETURN_LATE_QUEUE_PASSES,
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
	const pausedOnHost = new Map<string, boolean>();
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
				// The host's queue keeps what Hold / Resume set, as a real host does.
				list: vi.fn(async () => {
					const listed = (overrides.queue ?? ok([])) as {
						ok: boolean;
						value?: Array<{ itemId: string; paused: boolean }>;
					};
					if (!listed.ok || !listed.value) return listed;
					return ok(
						listed.value.map((item) =>
							pausedOnHost.has(item.itemId)
								? { ...item, paused: pausedOnHost.get(item.itemId) }
								: item
						)
					);
				}),
				setPaused: vi.fn(async (_agentId: string, itemId: string, paused: boolean) => {
					const answer = (overrides.setPaused ?? ok({ found: true, paused })) as {
						ok: boolean;
						value?: { found: boolean };
					};
					if (answer.ok && answer.value?.found) pausedOnHost.set(itemId, paused);
					return answer;
				}),
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
});

describe('readReturnedFromHost and returnRestoreRefusal', () => {
	it('reads a well-formed value and refuses a malformed one', () => {
		expect(readReturnedFromHost({ tabs: [{ id: 't1' }], activeTabId: 't1' })).toEqual({
			tabs: [{ id: 't1' }],
			activeTabId: 't1',
		});
		expect(readReturnedFromHost({ tabs: [], hostCopyLeft: copyLeft(true) })).toEqual({
			tabs: [],
			hostCopyLeft: copyLeft(true),
		});
		// A copy the user kept keeps saying so on the wire to the window.
		const kept = { ...copyLeft(true, ['q1']), keep: true };
		expect(readReturnedFromHost({ tabs: [], hostCopyLeft: kept })?.hostCopyLeft).toEqual(kept);
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
		// A host of this release says whether each message runs read-only.
		const waiting = {
			itemId: 'q1',
			tabId: 'tab-1',
			queuedAt: 10,
			text: 'next',
			paused: false,
			readOnly: false,
		};
		const held = {
			itemId: 'q2',
			tabId: 'tab-new',
			queuedAt: 20,
			text: 'later',
			paused: true,
			readOnly: false,
		};

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
				readOnly: false,
			};
			const client = hostClient();
			client.turns.queue.list
				.mockResolvedValueOnce(ok([waiting, held]))
				// The second look: q1 is held by this return, q2 was removed on the host, q3 is new.
				.mockResolvedValueOnce(ok([{ ...waiting, paused: true }, late]));
			const d = deps(hostedAgent(), client);
			const result = await runReturnFromHost('agent-1', {}, d.value);
			// Twice before the restore, and once after it, before the copy is removed.
			expect(client.turns.queue.list).toHaveBeenCalledTimes(3);
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

		it('a draft from a desktop host comes home as text, and the notice says its staged images do not (#2195)', async () => {
			const client = hostClient({
				tabs: [
					{ id: 'tab-1', name: 'Main', agentSessionId: 'sess-1', inputValue: 'see the screenshot' },
					{ id: 'tab-new', name: 'Started on host', agentSessionId: 'sess-2', inputValue: '  ' },
				],
			});
			const desktop = {
				...client,
				connection: { host: () => ({ kind: 'desktop' as const, label: 'desktop pid 1' }) },
			};
			const d = deps(hostedAgent(), desktop as unknown as typeof client);
			const result = await runReturnFromHost('agent-1', {}, d.value);
			expect(d.restore.mock.calls[0][1].tabs[0].inputValue).toBe('see the screenshot');
			const said = result.notices?.join(' ') ?? '';
			expect(said).toMatch(
				/build-box:host-1 is a Maestro desktop, which does not send the images staged with a draft\. The draft in tab "Main" came back as text only/
			);
			expect(said).not.toMatch(/Started on host/);
			// The same drafts from a headless host: it sends what it holds, so there is nothing to say.
			const headless = {
				...client,
				connection: { host: () => ({ kind: 'headless' as const, label: 'headless pid 1' }) },
			};
			const h = deps(hostedAgent(), headless as unknown as typeof client);
			expect((await runReturnFromHost('agent-1', {}, h.value)).notices).toBeUndefined();
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
				{
					id: 'q1',
					timestamp: 10,
					tabId: 'tab-1',
					type: 'message',
					text: 'next',
				},
				{
					id: 'q2',
					timestamp: 20,
					tabId: 'tab-new',
					type: 'message',
					text: 'later',
					paused: true,
				},
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
				// A window that did not answer in time: the timeout main raises (`NO_RESTORE_ANSWER`).
				throw new RestoreUnsettledError('The window did not answer in time');
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
		expect(d.restore).toHaveBeenCalled();
		expect(result.hostCopyRemoved).toBe(false);
		expect(result.notices?.[0]).toMatch(/could not be removed: socket closed/);
		// The marker stays, so the next launch removes the copy.
		expect(d.restore).toHaveBeenCalledTimes(1);
		expect(d.restore.mock.calls[0][1].hostCopyLeft).toEqual(copyLeft(true));
	});

	it('moves back offline without dialing, and keeps the host copy', async () => {
		const d = deps(hostedAgent());
		const result = await runReturnFromHost('agent-1', { offline: true }, d.value);
		expect(d.connect).not.toHaveBeenCalled();
		expect(d.restore).toHaveBeenCalledWith('agent-1', { tabs: [], hostCopyLeft: copyLeft(false) });
		expect(result.hostCopyRemoved).toBe(false);
		// The limit on the automatic recovery, and the queue that may still hold work (#2195).
		expect(result.notices?.[0]).toMatch(/for the next 14 days, Maestro tries the host again/);
		expect(result.notices?.[0]).toMatch(
			/After that, nothing is brought home: the copy \(agent host-1 there\) may still hold messages in its queue/
		);
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
			client.turns.queue.list
				.mockResolvedValueOnce(ok([{ ...first, paused: true }, later]))
				.mockResolvedValue(
					ok([
						{ ...first, paused: true },
						{ ...later, paused: true },
					])
				);
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
			// The message is still noted, so the next return takes it out of the host's queue.
			expect(d.store.get('agent-1')?.hostCopyLeft).toMatchObject({ keep: true, carried: ['q1'] });
		});

		it('a kept copy whose queue would not let a message go stays noted, and the next return takes it out without reading or removing the copy (#2195)', async () => {
			const waiting = { itemId: 'q1', tabId: 'tab-1', queuedAt: 10, text: 'next', paused: false };
			const client = hostClient({ queue: ok([waiting]) });
			client.turns.queue.remove.mockResolvedValueOnce(fail('rejected', 'queue locked'));
			const d = stored(hostedAgent(), client);
			const first = await runReturnFromHost('agent-1', { keepHostCopy: true }, d.value);
			expect(first.notices?.join(' ')).toMatch(
				/still waits, held, in the host's queue \(build-box:host-1\): queue locked Maestro takes it out at the next launch/
			);
			const home = d.store.get('agent-1') as AgentRecord & { executionQueue?: { id: string }[] };
			expect(home.liftedTo).toBeUndefined();
			expect(home.executionQueue?.map((item) => item.id)).toEqual(['q1']);
			expect(home.hostCopyLeft).toEqual({
				...copyLeft(true, ['q1']),
				homeTabIds: ['tab-1', 'tab-old', 'tab-new'],
				keep: true,
			});
			// The offline return has nothing to do for it.
			await expect(runReturnFromHost('agent-1', { offline: true }, d.value)).rejects.toThrow(
				/The host keeps its copy/
			);

			// The next launch (the come-home pass asks with no options): only the queue is cleaned.
			const result = await runReturnFromHost('agent-1', {}, d.value);
			expect(client.turns.queue.remove).toHaveBeenLastCalledWith('host-1', 'q1');
			expect(client.tabs.list).toHaveBeenCalledTimes(1);
			expect(client.turns.queue.setPaused).toHaveBeenCalledTimes(1);
			expect(client.agents.remove).not.toHaveBeenCalled();
			expect(result).toMatchObject({ hostCopyRemoved: false, tabs: 0 });
			expect(d.store.get('agent-1')?.hostCopyLeft).toBeUndefined();
			expect(d.release).toHaveBeenCalledTimes(2);
			await expect(runReturnFromHost('agent-1', {}, d.value)).rejects.toMatchObject({
				code: 'RETURN_NOT_HOSTED',
			});
		});

		it('a kept copy the host no longer has: the note is cleared, nothing is dialed again', async () => {
			const home = {
				...hostedAgent(),
				liftedTo: undefined,
				hostCopyLeft: { ...copyLeft(true, ['q1']), keep: true },
			};
			const client = hostClient({ agent: fail('not-found') });
			const d = stored(home as AgentRecord, client);
			const result = await runReturnFromHost('agent-1', {}, d.value);
			expect(result.hostCopyRemoved).toBe(false);
			expect(client.turns.queue.remove).not.toHaveBeenCalled();
			expect(client.agents.remove).not.toHaveBeenCalled();
			expect(d.store.get('agent-1')?.hostCopyLeft).toBeUndefined();
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

	describe('a return the host or the window races (#2195)', () => {
		const item = (itemId: string, extra: Record<string, unknown> = {}) => ({
			itemId,
			tabId: 'tab-1',
			queuedAt: 10,
			text: `text of ${itemId}`,
			paused: false,
			readOnly: false,
			...extra,
		});
		function storedDeps(client: ReturnType<typeof hostClient>) {
			const store = new Map<string, AgentRecord>([['agent-1', hostedAgent()]]);
			const d = deps(hostedAgent(), client);
			d.value.readAgents = () => [...store.values()];
			d.restore.mockImplementation(async (id: string, returned) => {
				const record = store.get(id) as unknown as Record<string, unknown>;
				store.set(id, withReturnedFromHost(record, returned) as unknown as AgentRecord);
			});
			const queueIds = () =>
				(
					(store.get('agent-1') as unknown as { executionQueue?: Array<{ id: string }> })
						.executionQueue ?? []
				).map((queued) => queued.id);
			return { ...d, store, queueIds };
		}

		it('a message resumed on the host during the return is held again, so it never runs there while it comes home', async () => {
			const client = hostClient({ queue: ok([item('q1')]) });
			client.turns.queue.list
				.mockResolvedValueOnce(ok([item('q1')]))
				// The user resumed it on the host while the transcripts were read.
				.mockResolvedValueOnce(ok([item('q1', { paused: false })]));
			const d = deps(hostedAgent(), client);
			await runReturnFromHost('agent-1', {}, d.value);
			expect(client.turns.queue.setPaused.mock.calls).toEqual([
				['host-1', 'q1', true],
				['host-1', 'q1', true],
			]);
			expect(client.turns.queue.setPaused.mock.invocationCallOrder[1]).toBeLessThan(
				d.restore.mock.invocationCallOrder[0]
			);
			// Runnable here: this return held it, not the user.
			expect(d.restore.mock.calls[0][1].queue).toEqual([item('q1')]);
		});

		it('a message the host takes after the last read comes home, held there first, before the copy is removed', async () => {
			const client = hostClient({ queue: ok([item('q1')]) });
			client.turns.queue.list
				.mockResolvedValueOnce(ok([item('q1')]))
				.mockResolvedValueOnce(ok([item('q1', { paused: true })]))
				// Taken by the host after the restore was written.
				.mockResolvedValueOnce(ok([item('q1', { paused: true }), item('q3')]))
				.mockResolvedValue(ok([item('q1', { paused: true }), item('q3', { paused: true })]));
			const d = storedDeps(client);
			const result = await runReturnFromHost('agent-1', {}, d.value);
			expect(client.turns.queue.setPaused).toHaveBeenCalledWith('host-1', 'q3', true);
			const holdLate = client.turns.queue.setPaused.mock.calls.findIndex(
				(call) => call[1] === 'q3'
			);
			expect(client.turns.queue.setPaused.mock.invocationCallOrder[holdLate]).toBeLessThan(
				d.restore.mock.invocationCallOrder[1]
			);
			expect(d.restore.mock.invocationCallOrder[1]).toBeLessThan(
				client.agents.remove.mock.invocationCallOrder[0]
			);
			// In the host's order: the message it took later waits after the one it took first.
			expect(d.queueIds()).toEqual(['q1', 'q3']);
			expect(result.queued).toBe(2);
			expect(result.hostCopyRemoved).toBe(true);
			expect(d.store.get('agent-1')?.hostCopyLeft).toBeUndefined();
		});

		it('late batches keep the host order, ahead of a message typed here (#2197)', async () => {
			const client = hostClient({ queue: ok([item('q1')]) });
			client.turns.queue.list
				.mockResolvedValueOnce(ok([item('q1')]))
				.mockResolvedValueOnce(ok([item('q1', { paused: true })]))
				.mockResolvedValueOnce(ok([item('q1', { paused: true }), item('q2')]))
				.mockResolvedValueOnce(
					ok([item('q1', { paused: true }), item('q2', { paused: true }), item('q3')])
				)
				.mockResolvedValue(
					ok([
						item('q1', { paused: true }),
						item('q2', { paused: true }),
						item('q3', { paused: true }),
					])
				);
			const d = storedDeps(client);
			d.store.set('agent-1', {
				...hostedAgent(),
				executionQueue: [{ id: 'mine', tabId: 'tab-1', text: 'typed here' }],
			} as unknown as AgentRecord);
			await runReturnFromHost('agent-1', {}, d.value);
			expect(d.queueIds()).toEqual(['q1', 'q2', 'q3', 'mine']);
		});

		it('a late message for a tab opened on the host during the return comes home in that tab, with its conversation (#2197)', async () => {
			const client = hostClient({ queue: ok([item('q1')]) });
			const opened = { id: 'tab-late', name: 'Opened on host', agentSessionId: 'sess-9' };
			client.turns.queue.list
				.mockResolvedValueOnce(ok([item('q1')]))
				.mockResolvedValueOnce(ok([item('q1', { paused: true })]))
				.mockResolvedValueOnce(
					ok([item('q1', { paused: true }), item('q3', { tabId: 'tab-late' })])
				)
				.mockResolvedValue(
					ok([item('q1', { paused: true }), item('q3', { tabId: 'tab-late', paused: true })])
				);
			client.tabs.list
				.mockResolvedValueOnce(
					ok([{ id: 'tab-1', name: 'Main', agentSessionId: 'sess-1' }] as AITabRecord[])
				)
				.mockResolvedValue(
					ok([{ id: 'tab-1', name: 'Main', agentSessionId: 'sess-1' }, opened] as AITabRecord[])
				);
			client.tabs.transcript.mockImplementation(async (_agentId: string, tabId: string) =>
				ok(tabId === 'tab-late' ? [log('late-1')] : [log('l1')])
			);
			const d = storedDeps(client);
			const result = await runReturnFromHost('agent-1', {}, d.value);
			const done = d.store.get('agent-1') as AgentRecord & {
				executionQueue?: Array<{ id: string; tabId: string }>;
			};
			expect(done.aiTabs?.find((tab) => tab.id === 'tab-late')?.logs).toEqual([log('late-1')]);
			expect(done.executionQueue?.find((queued) => queued.id === 'q3')?.tabId).toBe('tab-late');
			expect(result.newTabs).toBe(1);
			expect(result.hostCopyRemoved).toBe(true);
		});

		it('a message queued in a tab the host opened before the second queue read comes home in that tab in the first restore (#2199)', async () => {
			const client = hostClient({ queue: ok([item('q1')]) });
			const opened = { id: 'tab-late', name: 'Opened on host', agentSessionId: 'sess-9' };
			client.turns.queue.list
				.mockResolvedValueOnce(ok([item('q1')]))
				.mockResolvedValue(
					ok([item('q1', { paused: true }), item('q2', { tabId: 'tab-late', paused: true })])
				);
			client.tabs.list
				.mockResolvedValueOnce(
					ok([{ id: 'tab-1', name: 'Main', agentSessionId: 'sess-1' }] as AITabRecord[])
				)
				.mockResolvedValue(
					ok([{ id: 'tab-1', name: 'Main', agentSessionId: 'sess-1' }, opened] as AITabRecord[])
				);
			client.tabs.transcript.mockImplementation(async (_agentId: string, tabId: string) =>
				ok(tabId === 'tab-late' ? [log('late-1')] : [log('l1')])
			);
			const d = storedDeps(client);
			await runReturnFromHost('agent-1', {}, d.value);
			const first = d.restore.mock.calls[0][1];
			expect(first.tabs.map((tab: AITabRecord) => tab.id)).toContain('tab-late');
			expect(first.queue?.find((queued: { itemId: string }) => queued.itemId === 'q2')?.tabId).toBe(
				'tab-late'
			);
			const done = d.store.get('agent-1') as AgentRecord & {
				executionQueue?: Array<{ id: string; tabId: string }>;
			};
			expect(done.aiTabs?.find((tab) => tab.id === 'tab-late')?.logs).toEqual([log('late-1')]);
			expect(done.executionQueue?.find((queued) => queued.id === 'q2')?.tabId).toBe('tab-late');
		});

		it('once the agent is home, a failed hold releases nothing on the host, so a message that came home never runs there (#2197)', async () => {
			const client = hostClient({ queue: ok([item('q1')]) });
			client.turns.queue.list
				.mockResolvedValueOnce(ok([item('q1')]))
				.mockResolvedValueOnce(ok([item('q1', { paused: true })]))
				// After the restore: q1 (home already) was resumed on the host, and q3 arrived.
				.mockResolvedValue(ok([item('q1', { paused: false }), item('q3')]));
			client.turns.queue.setPaused.mockImplementation(
				async (_agentId: string, itemId: string, paused: boolean) =>
					itemId === 'q3' ? fail('rejected', 'queue locked') : ok({ found: true, paused })
			);
			const d = storedDeps(client);
			const result = await runReturnFromHost('agent-1', {}, d.value);
			expect(client.turns.queue.setPaused).not.toHaveBeenCalledWith('host-1', 'q1', false);
			expect(client.agents.remove).not.toHaveBeenCalled();
			expect(d.store.get('agent-1')?.liftedTo).toBeUndefined();
			expect(result.notices?.join(' ')).toMatch(/stopped answering before its copy was removed/);
		});

		it('a late message from a desktop host comes home held, with the image notice, though the first read had none (#2197)', async () => {
			const base = hostClient();
			base.turns.queue.list
				.mockResolvedValueOnce(ok([]))
				.mockResolvedValueOnce(ok([]))
				.mockResolvedValueOnce(ok([item('q3')]))
				.mockResolvedValue(ok([item('q3', { paused: true })]));
			const client = {
				...base,
				connection: { host: () => ({ kind: 'desktop' as const, label: 'desktop pid 1' }) },
			} as unknown as typeof base;
			const d = storedDeps(client);
			const result = await runReturnFromHost('agent-1', {}, d.value);
			const done = d.store.get('agent-1') as AgentRecord & {
				executionQueue?: Array<{ id: string; paused?: boolean }>;
			};
			expect(done.executionQueue?.map((queued) => [queued.id, queued.paused])).toEqual([
				['q3', true],
			]);
			expect(result.notices?.join(' ')).toMatch(
				/is a Maestro desktop, which does not send the images attached to queued messages\. The message from its queue waits here, held/
			);
		});

		it('a host that keeps taking messages keeps its copy, marked, and every message it took is here', async () => {
			const client = hostClient();
			// Every read lists what the host took before, plus one new message (#2199): the
			// messages it accepted are recorded here, apart from what the return reports.
			const accepted: string[] = [];
			client.turns.queue.list.mockImplementation(async () => {
				accepted.push(`n${accepted.length}`);
				return ok(accepted.map((id) => item(id)));
			});
			const d = storedDeps(client);
			const result = await runReturnFromHost('agent-1', {}, d.value);
			expect(client.agents.remove).not.toHaveBeenCalled();
			expect(result.hostCopyRemoved).toBe(false);
			expect(result.notices?.join(' ')).toMatch(/kept taking new messages, so its copy stays/);
			// The two reads before the restore, then one per pass after it.
			expect(client.turns.queue.list).toHaveBeenCalledTimes(2 + RETURN_LATE_QUEUE_PASSES);
			expect(accepted).toHaveLength(2 + RETURN_LATE_QUEUE_PASSES);
			expect(d.queueIds()).toEqual(accepted);
			const marker = d.store.get('agent-1')?.hostCopyLeft as { carried?: string[] };
			expect(new Set(marker.carried)).toEqual(new Set(accepted));
		});

		it('a late message the window could not save stays held on the host, and the copy stays', async () => {
			const client = hostClient({ queue: ok([]) });
			client.turns.queue.list
				.mockResolvedValueOnce(ok([]))
				.mockResolvedValueOnce(ok([]))
				.mockResolvedValue(ok([item('q3')]));
			const d = storedDeps(client);
			const first = d.restore.getMockImplementation();
			d.restore.mockImplementationOnce(first!).mockRejectedValueOnce(new Error('disk full'));
			const result = await runReturnFromHost('agent-1', {}, d.value);
			expect(client.turns.queue.setPaused.mock.calls).toEqual([['host-1', 'q3', true]]);
			expect(client.agents.remove).not.toHaveBeenCalled();
			expect(result.notices?.join(' ')).toMatch(/could not be saved here.*waits there, held/);
			expect(d.store.get('agent-1')?.liftedTo).toBeUndefined();
		});

		it('a message sent read-only comes home read-only; save to History comes with it', async () => {
			const client = hostClient({
				queue: ok([item('q1', { readOnly: true, readOnlyChoice: 'sender', saveToHistory: false })]),
			});
			const d = storedDeps(client);
			await runReturnFromHost('agent-1', {}, d.value);
			const queued = (
				d.store.get('agent-1') as unknown as { executionQueue: Array<Record<string, unknown>> }
			).executionQueue[0];
			expect(queued).toMatchObject({
				id: 'q1',
				turnReadOnly: true,
				readOnlyMode: true,
				turnSaveToHistory: false,
			});
			expect(queued.paused).toBeUndefined();
		});

		describe('read-only: only the sender choice lifts the tab read-only (#2199)', () => {
			const homeItem = async (from: Record<string, unknown>) => {
				const d = storedDeps(hostClient({ queue: ok([item('q1', from)]) }));
				await runReturnFromHost('agent-1', {}, d.value);
				return (
					d.store.get('agent-1') as unknown as {
						executionQueue: Array<Parameters<typeof queuedItemRunsReadOnly>[0]>;
					}
				).executionQueue[0];
			};
			const readOnlyTab = { readOnlyMode: true };
			const writableTab = { readOnlyMode: false };

			it('a message queued while the tab was writable keeps the read-only the tab has when it runs here', async () => {
				const queued = await homeItem({ readOnly: false });
				expect(queued?.turnReadOnly).toBeUndefined();
				// The tab was made read-only while the message waited: it runs read-only.
				expect(queuedItemRunsReadOnly(queued, readOnlyTab)).toBe(true);
				expect(queuedItemRunsReadOnly(queued, writableTab)).toBe(false);
			});

			it('a message the tab made read-only stays read-only, even on a writable tab here', async () => {
				const queued = await homeItem({ readOnly: true });
				expect(queued?.turnReadOnly).toBeUndefined();
				expect(queuedItemRunsReadOnly(queued, writableTab)).toBe(true);
			});

			it('a sender who chose writable for this one message keeps that choice', async () => {
				const queued = await homeItem({ readOnly: false, readOnlyChoice: 'sender' });
				expect(queued?.turnReadOnly).toBe(false);
				expect(queuedItemRunsReadOnly(queued, readOnlyTab)).toBe(false);
			});
		});

		it('a message from a host that does not say whether it was sent read-only comes home held, and says why', async () => {
			const older = { itemId: 'q1', tabId: 'tab-1', queuedAt: 10, text: 'next', paused: false };
			const client = hostClient({ queue: ok([older]) });
			const d = deps(hostedAgent(), client);
			const result = await runReturnFromHost('agent-1', {}, d.value);
			expect(d.restore.mock.calls[0][1].queue).toEqual([{ ...older, paused: true }]);
			expect(result.notices?.join(' ')).toMatch(
				/did not say whether the message from its queue was sent read-only, so it waits here, held/
			);
		});

		it('readReturnedFromHost keeps the read-only and save to History choices', () => {
			const queue = [item('q1', { readOnly: true, saveToHistory: true })];
			expect(readReturnedFromHost({ tabs: [], queue })?.queue).toEqual(queue);
		});

		it('a restore the window may still write releases nothing on the host', async () => {
			const client = hostClient({ queue: ok([item('q1')]) });
			const d = deps(hostedAgent(), client);
			d.restore.mockRejectedValue(new RestoreUnsettledError('The window did not answer in time'));
			await expect(runReturnFromHost('agent-1', {}, d.value)).rejects.toMatchObject({
				code: 'RETURN_RESTORE_FAILED',
				message: expect.stringMatching(/message it held on the host stays held there/),
			});
			expect(client.turns.queue.setPaused.mock.calls).toEqual([['host-1', 'q1', true]]);
			expect(client.agents.remove).not.toHaveBeenCalled();
		});

		// A save that failed (a full disk) is refused by the window, but main's store already took
		// the new record before its flush failed, so it reads home. That must not count as landed:
		// counting it would remove the host copy and the message it holds while nothing was saved.
		it('a restore the window refused is not taken as landed, even when the store reads home', async () => {
			const client = hostClient({ queue: ok([item('q1')]) });
			const d = deps(hostedAgent(), client);
			// Moved until the restore is tried; then the store reads home (it took the record before
			// the failed flush), as main's does.
			const homeInMemory = { ...hostedAgent(), liftedTo: undefined } as AgentRecord;
			let tried = false;
			d.value.readAgents = () => [tried ? homeInMemory : hostedAgent()];
			d.restore.mockImplementation(async () => {
				tried = true;
				throw new Error('Could not save the agent: the write did not reach the disk');
			});

			await expect(runReturnFromHost('agent-1', {}, d.value)).rejects.toMatchObject({
				code: 'RETURN_RESTORE_FAILED',
			});
			expect(client.agents.remove).not.toHaveBeenCalled();
			// The held message is released on the host, where it runs: the agent stays moved.
			expect(client.turns.queue.setPaused.mock.calls).toEqual([
				['host-1', 'q1', true],
				['host-1', 'q1', false],
			]);
		});

		it('a hold the host would not release is named beside the restore error', async () => {
			const client = hostClient({ queue: ok([item('q1')]) });
			client.turns.queue.setPaused.mockImplementation(
				async (_agentId: string, _itemId: string, paused: boolean) =>
					paused ? ok({ found: true, paused }) : fail('rejected')
			);
			const d = deps(hostedAgent(), client);
			d.restore.mockRejectedValue(new Error('window gone'));
			await expect(runReturnFromHost('agent-1', {}, d.value)).rejects.toMatchObject({
				code: 'RETURN_RESTORE_FAILED',
				message: expect.stringMatching(
					/window gone.*A message this return held on the host \(build-box:host-1\) could not be released and still waits there, held/
				),
			});
		});
	});

	it('throws a LiftRunError for an unknown agent', async () => {
		const d = deps(hostedAgent());
		await expect(runReturnFromHost('missing', {}, d.value)).rejects.toBeInstanceOf(LiftRunError);
	});
});

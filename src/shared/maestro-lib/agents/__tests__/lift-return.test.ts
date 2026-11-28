/**
 * Moving a hosted agent back from its host (`runReturnFromHost()`, `withReturnedFromHost()`): the
 * refusals, the host read, the merge by tab id, the host copy's removal, and the offline path.
 * `maestro-cli unlift` and the desktop's Move Back from Host both run these.
 */
import { describe, expect, it, vi } from 'vitest';

import type { AgentRecord, AITabRecord } from '../../store/records';
import { LiftRunError } from '../lift-run';
import {
	readReturnedFromHost,
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

const log = (id: string) => ({ id, timestamp: 1, source: 'user', text: id });

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
		expect(readReturnedFromHost({ tabs: [{ name: 'no id' }] })).toBeUndefined();
		expect(readReturnedFromHost({ tabs: 'x' })).toBeUndefined();
		expect(readReturnedFromHost(null)).toBeUndefined();
	});

	it('refuses a record that is not hosted', () => {
		expect(returnRestoreRefusal({})).toBe('Agent is not hosted');
		expect(returnRestoreRefusal(hostedAgent())).toBeUndefined();
	});
});

describe('runReturnFromHost', () => {
	it('reads the host tabs, restores here, then removes the host copy', async () => {
		const agent = hostedAgent();
		const d = deps(agent);
		const result = await runReturnFromHost('agent-1', {}, d.value);
		expect(d.connect).toHaveBeenCalledWith('remote-1', 'build-box');
		expect(d.restore).toHaveBeenCalledWith('agent-1', {
			tabs: [
				expect.objectContaining({ id: 'tab-1', logs: [log('l1'), log('l2')] }),
				expect.objectContaining({ id: 'tab-new', logs: [log('n1')] }),
			],
			activeTabId: 'tab-new',
		});
		expect(d.client.agents.remove).toHaveBeenCalledWith('host-1');
		expect(d.restore.mock.invocationCallOrder[0]).toBeLessThan(
			d.client.agents.remove.mock.invocationCallOrder[0]
		);
		expect(result).toEqual({
			agent: { id: 'agent-1', name: 'Docs' },
			from: 'build-box:host-1',
			tabs: 2,
			newTabs: 1,
			hostCopyRemoved: true,
		});
		expect(d.release).toHaveBeenCalled();
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
	});

	it('moves back offline without dialing, and keeps the host copy', async () => {
		const d = deps(hostedAgent());
		const result = await runReturnFromHost('agent-1', { offline: true }, d.value);
		expect(d.connect).not.toHaveBeenCalled();
		expect(d.restore).toHaveBeenCalledWith('agent-1', { tabs: [] });
		expect(result.hostCopyRemoved).toBe(false);
		expect(result.notices?.[0]).toMatch(/maestro-cli remove-agent host-1/);
	});

	it('throws a LiftRunError for an unknown agent', async () => {
		const d = deps(hostedAgent());
		await expect(runReturnFromHost('missing', {}, d.value)).rejects.toBeInstanceOf(LiftRunError);
	});
});

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
		turns: { queue: { list: vi.fn().mockResolvedValue(overrides.queue ?? ok([])) } },
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
			// Recorded until the removal below is confirmed (harmless once the copy is gone).
			leftOnHost: { peer: 'build-box', agentId: 'host-1', at: 1 },
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

	it('refuses a running turn or a waiting message on the host, and changes nothing', async () => {
		const busy = hostClient({
			agent: ok({ id: 'host-1', aiTabs: [{ id: 'tab-1', state: 'busy' }] }),
		});
		const queued = hostClient({ queue: ok([{ itemId: 'q1' }]) });
		for (const [client, code] of [
			[busy, 'RETURN_BUSY'],
			[queued, 'RETURN_QUEUED'],
		] as const) {
			const d = deps(hostedAgent(), client);
			await expect(runReturnFromHost('agent-1', {}, d.value)).rejects.toMatchObject({ code });
			expect(d.restore).not.toHaveBeenCalled();
			expect(client.agents.remove).not.toHaveBeenCalled();
		}
	});

	// Parity R50: a message the person held on the host comes home held, with the agent; one
	// waiting to run is still refused (it would run on both sides, or be lost).
	it('brings a held host message home held, and still refuses one waiting to run (R50)', async () => {
		const heldItem = {
			itemId: 'h1',
			tabId: 'tab-1',
			queuedAt: 7,
			kind: 'message',
			text: 'later',
			paused: true,
			turnSettings: { model: 'opus' },
		};
		const d = deps(hostedAgent(), hostClient({ queue: ok([heldItem]) }));
		await runReturnFromHost('agent-1', {}, d.value);
		const returned = d.restore.mock.calls[0][1];
		expect(returned.heldQueue).toEqual([
			{
				id: 'h1',
				tabId: 'tab-1',
				timestamp: 7,
				kind: 'message',
				text: 'later',
				turnSettings: { model: 'opus' },
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
				paused: true,
			},
		]);

		for (const [queue, options] of [
			[[heldItem, { ...heldItem, itemId: 'r1', paused: false }], {}],
			[[heldItem], { keepHostCopy: true }],
		] as const) {
			const refused = deps(hostedAgent(), hostClient({ queue: ok(queue) }));
			await expect(runReturnFromHost('agent-1', options, refused.value)).rejects.toMatchObject({
				code: 'RETURN_QUEUED',
			});
			expect(refused.restore).not.toHaveBeenCalled();
		}
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
	});

	it('moves back offline without dialing, and keeps the host copy', async () => {
		const d = deps(hostedAgent());
		const result = await runReturnFromHost('agent-1', { offline: true }, d.value);
		expect(d.connect).not.toHaveBeenCalled();
		// The copy left on the host is recorded, so a later Move to Host replaces it (T5).
		expect(d.restore).toHaveBeenCalledWith('agent-1', {
			tabs: [],
			leftOnHost: { peer: 'build-box', agentId: 'host-1', at: 1 },
		});
		expect(result.hostCopyRemoved).toBe(false);
		// A command run on this machine: `peer:agent` reaches a headless host too.
		expect(result.notices?.[0]).toContain('maestro-cli remove-agent build-box:host-1');
		expect(result.notices?.[0]).toContain('maestro-cli show agent build-box:host-1');
		expect(result.notices?.[0]).toContain('Moving the agent to the host again replaces that copy');
	});

	it('throws a LiftRunError for an unknown agent', async () => {
		const d = deps(hostedAgent());
		await expect(runReturnFromHost('missing', {}, d.value)).rejects.toBeInstanceOf(LiftRunError);
	});
});

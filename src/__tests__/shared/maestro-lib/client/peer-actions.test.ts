/**
 * Tests for `runPeerAgentAction()`, the one function maestro-cli's `peer:agent` verbs and the
 * desktop's peer mirror run to drive a host's agent, plus the IPC parser and the error wording.
 * The client is a fake: each action must make exactly the call the CLI made before it was shared.
 */

import { describe, expect, it, vi } from 'vitest';
import {
	parsePeerAgentAction,
	peerActionErrorMessage,
	runPeerAgentAction,
} from '../../../../shared/maestro-lib/client/peer-actions';
import type { ClientResult, MaestroClient } from '../../../../shared/maestro-lib/client/types';
import { buildRemoteAskerKey } from '../../../../shared/crossAgentTypes';
import type { AgentRecord } from '../../../../shared/maestro-lib/store/records';

const ok = <T>(value: T): ClientResult<T> => ({ ok: true, value });

function fakeClient() {
	const client = {
		turns: {
			send: vi.fn(async () => ok({ status: 'started' as const })),
			interrupt: vi.fn(async (_agentId: string, tabId: string) => ok({ stopped: tabId !== 't3' })),
			queue: {
				remove: vi.fn(async (_agentId: string, itemId: string) =>
					ok({ removed: itemId !== 'gone' })
				),
				setPaused: vi.fn(async (_agentId: string, itemId: string, paused: boolean) =>
					ok({ found: itemId !== 'gone', paused })
				),
				edit: vi.fn(async (_agentId: string, itemId: string) => ok({ found: itemId !== 'gone' })),
				move: vi.fn(async (_agentId: string, itemId: string) => ok({ moved: itemId !== 'gone' })),
				sendNow: vi.fn(async (_agentId: string, itemId: string) => ok({ sent: itemId !== 'gone' })),
				merge: vi.fn(async (_agentId: string, itemId: string) =>
					ok(itemId === 'gone' ? { merged: false } : { merged: true, mergedIntoId: 'q0' })
				),
				steer: vi.fn(async (_agentId: string, itemId: string) =>
					ok(
						itemId === 'gone'
							? { outcome: 'not-found' as const }
							: { outcome: 'delivered' as const, verdict: 'delivered' as const }
					)
				),
			},
		},
		tabs: {
			create: vi.fn(async () => ok({ tabId: 't-new' })),
			rename: vi.fn(async () => ok(undefined)),
			star: vi.fn(async () => ok(undefined)),
			close: vi.fn(async () => ok(undefined)),
			update: vi.fn(async () => ok(undefined)),
		},
		agents: {
			update: vi.fn(async () => ok({ applied: ['model' as const, 'nudgeMessage' as const] })),
		},
		consults: {
			ask: vi.fn(async () => ok({ answer: 'src/foo.ts', agentName: 'docs' })),
		},
		autoRun: {
			launch: vi.fn(async () => ok(undefined)),
			launchGoal: vi.fn(async () => ok({ tabId: 't-goal' })),
			stop: vi.fn(async () => ok(undefined)),
			resume: vi.fn(async () => ok(undefined)),
			skip: vi.fn(async () => ok(undefined)),
			abort: vi.fn(async () => ok(undefined)),
		},
	};
	return { client, asClient: client as unknown as MaestroClient };
}

const agent: AgentRecord = {
	id: 'a1',
	name: 'docs',
	toolType: 'claude-code',
	aiTabs: [
		{ id: 't1', state: 'busy' },
		{ id: 't2', state: 'idle' },
		{ id: 't3', state: 'busy' },
	],
};

describe('runPeerAgentAction', () => {
	it('sends with turns.send, passing a dispatch id only when given', async () => {
		const { client, asClient } = fakeClient();
		expect(
			await runPeerAgentAction(asClient, agent, { kind: 'send', tabId: 't2', text: 'hi' })
		).toEqual(ok({ kind: 'send', receipt: { status: 'started' } }));
		expect(client.turns.send).toHaveBeenCalledWith('a1', 't2', { text: 'hi' });
		await runPeerAgentAction(asClient, agent, {
			kind: 'send',
			tabId: 't2',
			text: 'hi',
			dispatchId: 'd1',
		});
		expect(client.turns.send).toHaveBeenLastCalledWith('a1', 't2', {
			text: 'hi',
			dispatchId: 'd1',
		});
	});

	it('adds the caller origin host to a send, and to no other action', async () => {
		const { client, asClient } = fakeClient();
		await runPeerAgentAction(
			asClient,
			agent,
			{ kind: 'send', tabId: 't2', text: 'hi', dispatchId: 'd1' },
			{ originHost: 'laptop.local' }
		);
		expect(client.turns.send).toHaveBeenLastCalledWith('a1', 't2', {
			text: 'hi',
			dispatchId: 'd1',
			originHost: 'laptop.local',
		});
		// An empty origin is left out.
		await runPeerAgentAction(
			asClient,
			agent,
			{ kind: 'send', tabId: 't2', text: 'hi' },
			{ originHost: '' }
		);
		expect(client.turns.send).toHaveBeenLastCalledWith('a1', 't2', { text: 'hi' });
		await runPeerAgentAction(
			asClient,
			agent,
			{ kind: 'rename-tab', tabId: 't2', name: 'Plan' },
			{ originHost: 'laptop.local' }
		);
		expect(client.tabs.rename).toHaveBeenLastCalledWith('a1', 't2', 'Plan');
	});

	it("passes the sender's own tab choices with the send, and leaves them off when there are none", async () => {
		const { client, asClient } = fakeClient();
		const overrides = { model: 'opus', effort: 'high', readOnly: true, saveToHistory: false };
		await runPeerAgentAction(asClient, agent, { kind: 'send', tabId: 't2', text: 'hi', overrides });
		expect(client.turns.send).toHaveBeenLastCalledWith('a1', 't2', { text: 'hi', overrides });
		await runPeerAgentAction(asClient, agent, { kind: 'send', tabId: 't2', text: 'again' });
		expect(client.turns.send).toHaveBeenLastCalledWith('a1', 't2', { text: 'again' });
		// The overrides ride on the message only: nothing touches the host tab.
		expect(client.tabs.update).not.toHaveBeenCalled();
	});

	it('stops every busy tab without a tab, and reports which ones stopped', async () => {
		const { client, asClient } = fakeClient();
		expect(await runPeerAgentAction(asClient, agent, { kind: 'interrupt' })).toEqual(
			ok({ kind: 'interrupt', targetTabIds: ['t1', 't3'], stoppedTabIds: ['t1'] })
		);
		expect(client.turns.interrupt.mock.calls.map((call) => call[1])).toEqual(['t1', 't3']);
	});

	it('stops only the named tab, busy or not', async () => {
		const { client, asClient } = fakeClient();
		expect(await runPeerAgentAction(asClient, agent, { kind: 'interrupt', tabId: 't2' })).toEqual(
			ok({ kind: 'interrupt', targetTabIds: ['t2'], stoppedTabIds: ['t2'] })
		);
		expect(client.turns.interrupt).toHaveBeenCalledTimes(1);
	});

	it('stops at the first failed interrupt and returns the client error as is', async () => {
		const { client, asClient } = fakeClient();
		const failure = {
			ok: false as const,
			error: { code: 'host-lost' as const, message: 'dropped', method: 'turns.interrupt' as const },
		};
		client.turns.interrupt.mockResolvedValueOnce(failure as never);
		expect(await runPeerAgentAction(asClient, agent, { kind: 'interrupt' })).toEqual(failure);
		expect(client.turns.interrupt).toHaveBeenCalledTimes(1);
	});

	it('opens, renames, and stars tabs with the tab calls', async () => {
		const { client, asClient } = fakeClient();
		expect(await runPeerAgentAction(asClient, agent, { kind: 'new-tab' })).toEqual(
			ok({ kind: 'new-tab', tabId: 't-new' })
		);
		expect(client.tabs.create).toHaveBeenCalledWith('a1');
		expect(
			await runPeerAgentAction(asClient, agent, { kind: 'rename-tab', tabId: 't1', name: 'Plan' })
		).toEqual(ok({ kind: 'rename-tab', tabId: 't1' }));
		expect(client.tabs.rename).toHaveBeenCalledWith('a1', 't1', 'Plan');
		expect(
			await runPeerAgentAction(asClient, agent, { kind: 'star-tab', tabId: 't1', starred: false })
		).toEqual(ok({ kind: 'star-tab', tabId: 't1', starred: false }));
		expect(client.tabs.star).toHaveBeenCalledWith('a1', 't1', false);
		expect(await runPeerAgentAction(asClient, agent, { kind: 'close-tab', tabId: 't2' })).toEqual(
			ok({ kind: 'close-tab', tabId: 't2' })
		);
		expect(client.tabs.close).toHaveBeenCalledWith('a1', 't2');
	});

	it('sends the images with turns.send, and none when the list is empty', async () => {
		const { client, asClient } = fakeClient();
		const png = 'data:image/png;base64,AAAA';
		await runPeerAgentAction(asClient, agent, {
			kind: 'send',
			tabId: 't2',
			text: '',
			images: [png],
		});
		expect(client.turns.send).toHaveBeenLastCalledWith('a1', 't2', { text: '', images: [png] });
		await runPeerAgentAction(asClient, agent, {
			kind: 'send',
			tabId: 't2',
			text: 'hi',
			images: [],
		});
		expect(client.turns.send).toHaveBeenLastCalledWith('a1', 't2', { text: 'hi' });
	});

	it('changes the agent settings with agents.update and reports what the host applied', async () => {
		const { client, asClient } = fakeClient();
		const patch = { model: 'opus', nudgeMessage: null };
		expect(await runPeerAgentAction(asClient, agent, { kind: 'update-agent', patch })).toEqual(
			ok({ kind: 'update-agent', applied: ['model', 'nudgeMessage'] })
		);
		expect(client.agents.update).toHaveBeenCalledWith('a1', patch);
		client.agents.update.mockResolvedValueOnce(
			ok({ applied: ['provider'], notices: ['Parked 2 tabs'] }) as never
		);
		expect(
			await runPeerAgentAction(asClient, agent, {
				kind: 'update-agent',
				patch: { provider: 'codex' },
			})
		).toEqual(ok({ kind: 'update-agent', applied: ['provider'], notices: ['Parked 2 tabs'] }));
	});

	it('changes a tab with tabs.update, and passes a refusal through with its applied fields', async () => {
		const { client, asClient } = fakeClient();
		expect(
			await runPeerAgentAction(asClient, agent, {
				kind: 'update-tab',
				tabId: 't2',
				patch: { readOnly: true, model: null },
			})
		).toEqual(ok({ kind: 'update-tab', tabId: 't2' }));
		expect(client.tabs.update).toHaveBeenCalledWith('a1', 't2', { readOnly: true, model: null });
		const refusal = {
			ok: false as const,
			error: {
				code: 'rejected' as const,
				message: 'busy',
				method: 'agents.update' as const,
				appliedFields: ['model' as const],
			},
		};
		client.agents.update.mockResolvedValueOnce(refusal as never);
		expect(
			await runPeerAgentAction(asClient, agent, {
				kind: 'update-agent',
				patch: { model: 'opus', cwd: '/srv' },
			})
		).toBe(refusal);
	});

	it('removes a waiting message with turns.queue.remove and reports whether it was there', async () => {
		const { client, asClient } = fakeClient();
		expect(
			await runPeerAgentAction(asClient, agent, { kind: 'remove-queued', itemId: 'q1' })
		).toEqual(ok({ kind: 'remove-queued', itemId: 'q1', removed: true }));
		expect(client.turns.queue.remove).toHaveBeenCalledWith('a1', 'q1');
		expect(
			await runPeerAgentAction(asClient, agent, { kind: 'remove-queued', itemId: 'gone' })
		).toEqual(ok({ kind: 'remove-queued', itemId: 'gone', removed: false }));
	});

	it('holds and resumes a waiting message with turns.queue.setPaused', async () => {
		const { client, asClient } = fakeClient();
		expect(
			await runPeerAgentAction(asClient, agent, {
				kind: 'pause-queued',
				itemId: 'q1',
				paused: true,
			})
		).toEqual(ok({ kind: 'pause-queued', itemId: 'q1', found: true, paused: true }));
		expect(client.turns.queue.setPaused).toHaveBeenCalledWith('a1', 'q1', true);
		expect(
			await runPeerAgentAction(asClient, agent, {
				kind: 'pause-queued',
				itemId: 'gone',
				paused: false,
			})
		).toEqual(ok({ kind: 'pause-queued', itemId: 'gone', found: false, paused: false }));
	});

	it('merges a waiting message into the one above it on the host', async () => {
		const { client, asClient } = fakeClient();
		expect(
			await runPeerAgentAction(asClient, agent, { kind: 'merge-queued', itemId: 'q1' })
		).toEqual(ok({ kind: 'merge-queued', itemId: 'q1', merged: true, mergedIntoId: 'q0' }));
		expect(client.turns.queue.merge).toHaveBeenCalledWith('a1', 'q1');
		expect(
			await runPeerAgentAction(asClient, agent, { kind: 'merge-queued', itemId: 'gone' })
		).toEqual(ok({ kind: 'merge-queued', itemId: 'gone', merged: false }));
	});

	it("steers a waiting message on the host and hands back the host's outcome", async () => {
		const { client, asClient } = fakeClient();
		expect(
			await runPeerAgentAction(asClient, agent, { kind: 'steer-queued', itemId: 'q1' })
		).toEqual(
			ok({
				kind: 'steer-queued',
				itemId: 'q1',
				result: { outcome: 'delivered', verdict: 'delivered' },
			})
		);
		expect(client.turns.queue.steer).toHaveBeenCalledWith('a1', 'q1');
		expect(
			await runPeerAgentAction(asClient, agent, { kind: 'steer-queued', itemId: 'gone' })
		).toEqual(ok({ kind: 'steer-queued', itemId: 'gone', result: { outcome: 'not-found' } }));
	});

	it("asks a /btw side question of the host's tab, as `ask --btw` does", async () => {
		const { client, asClient } = fakeClient();
		expect(
			await runPeerAgentAction(asClient, agent, {
				kind: 'side-question',
				tabId: 't1',
				question: 'which file?',
			})
		).toEqual(ok({ kind: 'side-question', tabId: 't1', answer: 'src/foo.ts' }));
		expect(client.consults.ask).toHaveBeenCalledWith({
			targetAgentId: 'a1',
			question: 'which file?',
			sideQuestion: true,
			targetTabId: 't1',
		});
	});

	it('consults the host agent for an asker on another machine, with its context and name', async () => {
		const { client, asClient } = fakeClient();
		const transcript = [{ source: 'user', text: 'we drop events', timestamp: 1 }];
		client.consults.ask.mockResolvedValueOnce({
			ok: true,
			value: { answer: 'Use a queue.', agentName: 'Docs' },
		});
		expect(
			await runPeerAgentAction(asClient, agent, {
				kind: 'consult',
				question: 'how do we buffer?',
				transcript,
				fromAgentName: 'Source',
				handoffAnswer: 'the plan',
			})
		).toEqual(ok({ kind: 'consult', answer: 'Use a queue.', agentName: 'Docs' }));
		expect(client.consults.ask).toHaveBeenCalledWith({
			targetAgentId: 'a1',
			question: 'how do we buffer?',
			transcript,
			fromAgentName: 'Source',
			handoffAnswer: 'the plan',
		});
	});

	it('names the asker to the host by (this machine, asking agent, asking tab), for its own consult tab', async () => {
		const { client, asClient } = fakeClient();
		client.consults.ask.mockResolvedValue({ ok: true, value: { answer: 'a' } });
		await runPeerAgentAction(
			asClient,
			agent,
			{ kind: 'consult', question: 'q', asker: { agentId: 'src', tabId: 'tab-1' } },
			{ originHost: 'laptop' }
		);
		expect(client.consults.ask).toHaveBeenCalledWith({
			targetAgentId: 'a1',
			question: 'q',
			askerKey: buildRemoteAskerKey({ machine: 'laptop', agentId: 'src', tabId: 'tab-1' }),
		});
	});

	it('carries Stop to the host for the consults that asker has running there (G1)', async () => {
		const { client, asClient } = fakeClient();
		const cancel = vi.fn().mockResolvedValue({ ok: true, value: { canceled: 1 } });
		(client.consults as unknown as { cancel: typeof cancel }).cancel = cancel;
		expect(
			await runPeerAgentAction(
				asClient,
				agent,
				{ kind: 'consult-cancel', asker: { agentId: 'src', tabId: 'tab-1' } },
				{ originHost: 'laptop' }
			)
		).toEqual(ok({ kind: 'consult-cancel', canceled: 1 }));
		expect(cancel).toHaveBeenCalledWith({
			askerKey: buildRemoteAskerKey({ machine: 'laptop', agentId: 'src', tabId: 'tab-1' }),
		});
		expect(
			parsePeerAgentAction({ kind: 'consult-cancel', asker: { agentId: 'a', tabId: 't' } })
		).toEqual({ kind: 'consult-cancel', asker: { agentId: 'a', tabId: 't' } });
		expect(() => parsePeerAgentAction({ kind: 'consult-cancel' })).toThrow('Missing asker');
	});

	it('answers unsupported for Stop on a host client with no consult cancel', async () => {
		const { asClient } = fakeClient();
		const stopped = await runPeerAgentAction(asClient, agent, {
			kind: 'consult-cancel',
			asker: { agentId: 'src', tabId: 'tab-1' },
		});
		expect(stopped.ok).toBe(false);
		if (!stopped.ok) expect(stopped.error.code).toBe('unsupported');
	});

	it('reads the host closed-tab stack bounded, and reopens one there (G5)', async () => {
		const { client, asClient } = fakeClient();
		const tabs = client.tabs as unknown as Record<string, unknown>;
		tabs.closed = vi.fn(async () =>
			ok([
				{ index: 7, type: 'ai', label: 'Tax', tabId: 'h-tax', closedAt: 5, agentSessionId: 's1' },
				{ type: 'bogus', tabId: 'x' },
			])
		);
		tabs.reopen = vi.fn(async () => ok({ tabId: 'h-tax' }));
		expect(await runPeerAgentAction(asClient, agent, { kind: 'closed-tabs' })).toEqual(
			ok({
				kind: 'closed-tabs',
				closedTabs: [
					{ index: 0, type: 'ai', label: 'Tax', tabId: 'h-tax', closedAt: 5, agentSessionId: 's1' },
				],
			})
		);
		expect(
			await runPeerAgentAction(asClient, agent, { kind: 'reopen-tab', tabId: 'h-tax' })
		).toEqual(ok({ kind: 'reopen-tab', tabId: 'h-tax' }));
		expect(tabs.reopen).toHaveBeenCalledWith('a1', { tabId: 'h-tax' });
		expect(parsePeerAgentAction({ kind: 'reopen-tab' })).toEqual({ kind: 'reopen-tab', index: 0 });
		expect(() => parsePeerAgentAction({ kind: 'reopen-tab', index: -1 })).toThrow();
		expect(parsePeerAgentAction({ kind: 'closed-tabs', extra: 1 })).toEqual({
			kind: 'closed-tabs',
		});
	});

	it('answers unsupported for closed tabs on a host client that keeps none', async () => {
		const { asClient } = fakeClient();
		const read = await runPeerAgentAction(asClient, agent, { kind: 'closed-tabs' });
		expect(read.ok).toBe(false);
		if (!read.ok) expect(read.error.code).toBe('unsupported');
	});

	it('edits a waiting message on the host', async () => {
		const { client, asClient } = fakeClient();
		const edit = { text: 'new', turnSettings: { model: 'm' } };
		expect(
			await runPeerAgentAction(asClient, agent, { kind: 'edit-queued', itemId: 'q1', edit })
		).toEqual(ok({ kind: 'edit-queued', itemId: 'q1', found: true }));
		expect(client.turns.queue.edit).toHaveBeenCalledWith('a1', 'q1', edit);
		expect(
			await runPeerAgentAction(asClient, agent, { kind: 'edit-queued', itemId: 'gone', edit })
		).toEqual(ok({ kind: 'edit-queued', itemId: 'gone', found: false }));
	});

	it('moves a waiting message on the host, in its tab when one is named', async () => {
		const { client, asClient } = fakeClient();
		expect(
			await runPeerAgentAction(asClient, agent, {
				kind: 'move-queued',
				itemId: 'q1',
				toIndex: 0,
				tabId: 't1',
			})
		).toEqual(ok({ kind: 'move-queued', itemId: 'q1', moved: true }));
		expect(client.turns.queue.move).toHaveBeenCalledWith('a1', 'q1', 0, 't1');
		expect(
			await runPeerAgentAction(asClient, agent, { kind: 'move-queued', itemId: 'gone', toIndex: 1 })
		).toEqual(ok({ kind: 'move-queued', itemId: 'gone', moved: false }));
		expect(client.turns.queue.move).toHaveBeenLastCalledWith('a1', 'gone', 1, undefined);
	});

	it('sends a waiting message now on the host', async () => {
		const { client, asClient } = fakeClient();
		expect(
			await runPeerAgentAction(asClient, agent, { kind: 'send-now-queued', itemId: 'q1' })
		).toEqual(ok({ kind: 'send-now-queued', itemId: 'q1', sent: true }));
		expect(client.turns.queue.sendNow).toHaveBeenCalledWith('a1', 'q1');
		expect(
			await runPeerAgentAction(asClient, agent, { kind: 'send-now-queued', itemId: 'gone' })
		).toEqual(ok({ kind: 'send-now-queued', itemId: 'gone', sent: false }));
	});

	it('passes a failed queue call through untouched', async () => {
		const { client, asClient } = fakeClient();
		const failure = {
			ok: false as const,
			error: { code: 'not-found' as const, message: 'No agent a1.', method: 'turns.queue.remove' },
		};
		client.turns.queue.remove.mockResolvedValueOnce(failure as never);
		expect(
			await runPeerAgentAction(asClient, agent, { kind: 'remove-queued', itemId: 'q1' })
		).toEqual(failure);
		const paused = { ...failure, error: { ...failure.error, method: 'turns.queue.setPaused' } };
		client.turns.queue.setPaused.mockResolvedValueOnce(paused as never);
		expect(
			await runPeerAgentAction(asClient, agent, {
				kind: 'pause-queued',
				itemId: 'q1',
				paused: true,
			})
		).toEqual(paused);
	});

	it('passes a refused send through untouched, so the caller keeps its unknown flag', async () => {
		const { client, asClient } = fakeClient();
		const refused = {
			ok: false as const,
			error: {
				code: 'host-unavailable' as const,
				message: 'Not connected to a Maestro desktop.',
				method: 'turns.send' as const,
			},
		};
		client.turns.send.mockResolvedValueOnce(refused as never);
		expect(
			await runPeerAgentAction(asClient, agent, { kind: 'send', tabId: 't1', text: 'x' })
		).toEqual(refused);
	});
});

describe('parsePeerAgentAction', () => {
	it('keeps only the fields each kind takes', () => {
		expect(parsePeerAgentAction({ kind: 'new-tab', tabId: 'ignored' })).toEqual({
			kind: 'new-tab',
		});
		expect(parsePeerAgentAction({ kind: 'interrupt' })).toEqual({ kind: 'interrupt' });
		expect(parsePeerAgentAction({ kind: 'interrupt', tabId: 't1' })).toEqual({
			kind: 'interrupt',
			tabId: 't1',
		});
		expect(
			parsePeerAgentAction({ kind: 'send', tabId: 't1', text: ' hi ', name: 'ignored' })
		).toEqual({ kind: 'send', tabId: 't1', text: ' hi ' });
		expect(parsePeerAgentAction({ kind: 'rename-tab', tabId: 't1', name: ' Plan ' })).toEqual({
			kind: 'rename-tab',
			tabId: 't1',
			name: 'Plan',
		});
		expect(parsePeerAgentAction({ kind: 'rename-tab', tabId: 't1', name: '' })).toEqual({
			kind: 'rename-tab',
			tabId: 't1',
			name: '',
		});
		expect(parsePeerAgentAction({ kind: 'remove-queued', itemId: 'q1', tabId: 't1' })).toEqual({
			kind: 'remove-queued',
			itemId: 'q1',
		});
		expect(parsePeerAgentAction({ kind: 'pause-queued', itemId: 'q1', paused: false })).toEqual({
			kind: 'pause-queued',
			itemId: 'q1',
			paused: false,
		});
		expect(parsePeerAgentAction({ kind: 'merge-queued', itemId: 'q1', extra: 1 })).toEqual({
			kind: 'merge-queued',
			itemId: 'q1',
		});
		expect(
			parsePeerAgentAction({
				kind: 'edit-queued',
				itemId: 'q1',
				edit: { text: 'new', turnSettings: { model: 'm', extra: 1 }, images: [] },
			})
		).toEqual({
			kind: 'edit-queued',
			itemId: 'q1',
			edit: { text: 'new', turnSettings: { model: 'm' }, images: [] },
		});
		expect(
			parsePeerAgentAction({ kind: 'edit-queued', itemId: 'q1', edit: { text: 'only text' } })
		).toEqual({ kind: 'edit-queued', itemId: 'q1', edit: { text: 'only text' } });
		expect(
			parsePeerAgentAction({ kind: 'move-queued', itemId: 'q1', toIndex: 2, tabId: 't1', x: 1 })
		).toEqual({ kind: 'move-queued', itemId: 'q1', toIndex: 2, tabId: 't1' });
		expect(parsePeerAgentAction({ kind: 'move-queued', itemId: 'q1', toIndex: 0 })).toEqual({
			kind: 'move-queued',
			itemId: 'q1',
			toIndex: 0,
		});
		expect(parsePeerAgentAction({ kind: 'send-now-queued', itemId: 'q1', extra: 1 })).toEqual({
			kind: 'send-now-queued',
			itemId: 'q1',
		});
		expect(parsePeerAgentAction({ kind: 'steer-queued', itemId: 'q1', extra: 1 })).toEqual({
			kind: 'steer-queued',
			itemId: 'q1',
		});
		expect(
			parsePeerAgentAction({ kind: 'side-question', tabId: 't1', question: '  which file? ' })
		).toEqual({ kind: 'side-question', tabId: 't1', question: 'which file?' });
		expect(
			parsePeerAgentAction({
				kind: 'consult',
				question: ' how? ',
				transcript: [{ source: 'user', text: 'hi', timestamp: 1 }, { text: 'no source' }, 'junk'],
				fromAgentName: ' Source ',
				handoffAnswer: '',
			})
		).toEqual({
			kind: 'consult',
			question: 'how?',
			transcript: [{ source: 'user', text: 'hi', timestamp: 1 }],
			fromAgentName: 'Source',
			handoffAnswer: '',
		});
		expect(parsePeerAgentAction({ kind: 'consult', question: 'how?', transcript: [] })).toEqual({
			kind: 'consult',
			question: 'how?',
		});
		expect(
			parsePeerAgentAction({
				kind: 'consult',
				question: 'how?',
				asker: { agentId: 'src', tabId: 'tab-1', extra: 1 },
				askerKey: 'forged/key/here',
			})
		).toEqual({ kind: 'consult', question: 'how?', asker: { agentId: 'src', tabId: 'tab-1' } });
		expect(
			parsePeerAgentAction({ kind: 'consult', question: 'how?', asker: { agentId: 'src' } })
		).toEqual({ kind: 'consult', question: 'how?' });
		expect(
			parsePeerAgentAction({
				kind: 'update-agent',
				patch: {
					model: null,
					nudgeMessage: 'keep going',
					env: { FOO: 'bar' },
					contextWindow: 200000,
					codexTransport: 'app-server',
					bookmarked: true,
					effort: undefined,
				},
			})
		).toEqual({
			kind: 'update-agent',
			patch: {
				model: null,
				nudgeMessage: 'keep going',
				env: { FOO: 'bar' },
				contextWindow: 200000,
				codexTransport: 'app-server',
				bookmarked: true,
			},
		});
		expect(
			parsePeerAgentAction({
				kind: 'update-tab',
				tabId: 't1',
				patch: { thinking: 'sticky', enterToSend: null, saveToHistory: false },
			})
		).toEqual({
			kind: 'update-tab',
			tabId: 't1',
			patch: { thinking: 'sticky', enterToSend: null, saveToHistory: false },
		});
		// A wizard that ran on the laptop hands the host tab its provider session.
		expect(
			parsePeerAgentAction({
				kind: 'update-tab',
				tabId: 't1',
				patch: { agentSessionId: 'wizard-session' },
			})
		).toEqual({ kind: 'update-tab', tabId: 't1', patch: { agentSessionId: 'wizard-session' } });
		// A merge into a hosted tab hands the host the context for the tab's next turn.
		expect(
			parsePeerAgentAction({
				kind: 'update-tab',
				tabId: 't1',
				patch: { mergedContext: 'Additional context' },
			})
		).toEqual({ kind: 'update-tab', tabId: 't1', patch: { mergedContext: 'Additional context' } });
	});

	it('refuses a settings patch with an unknown field, a bad value, or nothing in it', () => {
		expect(() => parsePeerAgentAction({ kind: 'update-agent' })).toThrow('Missing agent settings');
		expect(() => parsePeerAgentAction({ kind: 'update-agent', patch: {} })).toThrow(
			'changes nothing'
		);
		expect(() =>
			parsePeerAgentAction({ kind: 'update-agent', patch: { ssh: { enabled: false } } })
		).toThrow('Unknown agent settings field: ssh');
		expect(() => parsePeerAgentAction({ kind: 'update-agent', patch: { name: '' } })).toThrow(
			"Invalid value for agent settings field 'name'"
		);
		expect(() =>
			parsePeerAgentAction({ kind: 'update-agent', patch: { env: { FOO: 1 } } })
		).toThrow("Invalid value for agent settings field 'env'");
		expect(() =>
			parsePeerAgentAction({ kind: 'update-agent', patch: { codexTransport: 'pipe' } })
		).toThrow("Invalid value for agent settings field 'codexTransport'");
		expect(() =>
			parsePeerAgentAction({ kind: 'update-agent', patch: { contextWindow: -1 } })
		).toThrow("Invalid value for agent settings field 'contextWindow'");
		expect(() => parsePeerAgentAction({ kind: 'update-tab', patch: { readOnly: true } })).toThrow(
			'Missing tab id'
		);
		expect(() =>
			parsePeerAgentAction({ kind: 'update-tab', tabId: 't1', patch: { thinking: 'loud' } })
		).toThrow("Invalid value for tab settings field 'thinking'");
		expect(() =>
			parsePeerAgentAction({ kind: 'update-tab', tabId: 't1', patch: { name: 'x' } })
		).toThrow('Unknown tab settings field: name');
		expect(() =>
			parsePeerAgentAction({ kind: 'update-tab', tabId: 't1', patch: { agentSessionId: '' } })
		).toThrow("Invalid value for tab settings field 'agentSessionId'");
		expect(() =>
			parsePeerAgentAction({ kind: 'update-tab', tabId: 't1', patch: { mergedContext: '' } })
		).toThrow("Invalid value for tab settings field 'mergedContext'");
	});

	it('carries Queue Held through to turns.send, and reads it only as a strict true', async () => {
		const { client, asClient } = fakeClient();
		await runPeerAgentAction(asClient, agent, {
			kind: 'send',
			tabId: 't2',
			text: 'later',
			held: true,
		});
		expect(client.turns.send).toHaveBeenLastCalledWith('a1', 't2', { text: 'later', held: true });
		expect(parsePeerAgentAction({ kind: 'send', tabId: 't1', text: 'hi', held: true })).toEqual({
			kind: 'send',
			tabId: 't1',
			text: 'hi',
			held: true,
		});
		for (const notHeld of [false, 'yes', 1]) {
			expect(
				parsePeerAgentAction({ kind: 'send', tabId: 't1', text: 'hi', held: notHeld })
			).toEqual({ kind: 'send', tabId: 't1', text: 'hi' });
		}
	});

	it('reads a send with turn overrides: checked fields kept, an empty set dropped', () => {
		expect(
			parsePeerAgentAction({
				kind: 'send',
				tabId: 't1',
				text: 'hi',
				overrides: { model: 'opus', effort: 'high', readOnly: false, saveToHistory: true },
			})
		).toEqual({
			kind: 'send',
			tabId: 't1',
			text: 'hi',
			overrides: { model: 'opus', effort: 'high', readOnly: false, saveToHistory: true },
		});
		expect(
			parsePeerAgentAction({ kind: 'send', tabId: 't1', text: 'hi', overrides: { readOnly: true } })
		).toEqual({ kind: 'send', tabId: 't1', text: 'hi', overrides: { readOnly: true } });
		for (const empty of [{}, { model: undefined }, null]) {
			expect(
				parsePeerAgentAction({ kind: 'send', tabId: 't1', text: 'hi', overrides: empty })
			).toEqual({ kind: 'send', tabId: 't1', text: 'hi' });
		}
	});

	it('refuses turn overrides with an unknown field or a bad value', () => {
		const send = (overrides: unknown) => () =>
			parsePeerAgentAction({ kind: 'send', tabId: 't1', text: 'hi', overrides });
		expect(send({ thinking: 'on' })).toThrow('Unknown turn overrides field: thinking');
		expect(send({ model: '  ' })).toThrow("Invalid value for turn overrides field 'model'");
		expect(send({ effort: 3 })).toThrow("Invalid value for turn overrides field 'effort'");
		expect(send({ readOnly: 'yes' })).toThrow("Invalid value for turn overrides field 'readOnly'");
		expect(send({ saveToHistory: 1 })).toThrow(
			"Invalid value for turn overrides field 'saveToHistory'"
		);
		expect(send('opus')).toThrow('Invalid turn overrides');
		expect(send(['opus'])).toThrow('Invalid turn overrides');
	});

	it('reads a close and a send that carries images, even with no text', () => {
		expect(parsePeerAgentAction({ kind: 'close-tab', tabId: 't1', extra: 1 })).toEqual({
			kind: 'close-tab',
			tabId: 't1',
		});
		const png = 'data:image/png;base64,AAAA';
		expect(parsePeerAgentAction({ kind: 'send', tabId: 't1', text: '', images: [png] })).toEqual({
			kind: 'send',
			tabId: 't1',
			text: '',
			images: [png],
		});
	});

	it('refuses what no host call can take', () => {
		expect(() => parsePeerAgentAction(null)).toThrow('Missing action');
		expect(() => parsePeerAgentAction({ kind: 'delete-agent' })).toThrow(
			'Unknown action: delete-agent'
		);
		expect(() => parsePeerAgentAction({ kind: 'close-tab' })).toThrow('Missing tab id');
		expect(() =>
			parsePeerAgentAction({ kind: 'send', tabId: 't1', text: 'hi', images: 'x' })
		).toThrow('images must be a list of data URLs');
		expect(() =>
			parsePeerAgentAction({ kind: 'send', tabId: 't1', text: 'hi', images: ['/etc/passwd'] })
		).toThrow('images must be a list of data URLs');
		expect(() => parsePeerAgentAction({ kind: 'send', tabId: 't1', text: '', images: [] })).toThrow(
			'nothing to send'
		);
		expect(() => parsePeerAgentAction({ kind: 'send', text: 'hi' })).toThrow('Missing tab id');
		expect(() => parsePeerAgentAction({ kind: 'send', tabId: 't1', text: '   ' })).toThrow(
			'nothing to send'
		);
		expect(() => parsePeerAgentAction({ kind: 'interrupt', tabId: '' })).toThrow('Missing tab id');
		expect(() => parsePeerAgentAction({ kind: 'rename-tab', tabId: 't1' })).toThrow(
			'Missing tab name'
		);
		expect(() => parsePeerAgentAction({ kind: 'star-tab', tabId: 't1', starred: 'yes' })).toThrow(
			'starred must be true or false'
		);
		expect(() => parsePeerAgentAction({ kind: 'remove-queued' })).toThrow('Missing queued item id');
		expect(() => parsePeerAgentAction({ kind: 'remove-queued', itemId: '' })).toThrow(
			'Missing queued item id'
		);
		expect(() => parsePeerAgentAction({ kind: 'pause-queued', paused: true })).toThrow(
			'Missing queued item id'
		);
		expect(() => parsePeerAgentAction({ kind: 'merge-queued' })).toThrow('Missing queued item id');
		expect(() =>
			parsePeerAgentAction({ kind: 'edit-queued', itemId: 'q1', edit: { text: ' ' } })
		).toThrow('Missing text');
		expect(() =>
			parsePeerAgentAction({
				kind: 'edit-queued',
				itemId: 'q1',
				edit: { text: 'x', images: ['/tmp/a.png'] },
			})
		).toThrow('images must be a list of data URLs');
		expect(() => parsePeerAgentAction({ kind: 'steer-queued' })).toThrow('Missing queued item id');
		expect(() =>
			parsePeerAgentAction({ kind: 'side-question', tabId: 't1', question: ' ' })
		).toThrow('The question is empty.');
		expect(() => parsePeerAgentAction({ kind: 'consult', question: ' ' })).toThrow(
			'The question is empty.'
		);
		expect(() => parsePeerAgentAction({ kind: 'side-question', question: 'q' })).toThrow(
			'Missing tab id'
		);
		expect(() => parsePeerAgentAction({ kind: 'send-now-queued' })).toThrow(
			'Missing queued item id'
		);
		expect(() => parsePeerAgentAction({ kind: 'move-queued', toIndex: 0 })).toThrow(
			'Missing queued item id'
		);
		for (const toIndex of [-1, 0.5, '2', undefined]) {
			expect(() => parsePeerAgentAction({ kind: 'move-queued', itemId: 'q1', toIndex })).toThrow(
				'toIndex must be a whole number, 0 or more'
			);
		}
		expect(() =>
			parsePeerAgentAction({ kind: 'pause-queued', itemId: 'q1', paused: 'yes' })
		).toThrow('paused must be true or false');
		expect(() => parsePeerAgentAction({ kind: 'pause-queued', itemId: 'q1' })).toThrow(
			'paused must be true or false'
		);
	});
});

describe('peerActionErrorMessage', () => {
	it('says nothing was sent when the client is not attached', () => {
		expect(
			peerActionErrorMessage('build', { code: 'host-unavailable', message: 'Not connected.' })
		).toBe('Not connected to peer "build". Nothing was sent. Not connected.');
	});

	it('claims neither way when the connection dropped mid-call', () => {
		expect(peerActionErrorMessage('build', { code: 'host-lost', message: 'Socket closed.' })).toBe(
			'The connection to peer "build" dropped. Socket closed.'
		);
	});

	it('names the peer for a host refusal', () => {
		expect(peerActionErrorMessage('build', { code: 'not-found', message: 'No such tab' })).toBe(
			'Peer "build": No such tab'
		);
	});
});

describe('Auto Run actions', () => {
	const launch = { documents: [{ file: '/docs/phase-1.md' }], prompt: 'Work it' };

	it('starts a run with autoRun.launch and a goal run with autoRun.launchGoal', async () => {
		const { client, asClient } = fakeClient();
		expect(await runPeerAgentAction(asClient, agent, { kind: 'auto-run', launch })).toEqual(
			ok({ kind: 'auto-run' })
		);
		expect(client.autoRun.launch).toHaveBeenCalledWith('a1', launch);
		const goal = { goal: 'Ship it', maxIterations: null };
		expect(await runPeerAgentAction(asClient, agent, { kind: 'goal-run', launch: goal })).toEqual(
			ok({ kind: 'goal-run', tabId: 't-goal' })
		);
		expect(client.autoRun.launchGoal).toHaveBeenCalledWith('a1', goal);
	});

	it.each(['stop', 'resume', 'skip', 'abort'] as const)(
		'sends the %s control to the same client method',
		async (control) => {
			const { client, asClient } = fakeClient();
			expect(
				await runPeerAgentAction(asClient, agent, { kind: 'auto-run-control', control })
			).toEqual(ok({ kind: 'auto-run-control', control }));
			expect(client.autoRun[control]).toHaveBeenCalledWith('a1');
		}
	);

	it('reads a launch that crossed IPC, checked by the launch rules', () => {
		expect(
			parsePeerAgentAction({
				kind: 'auto-run',
				launch: {
					documents: [{ file: '/docs/a.md', resetOnCompletion: true, extra: 1 }],
					loop: true,
					maxLoops: 2,
					model: ' ',
					prompt: 'Go',
				},
			})
		).toEqual({
			kind: 'auto-run',
			launch: {
				documents: [{ file: '/docs/a.md', resetOnCompletion: true }],
				loop: true,
				maxLoops: 2,
				prompt: 'Go',
			},
		});
		expect(
			parsePeerAgentAction({
				kind: 'goal-run',
				launch: { goal: ' Ship ', exitCriteria: '', maxIterations: null },
			})
		).toEqual({ kind: 'goal-run', launch: { goal: 'Ship', maxIterations: null } });
		expect(parsePeerAgentAction({ kind: 'auto-run-control', control: 'skip' })).toEqual({
			kind: 'auto-run-control',
			control: 'skip',
		});
	});

	it('refuses a bad launch or control before any host call', () => {
		expect(() => parsePeerAgentAction({ kind: 'auto-run' })).toThrow('Missing launch');
		expect(() => parsePeerAgentAction({ kind: 'auto-run', launch: { documents: 'a' } })).toThrow(
			'documents must be a list'
		);
		expect(() => parsePeerAgentAction({ kind: 'auto-run', launch: { documents: [] } })).toThrow(
			'Pick at least one document.'
		);
		expect(() =>
			parsePeerAgentAction({ kind: 'auto-run', launch: { documents: [{ file: 3 }] } })
		).toThrow('A document has no file.');
		expect(() =>
			parsePeerAgentAction({
				kind: 'auto-run',
				launch: { documents: [{ file: '/a.md' }], maxLoops: '2' },
			})
		).toThrow('maxLoops must be a number');
		expect(() => parsePeerAgentAction({ kind: 'goal-run', launch: { goal: ' ' } })).toThrow(
			'Say what the run should achieve.'
		);
		expect(() => parsePeerAgentAction({ kind: 'auto-run-control', control: 'kill' })).toThrow(
			'Unknown Auto Run control: kill'
		);
	});
});

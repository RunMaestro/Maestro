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
import type { AgentRecord } from '../../../../shared/maestro-lib/store/records';

const ok = <T>(value: T): ClientResult<T> => ({ ok: true, value });

function fakeClient() {
	const client = {
		turns: {
			send: vi.fn(async () => ok({ status: 'started' as const })),
			interrupt: vi.fn(async (_agentId: string, tabId: string) => ok({ stopped: tabId !== 't3' })),
		},
		tabs: {
			create: vi.fn(async () => ok({ tabId: 't-new' })),
			rename: vi.fn(async () => ok(undefined)),
			star: vi.fn(async () => ok(undefined)),
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
			parsePeerAgentAction({ kind: 'send', tabId: 't1', text: ' hi ', images: ['x'] })
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
	});

	it('refuses what no host call can take', () => {
		expect(() => parsePeerAgentAction(null)).toThrow('Missing action');
		expect(() => parsePeerAgentAction({ kind: 'close-tab' })).toThrow('Unknown action: close-tab');
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

/**
 * `agents.import` on the in-process client: the repository stores the agent, then each queued
 * message goes to the turn service in order. The queue is in memory, so it is the turn service's
 * to hold; a message it refuses is reported and the import still stands.
 */
import { describe, expect, it } from 'vitest';

import type { AgentRepository } from '../../agents/repository';
import type { EventBus } from '../../client/event-bus';
import type {
	AgentImportInput,
	ClientResult,
	TurnInput,
	TurnSendReceipt,
	TurnsApi,
} from '../../client/types';
import type { MaestroPaths } from '../../paths/resolve';
import { createRuntimeClient, type RuntimeClientDeps } from '../client';

const input: AgentImportInput = {
	agent: { name: 'Lifted', provider: 'codex', cwd: '/w' },
	tabs: [
		{ id: 't1', logs: [] },
		{ id: 't2', logs: [] },
	],
	queue: [
		{ tabId: 't1', text: 'one' },
		{ tabId: 't2', text: 'two', images: ['data:image/png;base64,AA'] },
		{ tabId: 't1', text: 'three' },
	],
};

function clientWith(
	imported: ClientResult<{ agentId: string }>,
	send: (agentId: string, tabId: string, turn: TurnInput) => ClientResult<TurnSendReceipt>
) {
	const sends: Array<{ agentId: string; tabId: string; turn: TurnInput }> = [];
	const deps = {
		paths: {} as MaestroPaths,
		repository: { importAgent: async () => imported } as unknown as AgentRepository,
		bus: {} as EventBus,
		host: { kind: 'headless', label: 'test' },
		phase: () => 'open',
		fencedReason: () => '',
		shutdown: async () => undefined,
		listProviders: async () => [],
		turns: {
			send: async (agentId: string, tabId: string, turn: TurnInput) => {
				sends.push({ agentId, tabId, turn });
				return send(agentId, tabId, turn);
			},
		} as unknown as TurnsApi,
		autoRun: {},
		groupChats: {},
		consults: { api: {}, cancelForSource: () => 0 },
	} as unknown as RuntimeClientDeps;
	return { client: createRuntimeClient(deps), sends };
}

describe('agents.import (in-process)', () => {
	it('sends the queued messages to the new agent in order, with their images', async () => {
		const { client, sends } = clientWith({ ok: true, value: { agentId: 'new' } }, () => ({
			ok: true,
			value: { status: 'started' } as TurnSendReceipt,
		}));
		expect(await client.agents.import(input)).toEqual({
			ok: true,
			value: { agentId: 'new', queued: 3 },
		});
		expect(sends).toEqual([
			{ agentId: 'new', tabId: 't1', turn: { text: 'one' } },
			{ agentId: 'new', tabId: 't2', turn: { text: 'two', images: ['data:image/png;base64,AA'] } },
			{ agentId: 'new', tabId: 't1', turn: { text: 'three' } },
		]);
	});

	it('reports a queued message the turn service refuses, and keeps the import', async () => {
		const { client } = clientWith({ ok: true, value: { agentId: 'new' } }, (_a, _t, turn) =>
			turn.text === 'two'
				? { ok: false, error: { code: 'rejected', message: 'queue full', method: 'turns.send' } }
				: { ok: true, value: { status: 'started' } as TurnSendReceipt }
		);
		expect(await client.agents.import(input)).toEqual({
			ok: true,
			value: {
				agentId: 'new',
				queued: 2,
				notices: ['A queued message for tab t2 was not queued: queue full'],
			},
		});
	});

	it('sends nothing when the repository refuses the import', async () => {
		const refused: ClientResult<{ agentId: string }> = {
			ok: false,
			error: {
				code: 'invalid',
				message: 'Working directory does not exist: /w',
				method: 'agents.import',
			},
		};
		const { client, sends } = clientWith(refused, () => {
			throw new Error('no send expected');
		});
		expect(await client.agents.import(input)).toEqual(refused);
		expect(sends).toEqual([]);
	});
});

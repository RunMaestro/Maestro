/**
 * The lifted-agent pointer: a valid `liftedTo` refuses sends with a `peer:agentId` pointer, a
 * malformed one reads as "not lifted", and the process-owner lookup finds only lifted agents.
 */
import { describe, expect, it } from 'vitest';

import {
	liftBusyReason,
	liftedAgentRef,
	liftedOwnerOfProcess,
	liftedSendRefusal,
	peerAgentRef,
	readLiftedTo,
} from '../lift-pointer';

const pointer = { peer: 'build-box', agentId: 'host-1', at: 1700000000000 };

describe('readLiftedTo', () => {
	it('returns a well-formed pointer', () => {
		expect(readLiftedTo(pointer)).toEqual(pointer);
	});

	it.each([
		['absent', undefined],
		['null', null],
		['a string', 'build-box:host-1'],
		['an empty peer', { ...pointer, peer: ' ' }],
		['a missing agent id', { peer: 'build-box', at: 1 }],
		['a non-number time', { ...pointer, at: '1700000000000' }],
		['a non-finite time', { ...pointer, at: Number.NaN }],
	])('reads %s as not lifted', (_label, value) => {
		expect(readLiftedTo(value)).toBeUndefined();
	});
});

describe('liftedSendRefusal', () => {
	it('is undefined for an agent that was not lifted', () => {
		expect(liftedSendRefusal({ name: 'Local' })).toBeUndefined();
	});

	it('names the agent, the peer and the peer:agentId target', () => {
		const message = liftedSendRefusal({ name: 'Builder', liftedTo: pointer });
		expect(message).toContain('"Builder"');
		expect(message).toContain('peer "build-box"');
		expect(message).toContain('Send to build-box:host-1 instead.');
	});

	it('works without a name', () => {
		expect(liftedSendRefusal({ liftedTo: pointer })).toMatch(/^This agent was moved/);
	});

	it('does not refuse on a malformed pointer', () => {
		expect(liftedSendRefusal({ name: 'X', liftedTo: { peer: 'p' } })).toBeUndefined();
	});
});

describe('liftedAgentRef / peerAgentRef', () => {
	it('formats peer:agentId', () => {
		expect(peerAgentRef('build-box', 'host-1')).toBe('build-box:host-1');
		expect(liftedAgentRef({ liftedTo: pointer })).toBe('build-box:host-1');
		expect(liftedAgentRef({})).toBeUndefined();
	});
});

describe('liftedOwnerOfProcess', () => {
	const lifted = { id: 'a1b2c3d4-0000-4000-8000-000000000001', liftedTo: pointer };
	const local = { id: 'a1b2c3d4-0000-4000-8000-000000000002' };
	const agents = [local, lifted];

	it('finds the lifted owner of an AI tab, batch, or bare process id', () => {
		expect(liftedOwnerOfProcess(agents, `${lifted.id}-ai-tab1`)).toBe(lifted);
		expect(liftedOwnerOfProcess(agents, `${lifted.id}-batch-123`)).toBe(lifted);
		expect(liftedOwnerOfProcess(agents, lifted.id)).toBe(lifted);
	});

	it('ignores agents that were not lifted, and unrelated ids', () => {
		expect(liftedOwnerOfProcess(agents, `${local.id}-ai-tab1`)).toBeUndefined();
		expect(liftedOwnerOfProcess(agents, 'group-chat-xyz-moderator')).toBeUndefined();
	});

	it('skips null entries a hand-edited store can hold', () => {
		const withNull = [null, lifted] as unknown as Array<typeof lifted>;
		expect(liftedOwnerOfProcess(withNull, `${lifted.id}-ai-t`)).toBe(lifted);
	});
});

describe('liftBusyReason', () => {
	it('is null when no tab and not the agent is busy', () => {
		expect(
			liftBusyReason({ name: 'Docs', state: 'idle', aiTabs: [{ id: 't1', state: 'idle' }] })
		).toBeNull();
	});

	it('names the busy tab, by name or by id', () => {
		expect(
			liftBusyReason({ name: 'Docs', aiTabs: [{ id: 't1', name: 'Main', state: 'busy' }] })
		).toContain('tab "Main"');
		expect(liftBusyReason({ name: 'Docs', aiTabs: [{ id: 't1', state: 'busy' }] })).toContain(
			'tab t1'
		);
	});

	it('counts the agent state when no tab says busy', () => {
		expect(liftBusyReason({ name: 'Docs', state: 'busy', aiTabs: [] })).toContain('"Docs" is busy');
	});
});

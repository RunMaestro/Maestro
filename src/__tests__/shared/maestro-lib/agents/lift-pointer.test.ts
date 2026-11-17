/**
 * Tests for the lift pointer helpers that decide which hosted agents the Left Bar shows: one key
 * per local record with a valid pointer, and the record that points at a given host agent.
 */

import { describe, expect, it } from 'vitest';
import {
	findLiftedAgent,
	liftedAgentKeys,
} from '../../../../shared/maestro-lib/agents/lift-pointer';

const agents = [
	{ id: 'row-1', liftedTo: { peer: 'tome', agentId: 'k1', at: 1 } },
	{ id: 'row-2', liftedTo: { peer: 'gpu', agentId: 'g1', at: 2 } },
	{ id: 'local' },
	{ id: 'broken', liftedTo: { peer: 'tome', agentId: '', at: 3 } },
];

describe('liftedAgentKeys', () => {
	it('keys every valid pointer as peer:agentId and skips local or malformed records', () => {
		expect([...liftedAgentKeys(agents)].sort()).toEqual(['gpu:g1', 'tome:k1']);
		expect(liftedAgentKeys([]).size).toBe(0);
	});
});

describe('findLiftedAgent', () => {
	it('finds the record that points at a host agent, or nothing', () => {
		expect(findLiftedAgent(agents, 'tome', 'k1')?.id).toBe('row-1');
		expect(findLiftedAgent(agents, 'gpu', 'k1')).toBeUndefined();
		expect(findLiftedAgent(agents, 'tome', '')).toBeUndefined();
	});
});

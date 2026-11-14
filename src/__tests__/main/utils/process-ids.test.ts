/**
 * Tests for agentIdFromProcessId - the agent a spawned process belongs to.
 */

import { describe, it, expect } from 'vitest';
import { agentIdFromProcessId } from '../../../main/utils/process-ids';

const AGENT = 'aaaf249a-aa54-4114-93f6-b173c2495dcf';

describe('agentIdFromProcessId', () => {
	it.each([
		[`${AGENT}-ai-1110904e-40ce-44e9-aab5-8085f9ec2381`, 'a turn in an AI tab'],
		[`${AGENT}-ai-tab-1-fp-1760000000000`, 'a forced-parallel turn'],
		[`${AGENT}-batch-1760000000000`, 'an Auto Run task'],
		[`${AGENT}-synopsis-1760000000000`, 'the History synopsis'],
		[`${AGENT}-cue-run-7`, 'a Cue run'],
	])('reads %s as the agent (%s)', (processId) => {
		expect(agentIdFromProcessId(processId)).toBe(AGENT);
	});

	it('returns an id with no known suffix unchanged', () => {
		expect(agentIdFromProcessId(AGENT)).toBe(AGENT);
		expect(agentIdFromProcessId('cross-agent-12345')).toBe('cross-agent-12345');
	});
});

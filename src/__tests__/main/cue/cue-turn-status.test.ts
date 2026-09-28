/**
 * @file cue-turn-status.test.ts
 * @description Unit tests for Cue turn status resolution and safety overrides.
 */

import { describe, it, expect } from 'vitest';
import { cueStatusForTurn, type CueTurnFacts } from '../../../main/cue/cue-turn-status';
import type { CueRunStatus } from '../../../main/cue/cue-types';

describe('cueStatusForTurn', () => {
	const cases: Array<{
		name: string;
		facts: CueTurnFacts;
		expected: CueRunStatus;
	}> = [
		{
			name: 'completed, exit 0 -> completed',
			facts: {
				outcome: 'completed',
				exitCode: 0,
				answerCaptured: true,
				killedBySignal: false,
			},
			expected: 'completed',
		},
		{
			name: 'completed-with-warning, exit 1, answer captured -> completed (headline case)',
			facts: {
				outcome: 'completed-with-warning',
				exitCode: 1,
				answerCaptured: true,
				killedBySignal: false,
			},
			expected: 'completed',
		},
		{
			name: 'crashed -> failed',
			facts: {
				outcome: 'crashed',
				exitCode: 1,
				answerCaptured: false,
				killedBySignal: false,
			},
			expected: 'failed',
		},
		{
			name: 'interrupted -> stopped, even with a signal',
			facts: {
				outcome: 'interrupted',
				exitCode: null,
				answerCaptured: true,
				killedBySignal: true,
			},
			expected: 'stopped',
		},
		{
			name: 'outcome completed, exit 1, no answer -> failed (nonZeroWithoutAnswer override)',
			facts: {
				outcome: 'completed',
				exitCode: 1,
				answerCaptured: false,
				killedBySignal: false,
			},
			expected: 'failed',
		},
		{
			name: 'completed-with-warning, signal kill, answer captured -> failed (killedBySignal override)',
			facts: {
				outcome: 'completed-with-warning',
				exitCode: null,
				answerCaptured: true,
				killedBySignal: true,
			},
			expected: 'failed',
		},
	];

	for (const { name, facts, expected } of cases) {
		it(name, () => {
			expect(cueStatusForTurn(facts)).toBe(expected);
		});
	}
});

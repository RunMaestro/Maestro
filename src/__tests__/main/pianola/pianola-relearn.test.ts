/**
 * @file pianola-relearn.test.ts
 *
 * Unit tests for the pure re-learn composition. Everything the job touches is
 * injected, so these run with fakes - no fs, electron, or child processes.
 */

import { describe, it, expect, vi } from 'vitest';
import { runRelearnJob, type RelearnDeps } from '../../../main/pianola/pianola-relearn';
import { synthesizeSuggestions } from '../../../shared/pianola/pianola-synthesis';
import type { DecisionPair } from '../../../shared/pianola/transcript-mining';
import type { PianolaRule } from '../../../shared/pianola/types';

const NOW = 1_700_000_000_000;

/** A low-risk, affirmatively-answered question pair (the rule-able shape). */
function lowQuestionPair(i: number): DecisionPair {
	return {
		agent: 'claude-code',
		sessionId: `s-${i}`,
		classification: {
			kind: 'question',
			risk: 'low',
			topic: 'run the tests?',
			confidence: 'high',
			evidence: { messageId: null, reason: 'heuristic', structured: false },
		},
		ask: 'Should I run the tests?',
		reply: 'yes',
		polarity: 'affirmative',
		askedAt: new Date(NOW).toISOString(),
		repliedAt: new Date(NOW).toISOString(),
	};
}

describe('runRelearnJob', () => {
	it('stages suggestions from synthesizeSuggestions and relaunches once when enabled', async () => {
		const pairs = Array.from({ length: 6 }, (_, i) => lowQuestionPair(i));
		const rules: PianolaRule[] = [];
		const profile = '';
		// The job must stage exactly what the shared synthesizer produces.
		const expected = synthesizeSuggestions({
			pairs,
			existingRules: rules,
			existingProfile: profile,
			now: NOW,
		});

		const writeSuggestions = vi.fn();
		const relaunchStale = vi.fn(() => 2);
		const mine = vi.fn(async () => pairs);
		const deps: RelearnDeps = {
			isEnabled: () => true,
			mine,
			readExisting: () => ({ rules, profile }),
			writeSuggestions,
			relaunchStale,
			now: () => NOW,
			log: () => {},
		};

		const result = await runRelearnJob(deps);

		expect(mine).toHaveBeenCalledTimes(1);
		expect(writeSuggestions).toHaveBeenCalledTimes(1);
		expect(relaunchStale).toHaveBeenCalledTimes(1);

		const file = writeSuggestions.mock.calls[0]?.[0];
		expect(file.generatedAt).toBe(NOW);
		expect(file.pairCount).toBe(pairs.length);
		expect(file.proposals).toEqual(expected.proposals);
		expect(file.proposedProfile).toBe(expected.profileDiff.after);
		expect(file.previousProfile).toBe(expected.profileDiff.before);
		// This corpus crosses the synthesis thresholds, so a real proposal exists.
		expect(file.proposals.length).toBeGreaterThan(0);

		expect(result).toEqual({
			wrote: true,
			proposalCount: expected.proposals.length,
			pairCount: pairs.length,
			relaunched: 2,
		});
	});

	it('skips and writes nothing when the feature is disabled', async () => {
		const writeSuggestions = vi.fn();
		const relaunchStale = vi.fn(() => 0);
		const mine = vi.fn(async () => [] as DecisionPair[]);

		const result = await runRelearnJob({
			isEnabled: () => false,
			mine,
			readExisting: () => ({ rules: [], profile: '' }),
			writeSuggestions,
			relaunchStale,
			now: () => NOW,
			log: () => {},
		});

		expect(result).toEqual({
			skipped: 'pianola disabled',
			wrote: false,
			proposalCount: 0,
			pairCount: 0,
			relaunched: 0,
		});
		expect(mine).not.toHaveBeenCalled();
		expect(writeSuggestions).not.toHaveBeenCalled();
		expect(relaunchStale).not.toHaveBeenCalled();
	});

	it('never throws and preserves prior suggestions when mining fails', async () => {
		const writeSuggestions = vi.fn();
		const relaunchStale = vi.fn(() => 0);

		const result = await runRelearnJob({
			isEnabled: () => true,
			mine: async () => {
				throw new Error('boom');
			},
			readExisting: () => ({ rules: [], profile: '' }),
			writeSuggestions,
			relaunchStale,
			now: () => NOW,
			log: () => {},
		});

		expect(result.wrote).toBe(false);
		expect(result.skipped).toBe('error');
		// A failed mine must not clobber the previously staged suggestions.
		expect(writeSuggestions).not.toHaveBeenCalled();
		expect(relaunchStale).not.toHaveBeenCalled();
	});
});

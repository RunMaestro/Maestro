/**
 * Unit tests for the shared output filter used by both the fan-in tracker and
 * the single-source completion path. These tests are the contract for
 * `include_output_from` / `forward_output_from` filtering semantics.
 */

import { describe, it, expect } from 'vitest';
import {
	buildFilteredOutputs,
	mergeUpstreamForwarded,
	type FanInSourceCompletion,
} from '../../../main/cue/cue-output-filter';
import type { CueSubscription } from '../../../main/cue/cue-types';

function makeSub(overrides: Partial<CueSubscription> = {}): CueSubscription {
	return {
		name: 'sub',
		event: 'agent.completed',
		enabled: true,
		prompt: 'process it',
		...overrides,
	};
}

function makeCompletion(overrides: Partial<FanInSourceCompletion> = {}): FanInSourceCompletion {
	return {
		sessionId: 'id-a',
		sessionName: 'Agent A',
		output: 'a-output',
		truncated: false,
		chainDepth: 0,
		...overrides,
	};
}

describe('buildFilteredOutputs', () => {
	describe('default (no filters)', () => {
		it('includes every completion when include_output_from is unset', () => {
			const completions = [makeCompletion()];
			const { outputCompletions, perSourceOutputs, forwardedOutputs } = buildFilteredOutputs(
				completions,
				makeSub()
			);
			expect(outputCompletions).toEqual(completions);
			expect(perSourceOutputs).toEqual({ 'Agent A': 'a-output' });
			expect(forwardedOutputs).toEqual({});
		});

		it('forwards nothing when forward_output_from is unset', () => {
			const completions = [makeCompletion()];
			const { forwardedOutputs } = buildFilteredOutputs(completions, makeSub());
			expect(forwardedOutputs).toEqual({});
		});
	});

	describe('include_output_from', () => {
		it('includes only listed sources (by sessionName)', () => {
			const completions = [
				makeCompletion({ sessionId: 'id-a', sessionName: 'Agent A', output: 'a' }),
				makeCompletion({ sessionId: 'id-b', sessionName: 'Agent B', output: 'b' }),
			];
			const { outputCompletions, perSourceOutputs } = buildFilteredOutputs(
				completions,
				makeSub({ include_output_from: ['Agent A'] })
			);
			expect(outputCompletions.map((c) => c.sessionName)).toEqual(['Agent A']);
			expect(perSourceOutputs).toEqual({ 'Agent A': 'a' });
		});

		it('includes listed sources by sessionId as well', () => {
			const completions = [
				makeCompletion({ sessionId: 'id-a', sessionName: 'Agent A', output: 'a' }),
				makeCompletion({ sessionId: 'id-b', sessionName: 'Agent B', output: 'b' }),
			];
			const { perSourceOutputs } = buildFilteredOutputs(
				completions,
				makeSub({ include_output_from: ['id-b'] })
			);
			expect(perSourceOutputs).toEqual({ 'Agent B': 'b' });
		});

		it('returns empty maps when include_output_from is an empty array', () => {
			const completions = [makeCompletion()];
			const { outputCompletions, perSourceOutputs } = buildFilteredOutputs(
				completions,
				makeSub({ include_output_from: [] })
			);
			expect(outputCompletions).toEqual([]);
			expect(perSourceOutputs).toEqual({});
		});
	});

	describe('forward_output_from', () => {
		it('forwards only listed sources', () => {
			const completions = [
				makeCompletion({ sessionName: 'Agent A', output: 'a' }),
				makeCompletion({ sessionId: 'id-b', sessionName: 'Agent B', output: 'b' }),
			];
			const { forwardedOutputs } = buildFilteredOutputs(
				completions,
				makeSub({ forward_output_from: ['Agent A'] })
			);
			expect(forwardedOutputs).toEqual({ 'Agent A': 'a' });
		});

		it('is independent of include_output_from (forward-only source is excluded from prompt)', () => {
			const completions = [
				makeCompletion({ sessionName: 'Agent A', output: 'a' }),
				makeCompletion({ sessionId: 'id-b', sessionName: 'Agent B', output: 'b' }),
			];
			const { perSourceOutputs, forwardedOutputs } = buildFilteredOutputs(
				completions,
				makeSub({
					include_output_from: ['Agent A'],
					forward_output_from: ['Agent B'],
				})
			);
			expect(perSourceOutputs).toEqual({ 'Agent A': 'a' });
			expect(forwardedOutputs).toEqual({ 'Agent B': 'b' });
		});
	});
});

describe('mergeUpstreamForwarded', () => {
	it('returns the original map when upstream is undefined', () => {
		const base = { 'Agent A': 'a' };
		expect(mergeUpstreamForwarded(base, undefined, makeSub())).toEqual(base);
	});

	it('passes all upstream keys through when forward_output_from is unset', () => {
		const merged = mergeUpstreamForwarded({}, { 'Agent X': 'x', 'Agent Y': 'y' }, makeSub());
		expect(merged).toEqual({ 'Agent X': 'x', 'Agent Y': 'y' });
	});

	it('filters upstream keys by forward_output_from when set', () => {
		const merged = mergeUpstreamForwarded(
			{},
			{ 'Agent X': 'x', 'Agent Y': 'y' },
			makeSub({ forward_output_from: ['Agent X'] })
		);
		expect(merged).toEqual({ 'Agent X': 'x' });
	});

	it('preserves base entries when merging', () => {
		const merged = mergeUpstreamForwarded(
			{ 'Agent A': 'a' },
			{ 'Agent X': 'x' },
			makeSub({ forward_output_from: ['Agent A', 'Agent X'] })
		);
		expect(merged).toEqual({ 'Agent A': 'a', 'Agent X': 'x' });
	});
});

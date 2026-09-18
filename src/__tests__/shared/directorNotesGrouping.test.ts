/**
 * Tests for the Director's Notes narrative bucketing.
 *
 * The contract under test:
 * - a bullet buckets by its agent's GROUP when one is known, by the agent when
 *   it is not, and into the unattributed catch-all when it carries no agent
 * - bucket order follows first appearance so the model's own ordering survives,
 *   with the unattributed bucket always last
 * - agent names match through the same sanitizing the synopsis manifest applies,
 *   so a name that came back with different case or stripped punctuation still
 *   finds its group
 * - one bucket means headers are not worth drawing
 */

import { describe, it, expect } from 'vitest';
import {
	bucketNarrativeItems,
	buildNarrativeGroupLookup,
	normalizeAgentKey,
	shouldRenderBuckets,
	UNATTRIBUTED_BUCKET_LABEL,
} from '../../shared/directorNotesGrouping';
import type { NarrativeItem } from '../../shared/directorNotesNarrative';

const CORE_LOOKUP = buildNarrativeGroupLookup([
	{ agent: 'Maestro', group: 'Maestro Core', emoji: '🎬' },
	{ agent: 'rc', group: 'Maestro Core', emoji: '🎬' },
	{ agent: 'acappella', group: 'Voice' },
	// Ungrouped agents are legal input and simply never match.
	{ agent: 'scratch' },
]);

const item = (text: string, agent?: string): NarrativeItem => (agent ? { text, agent } : { text });

describe('bucketNarrativeItems', () => {
	it('collapses agents that share a group into one bucket', () => {
		const buckets = bucketNarrativeItems(
			[item('a', 'Maestro'), item('b', 'rc'), item('c', 'acappella')],
			CORE_LOOKUP
		);

		expect(buckets).toHaveLength(2);
		expect(buckets[0]).toMatchObject({ label: 'Maestro Core', emoji: '🎬', isGroup: true });
		expect(buckets[0].items.map((i) => i.text)).toEqual(['a', 'b']);
		expect(buckets[1]).toMatchObject({ label: 'Voice', isGroup: true });
	});

	it('buckets an agent with no group under its own name', () => {
		const buckets = bucketNarrativeItems([item('a', 'scratch'), item('b', 'scratch')], CORE_LOOKUP);

		expect(buckets).toHaveLength(1);
		expect(buckets[0]).toMatchObject({ label: 'scratch', isGroup: false, isUnattributed: false });
	});

	it('buckets by agent when no lookup is supplied at all', () => {
		const buckets = bucketNarrativeItems([item('a', 'Maestro'), item('b', 'rc')]);

		expect(buckets.map((b) => b.label)).toEqual(['Maestro', 'rc']);
		expect(buckets.every((b) => !b.isGroup)).toBe(true);
	});

	it('preserves first-appearance order but sinks the unattributed bucket last', () => {
		const buckets = bucketNarrativeItems(
			[item('a'), item('b', 'acappella'), item('c', 'Maestro'), item('d')],
			CORE_LOOKUP
		);

		expect(buckets.map((b) => b.label)).toEqual([
			'Voice',
			'Maestro Core',
			UNATTRIBUTED_BUCKET_LABEL,
		]);
		expect(buckets[2].isUnattributed).toBe(true);
		expect(buckets[2].items.map((i) => i.text)).toEqual(['a', 'd']);
	});

	it('treats a blank agent string the same as no agent', () => {
		// An empty label would render as a headerless bucket that reads as a
		// rendering fault rather than as "unattributed".
		const buckets = bucketNarrativeItems([{ text: 'a', agent: '   ' }], CORE_LOOKUP);

		expect(buckets[0].label).toBe(UNATTRIBUTED_BUCKET_LABEL);
		expect(buckets[0].isUnattributed).toBe(true);
	});

	it('matches an agent name through case and stripped punctuation', () => {
		// The manifest hands the model a sanitized display name, so what comes
		// back rarely matches the stored name byte for byte.
		const buckets = bucketNarrativeItems(
			[item('a', '  MAESTRO  '), item('b', '*rc*')],
			CORE_LOOKUP
		);

		expect(buckets).toHaveLength(1);
		expect(buckets[0].label).toBe('Maestro Core');
	});

	it('returns nothing for an empty section', () => {
		expect(bucketNarrativeItems([], CORE_LOOKUP)).toEqual([]);
	});
});

describe('shouldRenderBuckets', () => {
	it('is false when every bullet shares one owner', () => {
		expect(shouldRenderBuckets(bucketNarrativeItems([item('a', 'rc')], CORE_LOOKUP))).toBe(false);
	});

	it('is true once a section spans two owners', () => {
		expect(
			shouldRenderBuckets(bucketNarrativeItems([item('a', 'rc'), item('b')], CORE_LOOKUP))
		).toBe(true);
	});
});

describe('buildNarrativeGroupLookup', () => {
	it('resolves null for an unknown or ungrouped agent', () => {
		expect(CORE_LOOKUP('nobody')).toBeNull();
		expect(CORE_LOOKUP('scratch')).toBeNull();
	});

	it('ignores a blank group name', () => {
		const lookup = buildNarrativeGroupLookup([{ agent: 'a', group: '   ' }]);
		expect(lookup('a')).toBeNull();
	});
});

describe('normalizeAgentKey', () => {
	it('folds case, collapses whitespace, and strips markdown punctuation', () => {
		expect(normalizeAgentKey('  **Maestro   Cue**  Main ')).toBe('maestro cue main');
	});
});

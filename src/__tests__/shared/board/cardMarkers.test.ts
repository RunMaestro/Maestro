/**
 * @file cardMarkers.test.ts
 * @description Tests for the Board card completion marker parser. Covers the
 * four cases the dispatcher relies on (complete, review, block, none) plus the
 * summary/reason capture and last-match-wins behavior, mirroring the
 * goal-marker parser's test approach.
 */

import { describe, it, expect } from 'vitest';
import { parseCardMarkers, CARD_HANDOFF_REMINDER } from '../../../shared/board/cardMarkers';

describe('parseCardMarkers', () => {
	it('returns no flags when no marker is present', () => {
		const markers = parseCardMarkers('did some work, nothing structured here');
		expect(markers.complete).toBe(false);
		expect(markers.review).toBe(false);
		expect(markers.blocked).toBe(false);
		expect(markers.summary).toBeUndefined();
		expect(markers.reviewReason).toBeUndefined();
		expect(markers.blockReason).toBeUndefined();
	});

	it('detects a bare complete marker', () => {
		const markers = parseCardMarkers('all done\n<!-- maestro:card-complete -->');
		expect(markers.complete).toBe(true);
		expect(markers.summary).toBeUndefined();
		expect(markers.blocked).toBe(false);
	});

	it('captures the summary after a complete marker', () => {
		const markers = parseCardMarkers(
			'<!-- maestro:card-complete | wired the schema and added tests -->'
		);
		expect(markers.complete).toBe(true);
		expect(markers.summary).toBe('wired the schema and added tests');
	});

	it('detects a block marker with a reason', () => {
		const markers = parseCardMarkers('stuck\n<!-- maestro:card-block: missing API credentials -->');
		expect(markers.blocked).toBe(true);
		expect(markers.blockReason).toBe('missing API credentials');
		expect(markers.complete).toBe(false);
	});

	it('detects a bare block marker with no reason', () => {
		const markers = parseCardMarkers('<!-- maestro:card-block -->');
		expect(markers.blocked).toBe(true);
		expect(markers.blockReason).toBeUndefined();
	});

	it('is tolerant of extra whitespace inside the comment', () => {
		const markers = parseCardMarkers('<!--   maestro:card-complete   |   ok   -->');
		expect(markers.complete).toBe(true);
		expect(markers.summary).toBe('ok');
	});

	it('takes the last complete marker when several are present', () => {
		const markers = parseCardMarkers(
			'<!-- maestro:card-complete | first -->\n<!-- maestro:card-complete | final -->'
		);
		expect(markers.summary).toBe('final');
	});

	it('uses only the last standalone authority when several types appear', () => {
		// Earlier prose/markers cannot override the worker's final handoff.
		const markers = parseCardMarkers(
			'<!-- maestro:card-complete -->\n<!-- maestro:card-block: regressed -->'
		);
		expect(markers.complete).toBe(false);
		expect(markers.blocked).toBe(true);
		expect(markers.blockReason).toBe('regressed');
	});

	it('detects a review marker with a reason', () => {
		const markers = parseCardMarkers(
			'schema migration written\n<!-- maestro:card-review: destructive migration, needs a human to sign off -->'
		);
		expect(markers.review).toBe(true);
		expect(markers.reviewReason).toBe('destructive migration, needs a human to sign off');
		expect(markers.complete).toBe(false);
		expect(markers.blocked).toBe(false);
	});

	it('detects a bare review marker with no reason', () => {
		const markers = parseCardMarkers('<!-- maestro:card-review -->');
		expect(markers.review).toBe(true);
		expect(markers.reviewReason).toBeUndefined();
	});

	it('is tolerant of extra whitespace around a review reason', () => {
		const markers = parseCardMarkers('<!--   maestro:card-review :   needs eyes   -->');
		expect(markers.review).toBe(true);
		expect(markers.reviewReason).toBe('needs eyes');
	});

	it('takes the last review marker when several are present', () => {
		const markers = parseCardMarkers(
			'<!-- maestro:card-review: first -->\n<!-- maestro:card-review: final -->'
		);
		expect(markers.review).toBe(true);
		expect(markers.reviewReason).toBe('final');
	});

	it('ignores earlier complete and review authority when the final marker blocks', () => {
		// block > review > complete is resolved in the dispatcher, not here.
		const markers = parseCardMarkers(
			[
				'<!-- maestro:card-complete | shipped it -->',
				'<!-- maestro:card-review: verify the migration -->',
				'<!-- maestro:card-block: actually stuck -->',
			].join('\n')
		);
		expect(markers.complete).toBe(false);
		expect(markers.summary).toBeUndefined();
		expect(markers.review).toBe(false);
		expect(markers.reviewReason).toBeUndefined();
		expect(markers.blocked).toBe(true);
		expect(markers.blockReason).toBe('actually stuck');
	});

	it('does not mistake a review marker for a complete or block marker', () => {
		const markers = parseCardMarkers('<!-- maestro:card-review: careful -->');
		expect(markers.complete).toBe(false);
		expect(markers.summary).toBeUndefined();
		expect(markers.blocked).toBe(false);
		expect(markers.blockReason).toBeUndefined();
	});

	it('preserves the final findings report alongside completion evidence for the host verdict', () => {
		const markers = parseCardMarkers(
			[
				'<!-- maestro:card-findings: preliminary report -->',
				'<!-- maestro:card-complete | checked the bound diff -->',
				'<!-- maestro:card-findings: Scope validation is missing.\nMembership regression failed. -->',
			].join('\n')
		);
		expect(markers.findings).toBe('Scope validation is missing.\nMembership regression failed.');
		expect(markers.complete).toBe(false);
		expect(markers.summary).toBeUndefined();
		expect(markers.review).toBe(false);
		expect(markers.blocked).toBe(false);
	});
});

describe('CARD_HANDOFF_REMINDER', () => {
	it('teaches all three markers so a worker can route human-judgment work', () => {
		expect(CARD_HANDOFF_REMINDER).toContain('maestro:card-complete');
		expect(CARD_HANDOFF_REMINDER).toContain('maestro:card-review');
		expect(CARD_HANDOFF_REMINDER).toContain('maestro:card-block');
	});

	it('requires assigned artifact review followed by a separate final human decision', () => {
		expect(CARD_HANDOFF_REMINDER).toContain('explicitly assigned artifact review');
		expect(CARD_HANDOFF_REMINDER).toContain('separate final human decision');
		expect(CARD_HANDOFF_REMINDER).toContain('maestro:card-findings');
		expect(CARD_HANDOFF_REMINDER).toContain('A completion never grants final human approval');
	});
});

it('accepts only the final standalone authority marker, not echoed examples or earlier markers', () => {
	for (const output of [
		CARD_HANDOFF_REMINDER,
		'Example: `<!-- maestro:card-block: do not use -->`',
		'<!-- maestro:card-block: incomplete\nunrelated text -->',
	]) {
		expect(parseCardMarkers(output)).toMatchObject({
			complete: false,
			review: false,
			blocked: false,
		});
	}
	expect(
		parseCardMarkers(
			'<!-- maestro:card-block: earlier -->\nChanged my assessment.\n<!-- maestro:card-complete | verified -->\n  '
		)
	).toMatchObject({ complete: true, blocked: false, review: false, summary: 'verified' });
	expect(
		parseCardMarkers('<!-- maestro:card-block: unfinished\n<!-- maestro:card-complete | final -->')
	).toMatchObject({ complete: true, blocked: false });
});

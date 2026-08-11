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

	it('reports both flags when the output contains both markers', () => {
		// Precedence (block wins) is the dispatcher's decision, not the parser's;
		// the parser reports faithfully.
		const markers = parseCardMarkers(
			'<!-- maestro:card-complete -->\n<!-- maestro:card-block: regressed -->'
		);
		expect(markers.complete).toBe(true);
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

	it('reports review alongside complete and block without deciding precedence', () => {
		// block > review > complete is resolved in the dispatcher, not here.
		const markers = parseCardMarkers(
			[
				'<!-- maestro:card-complete | shipped it -->',
				'<!-- maestro:card-review: verify the migration -->',
				'<!-- maestro:card-block: actually stuck -->',
			].join('\n')
		);
		expect(markers.complete).toBe(true);
		expect(markers.summary).toBe('shipped it');
		expect(markers.review).toBe(true);
		expect(markers.reviewReason).toBe('verify the migration');
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
});

describe('CARD_HANDOFF_REMINDER', () => {
	it('teaches all three markers so a worker can route human-judgment work', () => {
		expect(CARD_HANDOFF_REMINDER).toContain('maestro:card-complete');
		expect(CARD_HANDOFF_REMINDER).toContain('maestro:card-review');
		expect(CARD_HANDOFF_REMINDER).toContain('maestro:card-block');
	});

	it('tells the worker that review parks the card until a person approves it', () => {
		expect(CARD_HANDOFF_REMINDER).toContain('Review column');
	});
});

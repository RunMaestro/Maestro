/**
 * @file cardMarkers.test.ts
 * @description Tests for the Board card completion marker parser. Covers the
 * three cases the dispatcher relies on (complete, block, none) plus the
 * summary/reason capture and last-match-wins behavior, mirroring the
 * goal-marker parser's test approach.
 */

import { describe, it, expect } from 'vitest';
import { parseCardMarkers } from '../../../shared/board/cardMarkers';

describe('parseCardMarkers', () => {
	it('returns neither flag when no marker is present', () => {
		const markers = parseCardMarkers('did some work, nothing structured here');
		expect(markers.complete).toBe(false);
		expect(markers.blocked).toBe(false);
		expect(markers.summary).toBeUndefined();
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
		const markers = parseCardMarkers(
			'stuck\n<!-- maestro:card-block: missing API credentials -->'
		);
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
});

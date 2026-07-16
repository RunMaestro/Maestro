/**
 * Tests for the Goal-Driven marker parser.
 *
 * @file src/shared/goalDriven/goalMarkers.ts
 */

import { describe, it, expect } from 'vitest';
import { parseGoalMarkers, stripMaestroMarkers } from '../../../shared/goalDriven/goalMarkers';

describe('stripMaestroMarkers', () => {
	it('removes a progress marker and trims the dangling gap', () => {
		const text = 'Did the work.\n\n<!-- maestro:progress 30 | least-privilege walk done -->';
		expect(stripMaestroMarkers(text)).toBe('Did the work.');
	});

	it('removes every marker shape (progress, complete, deadlock, halt)', () => {
		const text = [
			'Summary line.',
			'<!-- maestro:progress 100 | shipped -->',
			'<!-- maestro:goal-complete -->',
			'<!-- maestro:deadlock: blocked -->',
			'<!-- maestro:halt: stop -->',
		].join('\n');
		expect(stripMaestroMarkers(text)).toBe('Summary line.');
	});

	it('removes two markers sharing one line individually', () => {
		const text = 'a <!-- maestro:progress 40 -->mid<!-- maestro:deadlock --> b';
		expect(stripMaestroMarkers(text)).toBe('a mid b');
	});

	it('collapses the blank lines a mid-document marker leaves behind', () => {
		const text = 'Before.\n\n<!-- maestro:progress 50 -->\n\nAfter.';
		expect(stripMaestroMarkers(text)).toBe('Before.\n\nAfter.');
	});

	it('leaves marker-free text untouched', () => {
		const text = 'Plain text with no markers.';
		expect(stripMaestroMarkers(text)).toBe(text);
	});

	it('is tolerant of whitespace-only marker bodies', () => {
		expect(stripMaestroMarkers('x <!--   maestro:progress   45   --> y')).toBe('x  y');
	});
});

describe('parseGoalMarkers', () => {
	describe('progress marker', () => {
		it('parses a well-formed progress marker with a rationale', () => {
			const result = parseGoalMarkers('<!-- maestro:progress 45 | refactored auth module -->');
			expect(result.progress).toBe(45);
			expect(result.rationale).toBe('refactored auth module');
			expect(result.complete).toBe(false);
			expect(result.deadlock).toBe(false);
			expect(result.deadlockReason).toBeNull();
		});

		it('parses a progress marker without a rationale (rationale is null)', () => {
			const result = parseGoalMarkers('<!-- maestro:progress 30 -->');
			expect(result.progress).toBe(30);
			expect(result.rationale).toBeNull();
		});

		it('treats a present-but-empty rationale as null', () => {
			const result = parseGoalMarkers('<!-- maestro:progress 30 |    -->');
			expect(result.progress).toBe(30);
			expect(result.rationale).toBeNull();
		});

		it('is tolerant of whitespace variations inside the comment', () => {
			expect(parseGoalMarkers('<!--maestro:progress 45-->').progress).toBe(45);
			expect(parseGoalMarkers('<!--   maestro:progress   45   -->').progress).toBe(45);
			expect(parseGoalMarkers('<!--\tmaestro:progress\t45\t-->').progress).toBe(45);
			// Trailing newlines / surrounding prose
			expect(parseGoalMarkers('done\n<!-- maestro:progress 45 -->\n').progress).toBe(45);
		});

		it('clamps values above 100 down to 100', () => {
			expect(parseGoalMarkers('<!-- maestro:progress 150 -->').progress).toBe(100);
		});

		it('clamps negative values up to 0', () => {
			expect(parseGoalMarkers('<!-- maestro:progress -20 -->').progress).toBe(0);
		});

		it('rounds non-integer values to the nearest integer', () => {
			expect(parseGoalMarkers('<!-- maestro:progress 45.4 -->').progress).toBe(45);
			expect(parseGoalMarkers('<!-- maestro:progress 45.6 -->').progress).toBe(46);
		});

		it('returns null progress when no progress marker is present', () => {
			const result = parseGoalMarkers('Just some prose with no markers at all.');
			expect(result.progress).toBeNull();
			expect(result.rationale).toBeNull();
		});

		it('tolerates a trailing percent sign on the number', () => {
			expect(parseGoalMarkers('<!-- maestro:progress 45% -->').progress).toBe(45);
			expect(parseGoalMarkers('<!-- maestro:progress 45 % -->').progress).toBe(45);
			// With a rationale after the percent.
			const withRationale = parseGoalMarkers('<!-- maestro:progress 60% | data layer migrated -->');
			expect(withRationale.progress).toBe(60);
			expect(withRationale.rationale).toBe('data layer migrated');
			// Percent on a 100 still implies completion.
			const done = parseGoalMarkers('<!-- maestro:progress 100% | shipped -->');
			expect(done.progress).toBe(100);
			expect(done.complete).toBe(true);
		});

		it('finds a marker wrapped in backticks or a fenced code block', () => {
			// Inline backticks around the whole marker.
			expect(parseGoalMarkers('`<!-- maestro:progress 45 -->`').progress).toBe(45);
			// Inside a fenced code block.
			const fenced = ['```', '<!-- maestro:progress 70 | almost there -->', '```'].join('\n');
			const result = parseGoalMarkers(fenced);
			expect(result.progress).toBe(70);
			expect(result.rationale).toBe('almost there');
			// Fence with a language tag.
			const tagged = ['```text', '<!-- maestro:progress 80 -->', '```'].join('\n');
			expect(parseGoalMarkers(tagged).progress).toBe(80);
		});

		it('captures curly / smart punctuation in the rationale verbatim', () => {
			const result = parseGoalMarkers(
				'<!-- maestro:progress 55 | refactored the “auth” module - it’s nearly done… -->'
			);
			expect(result.progress).toBe(55);
			expect(result.rationale).toBe('refactored the “auth” module - it’s nearly done…');
		});

		it('uses the last progress marker when several are present', () => {
			const text = [
				'<!-- maestro:progress 10 | started -->',
				'<!-- maestro:progress 45 | halfway -->',
				'<!-- maestro:progress 70 | almost there -->',
			].join('\n');
			const result = parseGoalMarkers(text);
			expect(result.progress).toBe(70);
			expect(result.rationale).toBe('almost there');
		});
	});

	describe('completion marker', () => {
		it('sets complete from the bare goal-complete marker', () => {
			const result = parseGoalMarkers('All done.\n<!-- maestro:goal-complete -->');
			expect(result.complete).toBe(true);
		});

		it('is whitespace tolerant for the bare completion marker', () => {
			expect(parseGoalMarkers('<!--maestro:goal-complete-->').complete).toBe(true);
			expect(parseGoalMarkers('<!--   maestro:goal-complete   -->').complete).toBe(true);
		});

		it('treats progress of exactly 100 as complete even without the bare marker', () => {
			const result = parseGoalMarkers('<!-- maestro:progress 100 | shipped -->');
			expect(result.progress).toBe(100);
			expect(result.complete).toBe(true);
		});

		it('does not mark complete for progress below 100 without the bare marker', () => {
			const result = parseGoalMarkers('<!-- maestro:progress 99 -->');
			expect(result.complete).toBe(false);
		});
	});

	describe('deadlock marker', () => {
		it('parses a deadlock marker with a reason', () => {
			const result = parseGoalMarkers(
				'<!-- maestro:deadlock: cannot resolve conflicting requirements -->'
			);
			expect(result.deadlock).toBe(true);
			expect(result.deadlockReason).toBe('cannot resolve conflicting requirements');
		});

		it('parses a bare deadlock marker with a null reason', () => {
			const result = parseGoalMarkers('<!-- maestro:deadlock -->');
			expect(result.deadlock).toBe(true);
			expect(result.deadlockReason).toBeNull();
		});

		it('is whitespace tolerant for the deadlock marker', () => {
			const result = parseGoalMarkers('<!--maestro:deadlock:   stuck on flaky test   -->');
			expect(result.deadlock).toBe(true);
			expect(result.deadlockReason).toBe('stuck on flaky test');
		});

		it('reports no deadlock when no deadlock marker is present', () => {
			const result = parseGoalMarkers('<!-- maestro:progress 50 -->');
			expect(result.deadlock).toBe(false);
			expect(result.deadlockReason).toBeNull();
		});
	});

	describe('absence of any marker', () => {
		it('returns an all-null/false result for plain prose', () => {
			const result = parseGoalMarkers('I worked on the task and made some changes.');
			expect(result).toEqual({
				progress: null,
				rationale: null,
				complete: false,
				deadlock: false,
				deadlockReason: null,
			});
		});

		it('returns an all-null/false result for empty input', () => {
			expect(parseGoalMarkers('')).toEqual({
				progress: null,
				rationale: null,
				complete: false,
				deadlock: false,
				deadlockReason: null,
			});
		});
	});

	describe('realistic agent-response text', () => {
		it('finds a marker embedded mid-paragraph', () => {
			const text =
				'I refactored the database layer and migrated three queries. ' +
				'<!-- maestro:progress 60 | db layer migrated --> ' +
				'Next I will tackle the cache.';
			const result = parseGoalMarkers(text);
			expect(result.progress).toBe(60);
			expect(result.rationale).toBe('db layer migrated');
		});

		it('finds a marker at the very end of a longer response', () => {
			const text = [
				'## Summary',
				'',
				'- Implemented the parser',
				'- Wrote tests',
				'- All green',
				'',
				'Wrapping up this iteration.',
				'',
				'<!-- maestro:progress 100 | feature complete and tested -->',
			].join('\n');
			const result = parseGoalMarkers(text);
			expect(result.progress).toBe(100);
			expect(result.complete).toBe(true);
			expect(result.rationale).toBe('feature complete and tested');
		});

		it('handles a response carrying both a progress and a deadlock marker', () => {
			const text =
				'Made partial progress but then hit a wall.\n' +
				'<!-- maestro:progress 40 | wired up the UI -->\n' +
				'<!-- maestro:deadlock: upstream API is undocumented -->';
			const result = parseGoalMarkers(text);
			expect(result.progress).toBe(40);
			expect(result.rationale).toBe('wired up the UI');
			expect(result.deadlock).toBe(true);
			expect(result.deadlockReason).toBe('upstream API is undocumented');
		});
	});
});

/**
 * @file usage-parser.test.ts
 * @description Tests for the maestro-p `/usage` parser.
 *
 * Two halves:
 *   1. Fixture-driven: every `usage-*.txt` in
 *      `src/__tests__/fixtures/maestro-p-usage/` is parsed and asserted
 *      against its sibling `*.expected.json`. The sidecar JSON carries the
 *      `now_iso`, `config_dir`, and the expected StatusSnapshot so task 8's
 *      conductor-captured real fixtures can drop in without code edits.
 *   2. Inline negative cases: each documented null-return path (missing
 *      section, missing percent, missing reset line, unparseable spec,
 *      unknown month, invalid timezone, invalid nowIso) plus ANSI-stripping
 *      and DST-edge behaviors.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import { parseUsage } from '../../maestro-p/usage-parser';

const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures', 'maestro-p-usage');

interface ExpectedSidecar {
	now_iso: string;
	config_dir: string;
	expected: Record<string, unknown>;
}

function loadFixture(name: string): { raw: string; meta: ExpectedSidecar } {
	const raw = fs.readFileSync(path.join(FIXTURES_DIR, `${name}.txt`), 'utf-8');
	const meta = JSON.parse(
		fs.readFileSync(path.join(FIXTURES_DIR, `${name}.expected.json`), 'utf-8')
	) as ExpectedSidecar;
	return { raw, meta };
}

function listFixtureNames(): string[] {
	return fs
		.readdirSync(FIXTURES_DIR)
		.filter((f) => f.endsWith('.txt'))
		.map((f) => f.replace(/\.txt$/, ''))
		.sort();
}

describe('parseUsage — fixture-driven', () => {
	const names = listFixtureNames();

	// Sanity guard so the fixture loop doesn't silently pass when the
	// directory is empty (e.g., bad path refactor). Three is the hand-crafted
	// minimum from the playbook; task 8 will grow this number.
	it('has at least three fixtures available', () => {
		expect(names.length).toBeGreaterThanOrEqual(3);
	});

	for (const name of names) {
		it(`parses fixture "${name}" to its expected snapshot`, () => {
			const { raw, meta } = loadFixture(name);
			const result = parseUsage(raw, meta.now_iso, meta.config_dir);
			expect(result).not.toBeNull();
			expect(result).toEqual(meta.expected);
		});
	}
});

describe('parseUsage — ANSI handling', () => {
	it('strips ANSI escape codes before scanning sections', () => {
		const NOW = '2026-05-13T22:00:00.000Z';
		const raw = [
			'\x1b[1mCurrent session\x1b[0m',
			'\x1b[32m[████░░░░░░░░░░░░] 23% used\x1b[0m',
			'Resets 6pm (America/Chicago)',
			'',
			'\x1b[1mCurrent week (all models)\x1b[0m',
			'[██████████░░░░░░] 58% used',
			'Resets May 16 at 6pm (America/Chicago)',
			'',
			'\x1b[1mCurrent week (Sonnet only)\x1b[0m',
			'[░░░░░░░░░░░░░░░░] 0% used',
			'Resets May 16 at 6pm (America/Chicago)',
		].join('\n');

		const result = parseUsage(raw, NOW, '/Users/test/.claude');
		expect(result).not.toBeNull();
		expect(result?.session.percent).toBe(23);
		expect(result?.session.resets_at).toBe('2026-05-13T23:00:00.000Z');
	});
});

describe('parseUsage — null returns', () => {
	const NOW = '2026-05-13T22:00:00.000Z';

	it('returns null when the session section is missing', () => {
		const raw = [
			'Current week (all models)',
			'[██████████░░░░░░] 58% used',
			'Resets May 16 at 6pm (America/Chicago)',
			'',
			'Current week (Sonnet only)',
			'[░░░░░░░░░░░░░░░░] 0% used',
			'Resets May 16 at 6pm (America/Chicago)',
		].join('\n');
		expect(parseUsage(raw, NOW)).toBeNull();
	});

	it('returns null when the percent line is missing from a section', () => {
		const raw = [
			'Current session',
			'(bar render failed)',
			'Resets 6pm (America/Chicago)',
			'',
			'Current week (all models)',
			'[██████████░░░░░░] 58% used',
			'Resets May 16 at 6pm (America/Chicago)',
			'',
			'Current week (Sonnet only)',
			'[░░░░░░░░░░░░░░░░] 0% used',
			'Resets May 16 at 6pm (America/Chicago)',
		].join('\n');
		expect(parseUsage(raw, NOW)).toBeNull();
	});

	it('returns null when a Resets line is missing from a section', () => {
		const raw = [
			'Current session',
			'[████░░░░░░░░░░░░] 23% used',
			'',
			'Current week (all models)',
			'[██████████░░░░░░] 58% used',
			'Resets May 16 at 6pm (America/Chicago)',
			'',
			'Current week (Sonnet only)',
			'[░░░░░░░░░░░░░░░░] 0% used',
			'Resets May 16 at 6pm (America/Chicago)',
		].join('\n');
		expect(parseUsage(raw, NOW)).toBeNull();
	});

	it('returns null when a Resets spec is unparseable', () => {
		const raw = [
			'Current session',
			'[████░░░░░░░░░░░░] 23% used',
			'Resets sometime next week',
			'',
			'Current week (all models)',
			'[██████████░░░░░░] 58% used',
			'Resets May 16 at 6pm (America/Chicago)',
			'',
			'Current week (Sonnet only)',
			'[░░░░░░░░░░░░░░░░] 0% used',
			'Resets May 16 at 6pm (America/Chicago)',
		].join('\n');
		expect(parseUsage(raw, NOW)).toBeNull();
	});

	it('returns null when the month name is unrecognized', () => {
		const raw = [
			'Current session',
			'[████░░░░░░░░░░░░] 23% used',
			'Resets 6pm (America/Chicago)',
			'',
			'Current week (all models)',
			'[██████████░░░░░░] 58% used',
			'Resets Quintember 16 at 6pm (America/Chicago)',
			'',
			'Current week (Sonnet only)',
			'[░░░░░░░░░░░░░░░░] 0% used',
			'Resets May 16 at 6pm (America/Chicago)',
		].join('\n');
		expect(parseUsage(raw, NOW)).toBeNull();
	});

	it('returns null when the timezone in the spec is invalid', () => {
		const raw = [
			'Current session',
			'[████░░░░░░░░░░░░] 23% used',
			'Resets 6pm (Not/A_Zone)',
			'',
			'Current week (all models)',
			'[██████████░░░░░░] 58% used',
			'Resets May 16 at 6pm (America/Chicago)',
			'',
			'Current week (Sonnet only)',
			'[░░░░░░░░░░░░░░░░] 0% used',
			'Resets May 16 at 6pm (America/Chicago)',
		].join('\n');
		expect(parseUsage(raw, NOW)).toBeNull();
	});

	it('returns null when nowIso is not a valid date', () => {
		const { raw } = loadFixture('usage-fresh');
		expect(parseUsage(raw, 'not-a-date')).toBeNull();
	});
});

describe('parseUsage — timezone edge cases', () => {
	it('rolls a same-day session reset across a DST spring-forward boundary', () => {
		// 2026-03-08 is the second Sunday of March 2026 — US DST begins, so
		// the day after the boundary, 6pm Chicago is CDT (UTC-5) instead of
		// CST (UTC-6). nowIso just before the DST flip; reset spec is
		// "6pm (America/Chicago)" with no date, so the same-day branch must
		// resolve to that day's 6pm CDT = 23:00 UTC.
		const raw = [
			'Current session',
			'[████░░░░░░░░░░░░] 10% used',
			'Resets 6pm (America/Chicago)',
			'',
			'Current week (all models)',
			'[██████████░░░░░░] 50% used',
			'Resets May 16 at 6pm (America/Chicago)',
			'',
			'Current week (Sonnet only)',
			'[░░░░░░░░░░░░░░░░] 0% used',
			'Resets May 16 at 6pm (America/Chicago)',
		].join('\n');
		// 2026-03-08 12:00 UTC = 07:00 CDT (already past the 2am→3am jump).
		const result = parseUsage(raw, '2026-03-08T12:00:00.000Z');
		expect(result?.session.resets_at).toBe('2026-03-08T23:00:00.000Z');
	});

	it('handles a non-DST eastern winter reset (UTC offset shift)', () => {
		// January is Central Standard Time (UTC-6), so 6pm Chicago = 00:00
		// UTC the next day.
		const raw = [
			'Current session',
			'[████░░░░░░░░░░░░] 10% used',
			'Resets 6pm (America/Chicago)',
			'',
			'Current week (all models)',
			'[██████████░░░░░░] 50% used',
			'Resets Jan 15 at 6pm (America/Chicago)',
			'',
			'Current week (Sonnet only)',
			'[░░░░░░░░░░░░░░░░] 0% used',
			'Resets Jan 15 at 6pm (America/Chicago)',
		].join('\n');
		const result = parseUsage(raw, '2026-01-14T22:00:00.000Z');
		expect(result?.session.resets_at).toBe('2026-01-15T00:00:00.000Z');
		expect(result?.week_all_models.resets_at).toBe('2026-01-16T00:00:00.000Z');
	});

	it('rolls a dated reset forward a year when the in-year guess is in the past', () => {
		// nowIso is December; reset is January 5 — should land in next year.
		const raw = [
			'Current session',
			'[████░░░░░░░░░░░░] 10% used',
			'Resets 6pm (America/Chicago)',
			'',
			'Current week (all models)',
			'[██████████░░░░░░] 50% used',
			'Resets Jan 5 at 6pm (America/Chicago)',
			'',
			'Current week (Sonnet only)',
			'[░░░░░░░░░░░░░░░░] 0% used',
			'Resets Jan 5 at 6pm (America/Chicago)',
		].join('\n');
		const result = parseUsage(raw, '2026-12-30T12:00:00.000Z');
		// Jan 5 6pm CST 2027 = 00:00 UTC Jan 6 2027
		expect(result?.week_all_models.resets_at).toBe('2027-01-06T00:00:00.000Z');
	});

	it('accepts minute-precision times in the reset spec', () => {
		const raw = [
			'Current session',
			'[████░░░░░░░░░░░░] 10% used',
			'Resets 6:30pm (America/Chicago)',
			'',
			'Current week (all models)',
			'[██████████░░░░░░] 50% used',
			'Resets May 16 at 6pm (America/Chicago)',
			'',
			'Current week (Sonnet only)',
			'[░░░░░░░░░░░░░░░░] 0% used',
			'Resets May 16 at 6pm (America/Chicago)',
		].join('\n');
		const result = parseUsage(raw, '2026-05-13T22:00:00.000Z');
		expect(result?.session.resets_at).toBe('2026-05-13T23:30:00.000Z');
	});

	it('handles UTC-zoned reset specs', () => {
		// 6pm UTC reset, run at noon UTC — straight conversion, no offset.
		const raw = [
			'Current session',
			'[████░░░░░░░░░░░░] 10% used',
			'Resets 6pm (UTC)',
			'',
			'Current week (all models)',
			'[██████████░░░░░░] 50% used',
			'Resets May 16 at 6pm (UTC)',
			'',
			'Current week (Sonnet only)',
			'[░░░░░░░░░░░░░░░░] 0% used',
			'Resets May 16 at 6pm (UTC)',
		].join('\n');
		const result = parseUsage(raw, '2026-05-13T12:00:00.000Z');
		expect(result?.session.resets_at).toBe('2026-05-13T18:00:00.000Z');
		expect(result?.week_all_models.resets_at).toBe('2026-05-16T18:00:00.000Z');
	});
});

describe('parseUsage — whitespace-collapsed real-world output', () => {
	// claude 2.1.141's cursor-positioned panel renders inter-word spaces in
	// the /usage block as zero spaces once ANSI is stripped. These tests pin
	// the parser to tolerate that shape — the synthetic well-spaced fixtures
	// no longer prove correctness against the live binary.

	it('parses fully whitespace-collapsed sections', () => {
		const raw = [
			'Currentsession',
			'█████████████                                     26%used',
			'Resets1:40am(America/Chicago)',
			'',
			'Currentweek(allmodels)',
			'████████████████                                  32%used',
			'ResetsMay14at10am(America/Chicago)',
			'',
			'Currentweek(Sonnetonly)',
			'                                                  0%used',
			'ResetsMay14at10am(America/Chicago)',
		].join('\n');
		const result = parseUsage(raw, '2026-05-13T20:00:00.000Z');
		expect(result).not.toBeNull();
		expect(result?.session).toEqual({
			percent: 26,
			resets_at: '2026-05-14T06:40:00.000Z',
		});
		expect(result?.week_all_models).toEqual({
			percent: 32,
			resets_at: '2026-05-14T15:00:00.000Z',
		});
		expect(result?.week_sonnet_only).toEqual({
			percent: 0,
			resets_at: '2026-05-14T15:00:00.000Z',
		});
	});

	it('matches the mangled "Sonet nly" sonnet header that real captures produce', () => {
		// The third section's header is reliably garbled by claude's TUI
		// overdraw — characters drop at fixed column positions and the row
		// collides with a sibling section's trailing content. Section
		// detection has to tolerate "Sonet nly" alongside the canonical
		// "Sonnet only".
		const raw = [
			'Current session',
			'[██░░░░░░░░] 5% used',
			'Resets 6pm (America/Chicago)',
			'',
			'Current week (all models)',
			'[████░░░░░░] 20% used',
			'Resets May 16 at 6pm (America/Chicago)',
			'',
			'12:34am (America/Chicago)Current week (Sonet nly)                       0% used Other stuff',
		].join('\n');
		const result = parseUsage(raw, '2026-05-13T22:00:00.000Z');
		expect(result).not.toBeNull();
		expect(result?.week_sonnet_only.percent).toBe(0);
		expect(result?.week_sonnet_only.resets_at).toBe(result?.week_all_models.resets_at);
	});

	it('borrows sonnet.resets_at from week_all_models when sonnet has no Resets line', () => {
		const raw = [
			'Current session',
			'[████░░░░░░] 23% used',
			'Resets 6pm (America/Chicago)',
			'',
			'Current week (all models)',
			'[██████████] 58% used',
			'Resets May 16 at 6pm (America/Chicago)',
			'',
			'Current week (Sonnet only)',
			'[░░░░░░░░░░] 0% used',
			// intentionally no Resets line for sonnet
		].join('\n');
		const result = parseUsage(raw, '2026-05-13T22:00:00.000Z');
		expect(result).not.toBeNull();
		expect(result?.week_sonnet_only.percent).toBe(0);
		expect(result?.week_sonnet_only.resets_at).toBe(result?.week_all_models.resets_at);
	});

	it('synthesizes a zero-usage sonnet section when the header is absent entirely', () => {
		// Defensive synthesis: when neither the header nor any sonnet content
		// is parseable, emit a zero-usage placeholder keyed to the all-models
		// reset so downstream consumers don't trip on a missing field.
		const raw = [
			'Current session',
			'[████░░░░░░] 23% used',
			'Resets 6pm (America/Chicago)',
			'',
			'Current week (all models)',
			'[██████████] 58% used',
			'Resets May 16 at 6pm (America/Chicago)',
		].join('\n');
		const result = parseUsage(raw, '2026-05-13T22:00:00.000Z');
		expect(result).not.toBeNull();
		expect(result?.week_sonnet_only).toEqual({
			percent: 0,
			resets_at: result?.week_all_models.resets_at,
		});
	});

	it('recovers a section reset spec when "Resets" is mangled to "Reses" (TUI overdraw drops a char)', () => {
		// The live binary's TUI capture path collapses the session header,
		// bar, percent, and reset spec onto one line. Cursor positioning
		// occasionally drops a character from "Resets", leaving "Reses".
		// The inline-scan fallback should still recover the time spec.
		const raw = [
			'Current session██                                                4%usedReses7:50pm (America/Chicago)',
			'',
			'Currentweek(allmodels)',
			'70%used',
			'ResetsMay16at6pm(America/Chicago)',
			'',
			'Currentweek(Sonnetonly)',
			'0%used',
		].join('\n');
		const result = parseUsage(raw, '2026-05-13T20:00:00.000Z');
		expect(result).not.toBeNull();
		expect(result?.session.percent).toBe(4);
		// 7:50pm CDT on 2026-05-13 = 00:50 UTC on 2026-05-14
		expect(result?.session.resets_at).toBe('2026-05-14T00:50:00.000Z');
	});

	it('parses no-space "May14at10am" date+time reset specs', () => {
		const raw = [
			'Currentsession',
			'5%used',
			'Resets8pm(America/Chicago)',
			'',
			'Currentweek(allmodels)',
			'20%used',
			'ResetsMay14at10am(America/Chicago)',
			'',
			'Currentweek(Sonnetonly)',
			'0%used',
			'ResetsMay14at10am(America/Chicago)',
		].join('\n');
		const result = parseUsage(raw, '2026-05-13T20:00:00.000Z');
		expect(result?.week_all_models.resets_at).toBe('2026-05-14T15:00:00.000Z');
		// 8pm CDT on 2026-05-13 = 01:00 UTC on 2026-05-14
		expect(result?.session.resets_at).toBe('2026-05-14T01:00:00.000Z');
	});
});

describe('parseUsage — config_dir wiring', () => {
	it('returns the config_dir argument verbatim in the snapshot', () => {
		const { raw, meta } = loadFixture('usage-fresh');
		const result = parseUsage(raw, meta.now_iso, '/Users/pedram/.claude-gmail');
		expect(result?.config_dir).toBe('/Users/pedram/.claude-gmail');
	});

	it('defaults config_dir to the empty string when not provided', () => {
		const { raw, meta } = loadFixture('usage-fresh');
		const result = parseUsage(raw, meta.now_iso);
		expect(result?.config_dir).toBe('');
	});
});

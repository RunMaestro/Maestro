/**
 * @file usage-parser.test.ts
 * @description Tests for src/maestro-p/usage-parser.ts - parses Claude's
 * `/usage` panel (the screen-scrape source for --status mode) into the
 * StatusSnapshot wire envelope.
 *
 * Strategy: each fixture is a real-shape `/usage` raw text plus a sibling
 * `.expected.json` snapshot anchored at a fixed `now_iso` (and configDir).
 * The driver reads both, calls parseUsage, and asserts deep equality. The
 * fixture filenames document the *condition* under test (well-spaced,
 * collapsed, char-dropped header, etc.) so future failures point straight
 * at the format quirk that regressed.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import { parseUsage, RESET_SPEC_BODY } from '../../maestro-p/usage-parser';
import type { StatusSnapshot } from '../../maestro-p/json-emitter';

const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures', 'maestro-p-usage');

interface FixtureExpected {
	now_iso: string;
	config_dir: string;
	snapshot: StatusSnapshot;
}

function loadFixture(name: string): { raw: string; expected: FixtureExpected } {
	const raw = fs
		.readFileSync(path.join(FIXTURES_DIR, `${name}.txt`), 'utf-8')
		.replaceAll('\\u2014', '\u2014');
	const expected = JSON.parse(
		fs.readFileSync(path.join(FIXTURES_DIR, `${name}.expected.json`), 'utf-8')
	) as FixtureExpected;
	return { raw, expected };
}

function runFixture(name: string): void {
	const { raw, expected } = loadFixture(name);
	const result = parseUsage(raw, expected.now_iso, expected.config_dir);
	expect(result).toEqual(expected.snapshot);
}

describe('parseUsage / fixtures', () => {
	it('parses a well-spaced /usage panel', () => {
		runFixture('usage-well-spaced');
	});

	it('parses fully whitespace-collapsed lines (no spaces inside any row)', () => {
		runFixture('usage-collapsed');
	});

	it('parses the "Sonet nly" character-drop variant of the Sonnet header', () => {
		runFixture('usage-sonet-nly');
	});

	it('borrows week_all_models.resets_at when the Sonnet section has a percent but no Resets line', () => {
		runFixture('usage-sonnet-no-resets');
	});

	it('synthesizes a placeholder { percent: 0, resets_at: <all_models> } when the Sonnet section is absent', () => {
		runFixture('usage-sonnet-missing');
	});

	it('recovers the session reset via inline scan when "Resets" is dropped to "Reses" on a compound line', () => {
		runFixture('usage-reses-dropped');
	});

	it('parses the no-space "May14at10am(<zone>)" date+time spec and rolls to next year when the date is past now_iso', () => {
		runFixture('usage-no-space-date');
	});

	// Real-account captures (task 10). Both files are the verbatim
	// ANSI-stripped stderr maestro-p emitted while running --status
	// --stream-thinking on 2026-05-15. The gmail fixture is the
	// regression case for the `6m` → `6pm` PM-heuristic (see
	// RESET_SPEC_BODY in usage-parser.ts).
	it('parses a real /usage capture from the gmail account (compound session row, 6m PM-heuristic)', () => {
		runFixture('usage-gmail-2026-05-15');
	});

	it('parses a real /usage capture from the smash account (compound session row with intact 3:50am)', () => {
		runFixture('usage-smash-2026-05-15');
	});

	// Heavier panels (Team/Enterprise accounts, or any account with a long
	// "what's contributing" breakdown) paint entirely via cursor-addressing
	// with no line feeds, so the ANSI-stripped capture collapses into one glued
	// blob carrying multiple repaints. The parser must re-segment the sections
	// AND parse only the final (settled) paint - here the provisional first
	// paint shows session 99% and a week(all) row with no Resets line yet, while
	// the settled paint shows 100% / 44% / 23% with full reset timestamps.
	it('parses a cursor-addressed glued panel with no newlines, isolating the final repaint', () => {
		runFixture('usage-glued-no-newlines');
	});
});

describe('parseUsage / behavioral guards', () => {
	const configDir = '/Users/test/.claude';
	const nowIso = '2026-05-15T20:00:00Z';

	it('returns null when the session percent is missing', () => {
		const raw = [
			'Current session',
			'Resets 6pm (America/Chicago)',
			'',
			'Current week (all models)',
			'58% used',
			'Resets May 22 at 6pm (America/Chicago)',
			'',
			'Current week (Sonnet only)',
			'12% used',
			'Resets May 22 at 6pm (America/Chicago)',
		].join('\n');
		expect(parseUsage(raw, nowIso, configDir)).toBeNull();
	});

	it('returns null when the session resets line is missing entirely', () => {
		const raw = [
			'Current session',
			'23% used',
			'',
			'Current week (all models)',
			'58% used',
			'Resets May 22 at 6pm (America/Chicago)',
			'',
			'Current week (Sonnet only)',
			'12% used',
			'Resets May 22 at 6pm (America/Chicago)',
		].join('\n');
		expect(parseUsage(raw, nowIso, configDir)).toBeNull();
	});

	it('returns null when the week_all_models section is missing', () => {
		const raw = [
			'Current session',
			'23% used',
			'Resets 6pm (America/Chicago)',
			'',
			'Current week (Sonnet only)',
			'12% used',
			'Resets May 22 at 6pm (America/Chicago)',
		].join('\n');
		expect(parseUsage(raw, nowIso, configDir)).toBeNull();
	});

	it('strips ANSI escape codes before parsing', () => {
		const raw =
			'\x1b[1mCurrent session\x1b[0m\n' +
			'\x1b[33m23% used\x1b[0m\n' +
			'Resets 6pm (America/Chicago)\n\n' +
			'\x1b[1mCurrent week (all models)\x1b[0m\n' +
			'58% used\n' +
			'Resets May 22 at 6pm (America/Chicago)\n\n' +
			'Current week (Sonnet only)\n' +
			'12% used\n' +
			'Resets May 22 at 6pm (America/Chicago)\n';
		const result = parseUsage(raw, nowIso, configDir);
		expect(result?.session.percent).toBe(23);
		expect(result?.session.resets_at).toBe('2026-05-15T23:00:00.000Z');
	});

	it('time-only resets in the past today roll forward 24 hours', () => {
		const raw = [
			'Current session',
			'26% used',
			'Resets 1:40am (America/Chicago)',
			'',
			'Current week (all models)',
			'58% used',
			'Resets May 22 at 6pm (America/Chicago)',
			'',
			'Current week (Sonnet only)',
			'12% used',
			'Resets May 22 at 6pm (America/Chicago)',
		].join('\n');
		const result = parseUsage(raw, nowIso, configDir);
		// 1:40am Chicago on 2026-05-15 = 06:40 UTC, which is before
		// nowIso (20:00 UTC). Rolled +24h to 2026-05-16T06:40:00Z.
		expect(result?.session.resets_at).toBe('2026-05-16T06:40:00.000Z');
	});

	it('uses the provided configDir verbatim in the snapshot', () => {
		const { raw, expected } = loadFixture('usage-well-spaced');
		const customConfigDir = '/Users/pedram/.claude-other';
		const result = parseUsage(raw, expected.now_iso, customConfigDir);
		expect(result?.config_dir).toBe(customConfigDir);
	});

	it('rejects a percent-less section even when the Resets line is well-formed', () => {
		const raw = [
			'Current session',
			'Resets 6pm (America/Chicago)',
			'',
			'Current week (all models)',
			'58% used',
			'Resets May 22 at 6pm (America/Chicago)',
		].join('\n');
		expect(parseUsage(raw, nowIso, configDir)).toBeNull();
	});

	it('handles bogus IANA zone gracefully by rejecting the section', () => {
		const raw = [
			'Current session',
			'23% used',
			'Resets 6pm (Not/A_Real_Zone)',
			'',
			'Current week (all models)',
			'58% used',
			'Resets May 22 at 6pm (America/Chicago)',
		].join('\n');
		// Bogus zone -> session parse returns null -> top-level null
		expect(parseUsage(raw, nowIso, configDir)).toBeNull();
	});

	it('does NOT inline-scan Sonnet for a polluted bare reset spec (would lock onto prior section)', () => {
		// Sonnet's first line carries a bleed-over of the all_models trailing reset
		// (in a slightly different month) - we should NOT pick that up; instead the
		// borrow path returns all_models.resets_at.
		const raw = [
			'Current session',
			'23% used',
			'Resets 6pm (America/Chicago)',
			'',
			'Current week (all models)',
			'58% used',
			'Resets May 22 at 6pm (America/Chicago)',
			'',
			// First Sonnet line begins with a bare reset bleed from the prior section.
			'8pm(America/New_York) Current week (Sonnet only) 12% used',
		].join('\n');
		const result = parseUsage(raw, nowIso, configDir);
		// Borrowed from week_all_models, not the polluted 8pm(America/New_York) prefix.
		expect(result?.week_sonnet_only.percent).toBe(12);
		expect(result?.week_sonnet_only.resets_at).toBe('2026-05-22T23:00:00.000Z');
	});
});

describe('RESET_SPEC_BODY', () => {
	const re = new RegExp(RESET_SPEC_BODY, 'i');

	it('matches a time-only spec with spaces', () => {
		const m = '6pm (America/Chicago)'.match(re);
		expect(m?.groups?.hour).toBe('6');
		expect(m?.groups?.ampm?.toLowerCase()).toBe('pm');
		expect(m?.groups?.zone).toBe('America/Chicago');
		expect(m?.groups?.month).toBeUndefined();
	});

	it('matches a time-only spec with minutes and no inter-word spaces', () => {
		const m = '1:40am(America/Chicago)'.match(re);
		expect(m?.groups?.hour).toBe('1');
		expect(m?.groups?.minute).toBe('40');
		expect(m?.groups?.ampm?.toLowerCase()).toBe('am');
		expect(m?.groups?.zone).toBe('America/Chicago');
	});

	it('matches a date+time spec with spaces', () => {
		const m = 'May 22 at 6pm (America/Chicago)'.match(re);
		expect(m?.groups?.month).toBe('May');
		expect(m?.groups?.day).toBe('22');
		expect(m?.groups?.hour).toBe('6');
		expect(m?.groups?.ampm?.toLowerCase()).toBe('pm');
	});

	it('matches the fully-collapsed date+time form', () => {
		const m = 'May14at10am(America/Chicago)'.match(re);
		expect(m?.groups?.month).toBe('May');
		expect(m?.groups?.day).toBe('14');
		expect(m?.groups?.hour).toBe('10');
		expect(m?.groups?.ampm?.toLowerCase()).toBe('am');
		expect(m?.groups?.zone).toBe('America/Chicago');
	});

	it('keeps the month token from greedy-eating the day digits', () => {
		// Regression guard: a previous draft used `\w+` for month, which
		// would consume "May22" as a single 5-character word and lose the day.
		const m = 'May22at10am(America/Chicago)'.match(re);
		expect(m?.groups?.month).toBe('May');
		expect(m?.groups?.day).toBe('22');
	});

	it('matches a bare-m spec (claude dropped the p in pm) and resolves to PM', () => {
		// Real gmail-account compound session row renders "Resets 6pm" as
		// "Reses 6m" - both 't' and 'p' clobbered. The regex must still
		// match so the inline-scan reset extraction can recover; to24Hour
		// then resolves the lone 'm' as PM. See RESET_SPEC_BODY comment.
		const m = '6m (America/Chicago)'.match(re);
		expect(m?.groups?.hour).toBe('6');
		expect(m?.groups?.ampm?.toLowerCase()).toBe('m');
		expect(m?.groups?.zone).toBe('America/Chicago');
	});

	it('prefers the full "am" token over the bare-m fallback when both could match', () => {
		// Regex alternation order matters: `am|pm|m` lets the engine match
		// the full two-letter token when present (so we don't degrade
		// "6am" into hour=6 + ampm=m by greedily eating the m).
		const m = '6am(America/Chicago)'.match(re);
		expect(m?.groups?.hour).toBe('6');
		expect(m?.groups?.ampm?.toLowerCase()).toBe('am');
	});
});

describe('parseUsage / not-logged-in detection', () => {
	const configDir = '/Users/test/.claude-unauth';
	const nowIso = '2026-05-15T20:00:00Z';

	it('returns an unauthenticated snapshot when the status bar carries "Not logged in"', () => {
		// Real-capture shape: claude paints `Not logged in · Run /login` in
		// the status bar and `/usage` renders the API-billing variant
		// (Totals all 0). Parser should short-circuit to an unauthenticated
		// snapshot instead of attempting the Max-plan section walk.
		const raw = [
			'⏵⏵ auto mode on (shift+tab to cycle) Not logged in · Run /login',
			'',
			'Settings  Status  Config  Usage  Stats',
			'Session',
			'',
			'Total cost: $0.0000',
			'Total duration (API): 0s',
			'Usage: 0 input, 0 output, 0 cache read, 0 cache write',
		].join('\n');

		const result = parseUsage(raw, nowIso, configDir);

		expect(result).toEqual({
			type: 'status',
			auth_state: 'unauthenticated',
			config_dir: configDir,
			session: { percent: 0, resets_at: nowIso },
			week_all_models: { percent: 0, resets_at: nowIso },
			week_sonnet_only: { percent: 0, resets_at: nowIso },
		});
	});

	it('detects "Not logged in" even when cursor-positioning damage collapses inter-word spaces', () => {
		// `compressedKey` strips whitespace so `Notloggedin` matches the same
		// pattern as the well-spaced variant. This is the form we actually
		// captured from the .claude-0din account on macOS.
		const raw = '⏵⏵automodeon(shift+tabtocycle)Notloggedin·Run/login';
		const result = parseUsage(raw, nowIso, configDir);
		expect(result?.auth_state).toBe('unauthenticated');
	});

	it('prefers the unauthenticated short-circuit over attempting to parse sections', () => {
		// Even if the raw output happens to contain Max-plan-shaped section
		// headers (e.g. from a previous /usage invocation scrolled above the
		// "Not logged in" status bar), the bar wins - sections from before
		// a logout no longer represent live state.
		const raw = [
			'Current session',
			'23% used',
			'Resets 6pm (America/Chicago)',
			'',
			'⏵⏵ Not logged in · Run /login',
		].join('\n');
		const result = parseUsage(raw, nowIso, configDir);
		expect(result?.auth_state).toBe('unauthenticated');
		expect(result?.session.percent).toBe(0);
	});
});

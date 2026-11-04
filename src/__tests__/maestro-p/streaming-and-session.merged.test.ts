// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/maestro-p/usage-parser.test.ts
// Source: src/__tests__/maestro-p/session-watcher.test.ts
// Source: src/__tests__/maestro-p/stream-json-input.test.ts
import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import * as s1_fs from 'fs';
import * as s1_path from 'path';
import { parseUsage, RESET_SPEC_BODY } from '../../maestro-p/usage-parser';
import type { StatusSnapshot } from '../../maestro-p/json-emitter';
import * as s2_fs from 'fs';
import * as s2_os from 'os';
import * as s2_path from 'path';
import {
	DEFAULT_DISCOVERY_POLL_INTERVAL_MS,
	DEFAULT_DISCOVERY_TIMEOUT_MS,
	cwdSlug,
	discoverSessionId,
	findLatestSessionId,
	noConversationFoundMessage,
	sessionTranscriptPath,
} from '../../maestro-p/session-watcher';
import { getErrorPatterns, matchErrorPattern } from '../../shared/agentErrorPatterns';
import { encodeClaudeProjectPath } from '../../shared/pathUtils';
/**
 * @file stream-json-input.test.ts
 * @description Tests for src/maestro-p/stream-json-input.ts - translation of
 * Maestro's `--input-format stream-json` envelope into a TUI-ready prompt
 * with `@/tmp/.../*.png` image mentions.
 */
import * as s3_fs from 'fs';
import * as s3_os from 'os';
import * as s3_path from 'path';
import {
	cleanupStreamJsonImages,
	translateStreamJsonInput,
} from '../../maestro-p/stream-json-input';
// Source: src/__tests__/maestro-p/usage-parser.test.ts
describe('', () => {
	const FIXTURES_DIR = s1_path.join(__dirname, '..', 'fixtures', 'maestro-p-usage');
	interface FixtureExpected {
		now_iso: string;
		config_dir: string;
		snapshot: StatusSnapshot;
	}
	function loadFixture(name: string): {
		raw: string;
		expected: FixtureExpected;
	} {
		const raw = s1_fs
			.readFileSync(s1_path.join(FIXTURES_DIR, `${name}.txt`), 'utf-8')
			.replaceAll('\\u2014', '\u2014');
		const expected = JSON.parse(
			s1_fs.readFileSync(s1_path.join(FIXTURES_DIR, `${name}.expected.json`), 'utf-8')
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
		it('synthesizes a placeholder { percent: 0, resets_at: <all_models>, unread: true } when the Sonnet section is absent', () => {
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
		// Real capture from an account that had burned its entire weekly limit
		// (2026-08-19). It carries BOTH regressions that made such an account
		// invisible in the dashboard: the settled paint has no "Resets" row under
		// the idle 0% session (the parser used to return null for the whole panel),
		// and the second weekly window is named "(Fable)" rather than
		// "(Sonnet only)" (the header regex used to miss it and report 0%).
		it('parses an exhausted account whose session row has no Resets and whose second week is "(Fable)"', () => {
			runFixture('usage-exhausted-fable-no-session-reset');
		});
		// Real raw PTY capture (2026-09-11, escapes intact, shell-prompt username
		// redacted). Claude drew the panel in the alternate screen, and its final
		// paint re-sent only "Fable)" and "72% used" for the second weekly window -
		// "Current week (" and the bar were left standing from the prior frame.
		// Stripped, that section parsed as an unread 0%; replayed, it is Fable 72%.
		it('parses a real alternate-screen capture whose repaint skipped unchanged cells', () => {
			runFixture('usage-alt-screen-repaint-2026-09-11');
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
		it('keeps the snapshot and omits resets_at when the session resets line is missing entirely', () => {
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
			const result = parseUsage(raw, nowIso, configDir);
			expect(result?.session).toEqual({ percent: 23 });
			expect(result?.week_all_models.percent).toBe(58);
			expect(result?.week_sonnet_only.percent).toBe(12);
		});
		it('reports the second weekly window under whatever model name the panel used', () => {
			const raw = [
				'Current session',
				'23% used',
				'Resets 6pm (America/Chicago)',
				'',
				'Current week (all models)',
				'58% used',
				'Resets May 22 at 6pm (America/Chicago)',
				'',
				'Current week (Opus)',
				'12% used',
				'Resets May 22 at 6pm (America/Chicago)',
			].join('\n');
			const result = parseUsage(raw, nowIso, configDir);
			expect(result?.week_sonnet_only).toEqual({
				percent: 12,
				resets_at: '2026-05-22T23:00:00.000Z',
				label: 'Opus',
			});
		});
		it('does not mistake a repeated all-models header for the second weekly window', () => {
			const raw = [
				'Current session',
				'23% used',
				'Resets 6pm (America/Chicago)',
				'',
				'Current week (all models)',
				'58% used',
				'Resets May 22 at 6pm (America/Chicago)',
				'',
				'Current week (all models)',
				'99% used',
				'Resets May 22 at 6pm (America/Chicago)',
			].join('\n');
			const result = parseUsage(raw, nowIso, configDir);
			expect(result?.week_all_models.percent).toBe(58);
			// Placeholder, not the duplicate header's 99%.
			expect(result?.week_sonnet_only).toEqual({
				percent: 0,
				resets_at: '2026-05-22T23:00:00.000Z',
				unread: true,
			});
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
		it('reads an alternate-screen repaint off the replayed screen, not the stripped bytes', () => {
			// The diffing renderer's second paint rewrites only the cells that changed:
			// the header tail and the percentage. Stripped, the bytes still say "Opus"
			// at 12% with a "Fable)18%" fragment trailing; the screen reads Fable at 18%.
			const raw =
				'\x1b[?1049h\x1b[2J\x1b[H' +
				'Current session\r\n23% used\r\nResets 6pm (America/Chicago)\r\n\r\n' +
				'Current week (all models)\r\n58% used\r\nResets May 22 at 6pm (America/Chicago)\r\n\r\n' +
				'Current week (Opus)\r\n12% used\r\nResets May 22 at 6pm (America/Chicago)' +
				'\x1b[9;15HFable)\x1b[K\x1b[10;1H18%';
			const result = parseUsage(raw, nowIso, configDir);
			expect(result?.session).toEqual({ percent: 23, resets_at: '2026-05-15T23:00:00.000Z' });
			expect(result?.week_sonnet_only).toEqual({
				percent: 18,
				resets_at: '2026-05-22T23:00:00.000Z',
				label: 'Fable',
			});
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
		it('handles a bogus IANA zone by dropping that reset time, not the whole panel', () => {
			const raw = [
				'Current session',
				'23% used',
				'Resets 6pm (Not/A_Real_Zone)',
				'',
				'Current week (all models)',
				'58% used',
				'Resets May 22 at 6pm (America/Chicago)',
			].join('\n');
			const result = parseUsage(raw, nowIso, configDir);
			expect(result?.session).toEqual({ percent: 23 });
			expect(result?.week_all_models.resets_at).toBe('2026-05-22T23:00:00.000Z');
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
	/**
	 * The /usage retry added for #1595 re-sends into a live TUI, and
	 * `TuiDriver.getScreenCapture()` is an ACCUMULATOR - a retry's panel arrives
	 * APPENDED to the previous one rather than replacing it. These tests pin the
	 * parser behavior the retry leans on, because the obvious "fix" (clear the
	 * capture between attempts) would break it.
	 */
	describe('parseUsage / stacked /usage panels (what the retry leans on)', () => {
		const NOW = '2026-05-15T20:00:00Z';
		const CONFIG_DIR = '/Users/test/.claude';
		const panel = () => loadFixture('usage-well-spaced').raw;
		it('reads the LAST panel when a retry appends a fresh one to a stale one', () => {
			// This is what a successful retry actually looks like on the wire: attempt 1's
			// panel is still in the buffer and attempt 2's is glued onto the end.
			// sliceToFinalPanel anchors on the last `Current session` header, so the fresh
			// numbers win outright and nothing leaks forward from the stale panel.
			const stale = panel();
			const fresh = stale.replace('23% used', '91% used').replace('58% used', '99% used');
			const stacked = parseUsage(stale + fresh, NOW, CONFIG_DIR);
			expect(stacked?.session.percent).toBe(91);
			expect(stacked?.week_all_models.percent).toBe(99);
			expect(stacked).toEqual(parseUsage(fresh, NOW, CONFIG_DIR));
		});
		it('still returns null when the appended retry panel is only half painted', () => {
			// The failure this retry exists to survive: the panel was still rendering when
			// the debounce expired. Anchoring on the trailing partial keeps the answer
			// null rather than quietly re-emitting the previous panel as if it were fresh,
			// so the loop retries instead of shipping a stale number.
			const complete = panel();
			const halfPainted = complete
				.replace('23% used', '91% used')
				.split('Current week (all models)')[0];
			expect(parseUsage(complete, NOW, CONFIG_DIR)).not.toBeNull();
			expect(parseUsage(complete + halfPainted, NOW, CONFIG_DIR)).toBeNull();
		});
		it('keeps reading a differential repaint that carries no fresh section header', () => {
			// Why the capture must NOT be cleared between attempts. Claude repaints by
			// cursor-addressing, so a re-render can deliver only the cells that changed -
			// here a bare percentage with no `Current session` header behind it. Against
			// the accumulated buffer that still resolves; against a cleared one it is
			// anchorless fragments, and every retry would parse to null.
			const base = panel();
			const differentialRepaint = '\n47% used\n';
			expect(parseUsage(base + differentialRepaint, NOW, CONFIG_DIR)).not.toBeNull();
			expect(parseUsage(differentialRepaint, NOW, CONFIG_DIR)).toBeNull();
		});
	});
});
// Source: src/__tests__/maestro-p/session-watcher.test.ts
describe('', () => {
	const FAST_POLL_MS = 10;
	async function sleep(ms: number): Promise<void> {
		await new Promise<void>((resolve) => setTimeout(resolve, ms));
	}
	function expectDiscoveryRejection(
		promise: Promise<unknown>,
		message: RegExp | string
	): Promise<void> {
		return promise.then(
			() => {
				throw new Error('Expected session discovery to reject');
			},
			(error: unknown) => {
				expect(error).toBeInstanceOf(Error);
				if (error instanceof Error) {
					expect(error.message).toMatch(message);
				}
			}
		);
	}
	describe('session-watcher', () => {
		let tempDir: string;
		let configDir: string;
		const cwd = '/Users/test/example-proj';
		const expectedSlug = '-Users-test-example-proj';
		beforeEach(() => {
			tempDir = s2_fs.mkdtempSync(s2_path.join(s2_os.tmpdir(), 'maestro-p-session-watcher-'));
			configDir = s2_path.join(tempDir, '.claude');
		});
		afterEach(() => {
			s2_fs.rmSync(tempDir, { recursive: true, force: true });
		});
		function projectsDir(): string {
			return s2_path.join(configDir, 'projects', expectedSlug);
		}
		function ensureProjectsDir(): void {
			s2_fs.mkdirSync(projectsDir(), { recursive: true });
		}
		function writeJsonl(sessionId: string, content = ''): string {
			ensureProjectsDir();
			const full = s2_path.join(projectsDir(), `${sessionId}.jsonl`);
			s2_fs.writeFileSync(full, content);
			return full;
		}
		describe('exposed constants', () => {
			it('DEFAULT_DISCOVERY_TIMEOUT_MS = 10000 (matches the run-mode spec)', () => {
				expect(DEFAULT_DISCOVERY_TIMEOUT_MS).toBe(10000);
			});
			it('DEFAULT_DISCOVERY_POLL_INTERVAL_MS = 75 (matches JsonlTailer cadence)', () => {
				expect(DEFAULT_DISCOVERY_POLL_INTERVAL_MS).toBe(75);
			});
		});
		describe('cwdSlug()', () => {
			it('replaces every non-alphanumeric character with `-` (canonical claude rule)', () => {
				expect(cwdSlug('/Users/test/example-proj')).toBe('-Users-test-example-proj');
			});
			it('replaces dots (which look alphanumeric to the eye) with `-`', () => {
				// `/Users/foo/.claude-mem/observer` and `/Users/foo/.claude-mem-observer`
				// collide under this rule - that's a known claude behavior, not our
				// problem to disambiguate.
				expect(cwdSlug('/Users/foo/.claude-mem/observer')).toBe('-Users-foo--claude-mem-observer');
			});
			it('handles a path that is already all dashes / hyphens', () => {
				expect(cwdSlug('---')).toBe('---');
			});
			it('handles an empty string', () => {
				expect(cwdSlug('')).toBe('');
			});
			it('strips trailing separators so a cwd saved with one still resolves', () => {
				expect(cwdSlug('/Users/test/example-proj/')).toBe('-Users-test-example-proj');
				expect(cwdSlug('C:\\Users\\test\\repo\\')).toBe('C--Users-test-repo');
			});
			it('leaves filesystem roots intact', () => {
				expect(cwdSlug('/')).toBe('-');
				expect(cwdSlug('C:\\')).toBe('C--');
			});
			// cwdSlug deliberately inlines the encoding rule instead of importing
			// src/shared/pathUtils.ts, because the maestro-p bundle stays lean and
			// that module pulls in fs/os helpers it has no other use for. The cost
			// of that choice is drift: if one side learns a normalization the other
			// doesn't, maestro-p and the desktop app look in different directories
			// for the same project and session discovery silently returns nothing.
			// This test is what makes the duplication safe - it fails the moment
			// the two implementations disagree on any input.
			it('stays byte-for-byte identical to the canonical encodeClaudeProjectPath()', () => {
				const paths = [
					'/Users/test/example-proj',
					'/Users/test/example-proj/',
					'/Users/test/example-proj///',
					'C:\\Users\\test\\repo',
					'C:\\Users\\test\\repo\\',
					'C:\\Users\\test\\repo\\\\',
					'/Users/foo/.claude-mem/observer',
					'/Users/foo/.claude-mem-observer',
					'/path/with spaces/and_underscores',
					'/',
					'//',
					'C:\\',
					'---',
					'',
				];
				for (const input of paths) {
					expect(
						cwdSlug(input),
						`cwdSlug drifted from encodeClaudeProjectPath for ${JSON.stringify(input)}`
					).toBe(encodeClaudeProjectPath(input));
				}
			});
		});
		describe('sessionTranscriptPath()', () => {
			it('points at <configDir>/projects/<slug>/<id>.jsonl, where claude writes it', () => {
				const written = writeJsonl('abc-123');
				expect(sessionTranscriptPath(configDir, cwd, 'abc-123')).toBe(written);
			});
		});
		describe('noConversationFoundMessage()', () => {
			// The desktop recovers a dead resume only when the failure classifies as
			// session_not_found. A TUI turn must read exactly like a print turn.
			it('classifies as session_not_found for claude-code', () => {
				const match = matchErrorPattern(
					getErrorPatterns('claude-code'),
					noConversationFoundMessage('607fee3e-cf47-4ef8-a7d9-e6bb4931cca7')
				);
				expect(match?.type).toBe('session_not_found');
			});
		});
		describe('discoverSessionId()', () => {
			it('returns the basename and full path of a file dropped after spawnTimestamp', async () => {
				const spawnTimestamp = Date.now();
				// Tiny wait so the file's birthtime is strictly after spawnTimestamp
				// on filesystems with coarse-grained timestamps.
				await sleep(5);
				const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
				const filePath = writeJsonl(sessionId);
				const result = await discoverSessionId({
					configDir,
					cwd,
					spawnTimestamp,
					timeoutMs: 1000,
					pollIntervalMs: FAST_POLL_MS,
				});
				expect(result.sessionId).toBe(sessionId);
				expect(result.jsonlPath).toBe(filePath);
			});
			it('ignores pre-existing files whose creation time is before spawnTimestamp', async () => {
				ensureProjectsDir();
				writeJsonl('old-session-id');
				// Wait so `Date.now()` is observably after the old file's birthtime.
				await sleep(20);
				const spawnTimestamp = Date.now();
				await sleep(5);
				const newId = 'new-session-id';
				writeJsonl(newId);
				const result = await discoverSessionId({
					configDir,
					cwd,
					spawnTimestamp,
					timeoutMs: 1000,
					pollIntervalMs: FAST_POLL_MS,
				});
				expect(result.sessionId).toBe(newId);
			});
			it('picks the earliest among multiple eligible candidates', async () => {
				const spawnTimestamp = Date.now();
				await sleep(5);
				const firstId = 'first-id';
				const firstPath = writeJsonl(firstId);
				// Stagger so birthtimes differ even on coarse-resolution filesystems.
				await sleep(30);
				writeJsonl('second-id');
				const result = await discoverSessionId({
					configDir,
					cwd,
					spawnTimestamp,
					timeoutMs: 1000,
					pollIntervalMs: FAST_POLL_MS,
				});
				expect(result.sessionId).toBe(firstId);
				expect(result.jsonlPath).toBe(firstPath);
			});
			it('with expectSessionId, returns THAT file even when a sibling appears first (no cross-talk)', async () => {
				const spawnTimestamp = Date.now();
				await sleep(5);
				// A concurrent sibling session writes its transcript FIRST. The legacy
				// earliest-new heuristic would wrongly attach to this one.
				writeJsonl('sibling-concurrent-id');
				await sleep(30);
				const mineId = 'my-pre-assigned-id';
				const minePath = writeJsonl(mineId);
				const result = await discoverSessionId({
					configDir,
					cwd,
					spawnTimestamp,
					expectSessionId: mineId,
					timeoutMs: 1000,
					pollIntervalMs: FAST_POLL_MS,
				});
				// Must resolve to the pre-assigned id, NOT the earlier sibling.
				expect(result.sessionId).toBe(mineId);
				expect(result.jsonlPath).toBe(minePath);
			});
			it('with expectSessionId, waits for the specific file and ignores unrelated ones', async () => {
				const spawnTimestamp = Date.now();
				const mineId = 'expected-late-id';
				const discoveryPromise = discoverSessionId({
					configDir,
					cwd,
					spawnTimestamp,
					expectSessionId: mineId,
					timeoutMs: 1500,
					pollIntervalMs: FAST_POLL_MS,
				});
				// An unrelated session appears first; discovery must NOT resolve on it.
				await sleep(30);
				writeJsonl('unrelated-id');
				await sleep(30);
				const minePath = writeJsonl(mineId);
				const result = await discoveryPromise;
				expect(result.sessionId).toBe(mineId);
				expect(result.jsonlPath).toBe(minePath);
			});
			it('with expectSessionId, rejects with a descriptive error if that file never appears', async () => {
				const spawnTimestamp = Date.now();
				// A different session shows up, but never the expected one.
				writeJsonl('some-other-id');
				vi.useFakeTimers();
				try {
					const discoveryPromise = discoverSessionId({
						configDir,
						cwd,
						spawnTimestamp,
						expectSessionId: 'never-written-id',
						timeoutMs: 250,
						pollIntervalMs: FAST_POLL_MS,
					});
					const rejection = expectDiscoveryRejection(
						discoveryPromise,
						/never-written-id\.jsonl did not appear/
					);
					await vi.advanceTimersByTimeAsync(250);
					await rejection;
				} finally {
					vi.useRealTimers();
				}
			});
			it('tolerates the projects dir not existing yet - picks up the file once it appears', async () => {
				const spawnTimestamp = Date.now();
				// Kick off discovery before the directory exists. Claude lazily
				// creates `projects/<slug>/` on the first session for a cwd.
				const discoveryPromise = discoverSessionId({
					configDir,
					cwd,
					spawnTimestamp,
					timeoutMs: 1500,
					pollIntervalMs: FAST_POLL_MS,
				});
				// Drop the file mid-flight after a brief delay.
				await sleep(40);
				const sessionId = 'late-session-id';
				const filePath = writeJsonl(sessionId);
				const result = await discoveryPromise;
				expect(result.sessionId).toBe(sessionId);
				expect(result.jsonlPath).toBe(filePath);
			});
			it('ignores non-.jsonl entries in the projects dir', async () => {
				ensureProjectsDir();
				const spawnTimestamp = Date.now();
				await sleep(5);
				s2_fs.writeFileSync(s2_path.join(projectsDir(), 'README.md'), 'noise');
				s2_fs.writeFileSync(s2_path.join(projectsDir(), 'config.json'), '{}');
				const sessionId = 'real-session';
				const filePath = writeJsonl(sessionId);
				const result = await discoverSessionId({
					configDir,
					cwd,
					spawnTimestamp,
					timeoutMs: 1000,
					pollIntervalMs: FAST_POLL_MS,
				});
				expect(result.sessionId).toBe(sessionId);
				expect(result.jsonlPath).toBe(filePath);
			});
			it('ignores subdirectories that happen to end in .jsonl', async () => {
				ensureProjectsDir();
				const spawnTimestamp = Date.now();
				await sleep(5);
				s2_fs.mkdirSync(s2_path.join(projectsDir(), 'weird-dir.jsonl'));
				const sessionId = 'real-session';
				writeJsonl(sessionId);
				const result = await discoverSessionId({
					configDir,
					cwd,
					spawnTimestamp,
					timeoutMs: 1000,
					pollIntervalMs: FAST_POLL_MS,
				});
				expect(result.sessionId).toBe(sessionId);
			});
			it('rejects with a descriptive error when no file appears within the timeout', async () => {
				const spawnTimestamp = Date.now();
				vi.useFakeTimers();
				try {
					const discoveryPromise = discoverSessionId({
						configDir,
						cwd,
						spawnTimestamp,
						timeoutMs: 100,
						pollIntervalMs: FAST_POLL_MS,
					});
					const rejection = expectDiscoveryRejection(discoveryPromise, /no new \.jsonl appeared/);
					await vi.advanceTimersByTimeAsync(100);
					await rejection;
				} finally {
					vi.useRealTimers();
				}
			});
			it('rejects when only pre-spawn files exist (i.e., none satisfy the timestamp filter)', async () => {
				ensureProjectsDir();
				writeJsonl('stale-session');
				await sleep(20);
				const spawnTimestamp = Date.now();
				vi.useFakeTimers();
				try {
					const discoveryPromise = discoverSessionId({
						configDir,
						cwd,
						spawnTimestamp,
						timeoutMs: 100,
						pollIntervalMs: FAST_POLL_MS,
					});
					const rejection = expectDiscoveryRejection(discoveryPromise, /no new \.jsonl appeared/);
					await vi.advanceTimersByTimeAsync(100);
					await rejection;
				} finally {
					vi.useRealTimers();
				}
			});
			it('builds the watch path from configDir + projects/ + cwdSlug(cwd)', async () => {
				// Files dropped in the WRONG cwd-slug must not be picked up.
				const otherSlugDir = s2_path.join(configDir, 'projects', '-Users-test-other');
				s2_fs.mkdirSync(otherSlugDir, { recursive: true });
				const spawnTimestamp = Date.now();
				await sleep(5);
				s2_fs.writeFileSync(s2_path.join(otherSlugDir, 'wrong-session.jsonl'), '');
				vi.useFakeTimers();
				try {
					const wrongPathPromise = discoverSessionId({
						configDir,
						cwd,
						spawnTimestamp,
						timeoutMs: 100,
						pollIntervalMs: FAST_POLL_MS,
					});
					const wrongPathRejection = expectDiscoveryRejection(
						wrongPathPromise,
						/no new \.jsonl appeared/
					);
					await vi.advanceTimersByTimeAsync(100);
					await wrongPathRejection;
					// And the error mentions the correct (expected) directory.
					const expectedPathPromise = discoverSessionId({
						configDir,
						cwd,
						spawnTimestamp,
						timeoutMs: 50,
						pollIntervalMs: FAST_POLL_MS,
					});
					const expectedPathRejection = expectDiscoveryRejection(expectedPathPromise, expectedSlug);
					await vi.advanceTimersByTimeAsync(50);
					await expectedPathRejection;
				} finally {
					vi.useRealTimers();
				}
			});
			// `/clear` rotates claude onto a new session while the old transcript is
			// still being tailed; the rotation watch must never hand back the session
			// it is already following.
			it('skips excludeSessionIds in the earliest-new scan', async () => {
				const spawnTimestamp = Date.now() - 1000;
				writeJsonl('aaaa-current');
				await sleep(20);
				writeJsonl('bbbb-rotated');
				const result = await discoverSessionId({
					configDir,
					cwd,
					spawnTimestamp,
					excludeSessionIds: new Set(['aaaa-current']),
					timeoutMs: 500,
					pollIntervalMs: FAST_POLL_MS,
				});
				expect(result.sessionId).toBe('bbbb-rotated');
			});
			it('keeps waiting when only an excluded session exists', async () => {
				writeJsonl('aaaa-current');
				await expectDiscoveryRejection(
					discoverSessionId({
						configDir,
						cwd,
						spawnTimestamp: Date.now() - 1000,
						excludeSessionIds: new Set(['aaaa-current']),
						timeoutMs: 60,
						pollIntervalMs: FAST_POLL_MS,
					}),
					/no new \.jsonl appeared/
				);
			});
		});
		// claude refuses `--continue` together with the `--session-id` maestro-p
		// pre-assigns, so run mode resolves the session `--continue` would pick.
		describe('findLatestSessionId()', () => {
			const A = '11111111-2222-4333-8444-555555555555';
			const B = '66666666-7777-4888-9999-aaaaaaaaaaaa';
			function setMtime(file: string, secondsAgo: number): void {
				const t = new Date(Date.now() - secondsAgo * 1000);
				s2_fs.utimesSync(file, t, t);
			}
			it('returns null when the project folder does not exist', async () => {
				expect(await findLatestSessionId(configDir, cwd)).toBeNull();
			});
			it('returns null when the folder holds no session transcripts', async () => {
				ensureProjectsDir();
				s2_fs.writeFileSync(s2_path.join(projectsDir(), 'notes.txt'), 'x');
				expect(await findLatestSessionId(configDir, cwd)).toBeNull();
			});
			it('picks the most recently written transcript, not the newest file name', async () => {
				setMtime(writeJsonl(B), 300);
				setMtime(writeJsonl(A), 10);
				expect(await findLatestSessionId(configDir, cwd)).toBe(A);
			});
			it('ignores files that are not `<uuid>.jsonl` and folders named like one', async () => {
				setMtime(writeJsonl(A), 300);
				setMtime(writeJsonl('agent-1234'), 1);
				s2_fs.mkdirSync(s2_path.join(projectsDir(), `${B}.jsonl`));
				expect(await findLatestSessionId(configDir, cwd)).toBe(A);
			});
		});
	});
});
// Source: src/__tests__/maestro-p/stream-json-input.test.ts
describe('', () => {
	// 1x1 transparent PNG, base64-encoded. Small enough to keep tests fast; the
	// translator only validates that bytes get written, not that they decode as
	// real pixels.
	const TINY_PNG_BASE64 =
		'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
	function buildEnvelope(content: unknown): string {
		return JSON.stringify({
			type: 'user',
			message: { role: 'user', content },
		});
	}
	describe('translateStreamJsonInput', () => {
		const created: string[] = [];
		afterEach(() => {
			cleanupStreamJsonImages(created);
			created.length = 0;
		});
		it('returns null for non-JSON input', () => {
			expect(translateStreamJsonInput('hello world')).toBeNull();
		});
		it('returns null for an empty string', () => {
			expect(translateStreamJsonInput('')).toBeNull();
		});
		it('returns null for JSON without a message.content array', () => {
			expect(translateStreamJsonInput(JSON.stringify({ type: 'user' }))).toBeNull();
			expect(translateStreamJsonInput(JSON.stringify({ message: { role: 'user' } }))).toBeNull();
		});
		it('extracts a text-only envelope as a plain prompt', () => {
			const out = translateStreamJsonInput(
				buildEnvelope([{ type: 'text', text: 'describe this' }])
			);
			expect(out).not.toBeNull();
			expect(out!.prompt).toBe('describe this');
			expect(out!.imagePaths).toEqual([]);
		});
		it('writes a base64 image to /tmp and rewrites the prompt as `@path text`', () => {
			const out = translateStreamJsonInput(
				buildEnvelope([
					{
						type: 'image',
						source: { type: 'base64', media_type: 'image/png', data: TINY_PNG_BASE64 },
					},
					{ type: 'text', text: 'what is this image?' },
				])
			);
			expect(out).not.toBeNull();
			expect(out!.imagePaths).toHaveLength(1);
			created.push(...out!.imagePaths);
			const imgPath = out!.imagePaths[0];
			expect(imgPath.startsWith(s3_os.tmpdir() + s3_path.sep)).toBe(true);
			expect(imgPath.endsWith('.png')).toBe(true);
			expect(s3_fs.existsSync(imgPath)).toBe(true);
			const bytes = s3_fs.readFileSync(imgPath);
			expect(bytes.equals(Buffer.from(TINY_PNG_BASE64, 'base64'))).toBe(true);
			expect(out!.prompt).toBe(`@${imgPath} what is this image?`);
		});
		it('preserves image order and joins multiple mentions with spaces', () => {
			const out = translateStreamJsonInput(
				buildEnvelope([
					{
						type: 'image',
						source: { type: 'base64', media_type: 'image/jpeg', data: TINY_PNG_BASE64 },
					},
					{
						type: 'image',
						source: { type: 'base64', media_type: 'image/png', data: TINY_PNG_BASE64 },
					},
					{ type: 'text', text: 'compare' },
				])
			);
			expect(out).not.toBeNull();
			expect(out!.imagePaths).toHaveLength(2);
			created.push(...out!.imagePaths);
			expect(out!.imagePaths[0].endsWith('.jpeg')).toBe(true);
			expect(out!.imagePaths[1].endsWith('.png')).toBe(true);
			expect(out!.prompt).toBe(`@${out!.imagePaths[0]} @${out!.imagePaths[1]} compare`);
		});
		it('handles image-only envelopes (no text block) by emitting just the mention', () => {
			const out = translateStreamJsonInput(
				buildEnvelope([
					{
						type: 'image',
						source: { type: 'base64', media_type: 'image/png', data: TINY_PNG_BASE64 },
					},
				])
			);
			expect(out).not.toBeNull();
			expect(out!.imagePaths).toHaveLength(1);
			created.push(...out!.imagePaths);
			expect(out!.prompt).toBe(`@${out!.imagePaths[0]}`);
		});
		it('rejects images with a malformed media_type (no temp file written)', () => {
			const out = translateStreamJsonInput(
				buildEnvelope([
					{
						type: 'image',
						source: {
							type: 'base64',
							media_type: '../etc/passwd',
							data: TINY_PNG_BASE64,
						},
					},
					{ type: 'text', text: 'what?' },
				])
			);
			expect(out).not.toBeNull();
			expect(out!.imagePaths).toEqual([]);
			expect(out!.prompt).toBe('what?');
		});
		it('skips unknown content block types without crashing', () => {
			const out = translateStreamJsonInput(
				buildEnvelope([
					{ type: 'tool_use', name: 'foo' },
					{ type: 'text', text: 'hello' },
				])
			);
			expect(out).not.toBeNull();
			expect(out!.imagePaths).toEqual([]);
			expect(out!.prompt).toBe('hello');
		});
	});
	describe('cleanupStreamJsonImages', () => {
		it('unlinks each path and silently ignores already-missing files', () => {
			const tmp = s3_path.join(s3_os.tmpdir(), `maestro-p-cleanup-test-${process.pid}.txt`);
			s3_fs.writeFileSync(tmp, 'x');
			expect(s3_fs.existsSync(tmp)).toBe(true);
			cleanupStreamJsonImages([tmp, '/nonexistent/path/that-does-not-exist']);
			expect(s3_fs.existsSync(tmp)).toBe(false);
		});
	});
});

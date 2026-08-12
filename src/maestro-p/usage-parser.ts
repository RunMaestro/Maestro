// Parser for Claude's `/usage` panel output (maestro-p --status mode).
//
// Why this exists
// ---------------
// `/usage` writes a panel directly to the TUI screen rather than the
// JSONL transcript, so unlike the run-mode path this binary's source of
// truth IS the screen scrape. Every rule below was forced on us by real
// captures of that screen.
//
// Cursor-positioning damage
// -------------------------
// Claude renders `/usage` via cursor moves inside an already-painted
// terminal. After we strip ANSI, the visible artifacts are:
//   - Inter-word spaces erased: "Currentsession", "26%used",
//     "Resets1:40am(America/Chicago)".
//   - Whole characters dropped, consistently: "Current week (Sonet nly)"
//     instead of "(Sonnet only)".
//   - Compound rows where header + percent + reset are on one line and
//     the "Resets" prefix decays to "Reses" or worse.
//   - Prior section's trailing reset timestamp bleeds onto the next
//     section's first line as a bare `<time>(<zone>)` fragment.
//
// All four cases came out of the captures the conductor took on the
// prior pass - see MAESTRO-P-01-binary.md "Architectural Lesson #3".
//
// Approach
// --------
// - Match section headers against a whitespace-stripped, lowercased view
//   of each line so "Current session" and "Currentsession" both hit.
// - Use a fuzzy header for the Sonnet section (`/^currentweek\([a-z]*nly\)/`)
//   to absorb the character-drop variants.
// - Percent and reset patterns allow `\s*` (not `\s+`) for the same reason.
// - Sonnet has best-effort fallbacks: borrow `resets_at` from
//   `week_all_models` when its own line is too garbled, and synthesize a
//   { percent: 0, resets_at } placeholder if the whole section is missing
//   so downstream consumers always see a populated field.
// - Sonnet specifically does NOT use the inline-scan fallback for resets -
//   when its line is polluted, the polluted prefix is the *prior* section's
//   trailing reset (a cursor-positioning carryover), so inline-scanning
//   would lock onto the wrong value.
//
// Signature deviation from the playbook
// -------------------------------------
// The playbook documents `parseUsage(raw, nowIso): StatusSnapshot | null`,
// but `StatusSnapshot.config_dir` cannot come from the screen-scrape - it's
// a runtime concern (the caller already resolved `CLAUDE_CONFIG_DIR ?? ~/.claude`).
// We accept `configDir` as a third argument so the returned snapshot is
// the complete wire envelope and can be passed verbatim to `emitStatus()`
// in the --status runner block.

import { stripAnsiCodes } from '../shared/stringUtils';
import type { StatusSnapshot } from './json-emitter';

// Body of a reset spec - the part AFTER the optional "Resets" prefix.
// Tolerates:
//   "6pm (America/Chicago)"
//   "1:40am(America/Chicago)"                  (no internal spaces)
//   "May 22 at 6pm (America/Chicago)"
//   "May14at10am(America/Chicago)"             (no internal spaces)
//   "6m (America/Chicago)"                     (claude dropped the 'p')
//
// Month token is `[A-Za-z]+` (not `\w+`) so it doesn't greedy-eat the
// following day digits. Every internal whitespace is `\s*` for the same
// cursor-collapse reason as the surrounding patterns.
//
// ampm alternation is ordered `am|pm|m` so the regex matches the full
// two-letter token when present and only falls through to bare `m` when
// the leading letter was clobbered. A lone `m` resolves to PM (see
// to24Hour) - this is a heuristic justified by real captures: the gmail
// account's compound session row consistently renders "6pm" as "6m"
// (drops the 'p'), while "am" tokens stay intact in every capture we
// have. Cost of being wrong on a hypothetical clobbered `am`: 12-hour
// drift on a single section's reset time; benefit of catching the
// observed clobber: the parser actually returns a snapshot on the gmail
// account instead of null.
export const RESET_SPEC_BODY =
	'(?:(?<month>[A-Za-z]+)\\s*(?<day>\\d{1,2})\\s*at\\s*)?' +
	'(?<hour>\\d{1,2})(?::(?<minute>\\d{2}))?' +
	'\\s*(?<ampm>am|pm|m)' +
	'\\s*\\((?<zone>[^)]+)\\)';

const PERCENT_RE = /(\d+)%\s*used/i;
const RESETS_LINE_RE = /Resets\s*(.+?)\s*$/i;
const RESET_SPEC_RE = new RegExp(RESET_SPEC_BODY, 'i');

// Section-header patterns tested against the whitespace-stripped lowercased
// line. NOT anchored to start-of-line: cursor-positioning artifacts often
// prepend a fragment of the prior section's trailing reset timestamp onto
// the next section's first line (playbook architectural note), so anchoring
// would lose the header. Priority is session > all_models > sonnet (first
// matching kind wins on any given line).
const SESSION_HEADER_RE = /currentsession/;
const ALL_MODELS_HEADER_RE = /currentweek\(allmodels\)/;
const SONNET_HEADER_RE = /currentweek\([a-z]*nly\)/;

const MONTH_INDEX: Record<string, number> = {
	jan: 0,
	feb: 1,
	mar: 2,
	apr: 3,
	may: 4,
	jun: 5,
	jul: 6,
	aug: 7,
	sep: 8,
	oct: 9,
	nov: 10,
	dec: 11,
};

// How many lines past a section's start to consider as "the section's
// window" when scanning for percent / Resets. Sections are tiny in the
// real output (3-5 lines incl. blank separators); cap at 8 so a missing
// section can't accidentally swallow the next one.
const SECTION_WINDOW_CAP = 8;

// "Not logged in" detection. Claude's status bar renders
// "Not logged in · Run /login" when the active CLAUDE_CONFIG_DIR has no
// authenticated tokens - instead of the Max-plan window panel we'd normally
// parse, `/usage` shows the API-billing variant (all $0.00, no percentages).
// Surfacing this as a distinct snapshot kind (rather than a generic parse
// failure) lets the dashboard tell the user "run /login here" instead of
// silently dropping the account.
//
// Cursor-positioning damage collapses the inter-word spaces (same mechanism
// documented at the top of this file), so we match against the same
// compressed/lowercase view used for section headers: `notloggedin`.
const NOT_LOGGED_IN_RE = /notloggedin/;

// Inline-scan fallback for percent + first-3-lines reset search.
const INLINE_SCAN_LINE_COUNT = 3;

// Panel re-segmentation for cursor-addressed (newline-free) captures.
//
// Light /usage panels paint with real line feeds, so splitting on `\n` yields
// one row per line. Heavier panels (Team/Enterprise accounts, or any account
// with a long "what's contributing to your usage" breakdown) are painted
// ENTIRELY via cursor-positioning escapes with NO line feeds at all. After
// ANSI-stripping, the cursor moves vanish and the rows collapse into a single
// glued blob:
//   "…100%usedResets 2:10pm (America/Chicago)Current week (all models)…43%used…"
// The line-oriented section logic below then sees every header on one "line"
// and can't window them apart.
//
// Inserting a newline before each section header and each "Resets" run
// restores one-row-per-line structure so the existing windowing works
// unchanged. On panels that already carry real line feeds this only inserts a
// harmless blank split ahead of rows that were already on their own line -
// `getSectionWindow` slices from the header line either way. The compound
// session row whose "Resets" decayed to "Reses" (see RESET_SPEC_BODY) has no
// matchable "Resets" token, so it stays glued and is still recovered by the
// session inline-scan, exactly as before.
const PANEL_SEGMENT_RE = /(?=Current\s*session|Current\s*week\s*\(|Resets)/gi;

function segmentGluedPanel(stripped: string): string {
	return stripped.replace(PANEL_SEGMENT_RE, '\n');
}

interface SectionMarker {
	kind: 'session' | 'week_all_models' | 'week_sonnet_only';
	startIndex: number;
}

interface SectionExtract {
	percent: number;
	resetsAt: string;
}

export function parseUsage(raw: string, nowIso: string, configDir: string): StatusSnapshot | null {
	const stripped = stripAnsiCodes(raw);
	// Restore one-row-per-line structure for cursor-addressed panels that
	// stripped down to a single glued blob; a no-op on panels already
	// carrying real line feeds. See segmentGluedPanel.
	const allLines = segmentGluedPanel(stripped).split(/\r?\n/);

	// The full-screen capture holds EVERY repaint of the panel, not just the
	// final one: claude paints "Current session" first with provisional numbers
	// (e.g. 101% before it settles to 100%), then repaints as "Scanning local
	// sessions… → Refreshing… → done". Parsing the accumulation lets an early,
	// half-loaded paint win the first-sighting marker race, so percentages come
	// out stale and a week section whose "Resets …" hadn't painted yet borrows
	// the session's reset. Restrict parsing to the LAST paint by slicing from the
	// final "Current session" header - that paint is the settled one (the
	// debounce waits for the stream to go quiet before we read). On single-paint
	// captures (the common case, and every `\n`-delimited fixture) the last
	// occurrence is the only one, so this is a no-op.
	const lines = sliceToFinalPanel(allLines);

	// "Not logged in" detection runs first: when the active config dir has no
	// tokens, claude paints a status bar with `Not logged in · Run /login`
	// and `/usage` renders the API-billing variant rather than the Max-plan
	// windows we'd normally parse. Returning an `unauthenticated` snapshot
	// (with placeholder zeros) lets the dashboard surface a "run /login"
	// CTA for that account instead of silently dropping it.
	if (lines.some((line) => NOT_LOGGED_IN_RE.test(compressedKey(line)))) {
		return {
			type: 'status',
			auth_state: 'unauthenticated',
			config_dir: configDir,
			session: { percent: 0, resets_at: nowIso },
			week_all_models: { percent: 0, resets_at: nowIso },
			week_sonnet_only: { percent: 0, resets_at: nowIso },
		};
	}

	const markers = findSectionMarkers(lines);

	const sessionExtract = extractSection(
		lines,
		markers,
		'session',
		nowIso,
		/* allowInlineScan */ true
	);
	if (!sessionExtract) return null;

	const allModelsExtract = extractSection(
		lines,
		markers,
		'week_all_models',
		nowIso,
		/* allowInlineScan */ true
	);
	if (!allModelsExtract) return null;

	const sonnetExtract = resolveSonnet(lines, markers, nowIso, allModelsExtract);

	// `auth_state` intentionally omitted on the authenticated path. Readers
	// treat absence as `'authenticated'` (see StatusSnapshot in json-emitter.ts
	// and UsageSnapshot in claude-mode-selector.ts), and dropping it keeps the
	// wire envelope byte-compatible with snapshots written before this field
	// existed - fixtures don't need rewriting and on-disk caches don't need a
	// migration.
	return {
		type: 'status',
		config_dir: configDir,
		session: { percent: sessionExtract.percent, resets_at: sessionExtract.resetsAt },
		week_all_models: {
			percent: allModelsExtract.percent,
			resets_at: allModelsExtract.resetsAt,
		},
		week_sonnet_only: { percent: sonnetExtract.percent, resets_at: sonnetExtract.resetsAt },
	};
}

function compressedKey(line: string): string {
	return line.replace(/\s+/g, '').toLowerCase();
}

// Keep only the final paint of the panel. Each repaint opens with a fresh
// "Current session" header, painted in order session → week(all) → week(sonnet),
// so the last such header marks the start of the settled paint and everything
// after it is that paint's data. Returns the input unchanged when no session
// header is present (the section extractors then fail cleanly, as before) or
// when the header appears exactly once.
function sliceToFinalPanel(lines: string[]): string[] {
	let lastSessionIdx = -1;
	for (let i = 0; i < lines.length; i++) {
		if (SESSION_HEADER_RE.test(compressedKey(lines[i]))) lastSessionIdx = i;
	}
	return lastSessionIdx <= 0 ? lines : lines.slice(lastSessionIdx);
}

function findSectionMarkers(lines: string[]): SectionMarker[] {
	const markers: SectionMarker[] = [];
	const claimed = new Set<SectionMarker['kind']>();
	for (let i = 0; i < lines.length; i++) {
		const key = compressedKey(lines[i]);
		// Priority order: session > all_models > sonnet. If a line matches
		// multiple header patterns (unlikely in real /usage output, but
		// possible with extreme cursor-positioning damage), the higher-
		// priority kind claims it. `claimed` enforces single-marker-per-
		// kind so a stray repeat-mention in a later line can't override
		// the first sighting.
		if (!claimed.has('session') && SESSION_HEADER_RE.test(key)) {
			markers.push({ kind: 'session', startIndex: i });
			claimed.add('session');
		} else if (!claimed.has('week_all_models') && ALL_MODELS_HEADER_RE.test(key)) {
			markers.push({ kind: 'week_all_models', startIndex: i });
			claimed.add('week_all_models');
		} else if (!claimed.has('week_sonnet_only') && SONNET_HEADER_RE.test(key)) {
			markers.push({ kind: 'week_sonnet_only', startIndex: i });
			claimed.add('week_sonnet_only');
		}
	}
	return markers;
}

function getSectionWindow(
	lines: string[],
	markers: SectionMarker[],
	kind: SectionMarker['kind']
): string[] | null {
	const idx = markers.findIndex((m) => m.kind === kind);
	if (idx === -1) return null;
	const start = markers[idx].startIndex;
	const nextStart = idx + 1 < markers.length ? markers[idx + 1].startIndex : lines.length;
	const end = Math.min(nextStart, start + SECTION_WINDOW_CAP);
	return lines.slice(start, end);
}

function extractSection(
	lines: string[],
	markers: SectionMarker[],
	kind: SectionMarker['kind'],
	nowIso: string,
	allowInlineScan: boolean
): SectionExtract | null {
	const windowLines = getSectionWindow(lines, markers, kind);
	if (!windowLines) return null;

	const percent = findPercent(windowLines);
	if (percent === null) return null;

	let resetsAt = findResetsAt(windowLines, nowIso);
	if (!resetsAt && allowInlineScan) {
		resetsAt = inlineScanResetsAt(windowLines, nowIso);
	}
	if (!resetsAt) return null;

	return { percent, resetsAt };
}

function findPercent(windowLines: string[]): number | null {
	for (const line of windowLines) {
		const m = line.match(PERCENT_RE);
		if (m) {
			const n = parseInt(m[1], 10);
			if (!Number.isNaN(n)) return n;
		}
	}
	return null;
}

function findResetsAt(windowLines: string[], nowIso: string): string | null {
	for (const line of windowLines) {
		const m = line.match(RESETS_LINE_RE);
		if (m) {
			const iso = parseResetSpec(m[1], nowIso);
			if (iso) return iso;
		}
	}
	return null;
}

function inlineScanResetsAt(windowLines: string[], nowIso: string): string | null {
	for (const line of windowLines.slice(0, INLINE_SCAN_LINE_COUNT)) {
		const iso = parseResetSpec(line, nowIso);
		if (iso) return iso;
	}
	return null;
}

function resolveSonnet(
	lines: string[],
	markers: SectionMarker[],
	nowIso: string,
	allModels: SectionExtract
): SectionExtract {
	// Inline scan is OFF for Sonnet: the polluted line often begins with
	// the prior section's trailing reset timestamp, and an inline scan
	// would lock onto the wrong value (per playbook architectural note).
	const sonnet = extractSection(lines, markers, 'week_sonnet_only', nowIso, false);
	if (sonnet) return sonnet;

	// Section header was found and percent parsed, but no resets - borrow
	// from week_all_models (same rolling window in real captures).
	const windowLines = getSectionWindow(lines, markers, 'week_sonnet_only');
	if (windowLines) {
		const percent = findPercent(windowLines);
		if (percent !== null) {
			return { percent, resetsAt: allModels.resetsAt };
		}
	}

	// Whole section missing - synthesize a placeholder so downstream
	// consumers always see a populated field.
	return { percent: 0, resetsAt: allModels.resetsAt };
}

interface ResetSpecGroups {
	month?: string;
	day?: string;
	hour: string;
	minute?: string;
	ampm: string;
	zone: string;
}

function parseResetSpec(text: string, nowIso: string): string | null {
	const m = text.match(RESET_SPEC_RE);
	if (!m || !m.groups) return null;
	const groups = m.groups as unknown as ResetSpecGroups;
	return resolveResetToIsoUtc(groups, nowIso);
}

function resolveResetToIsoUtc(groups: ResetSpecGroups, nowIso: string): string | null {
	const hour24 = to24Hour(groups.hour, groups.ampm);
	if (hour24 === null) return null;
	const minute = groups.minute ? parseInt(groups.minute, 10) : 0;
	if (Number.isNaN(minute)) return null;

	const nowDate = new Date(nowIso);
	if (Number.isNaN(nowDate.getTime())) return null;

	const zone = groups.zone.trim();
	let today;
	try {
		today = dateInZone(nowDate, zone);
	} catch {
		return null;
	}

	if (groups.month && groups.day) {
		const monthIndex = MONTH_INDEX[groups.month.toLowerCase().slice(0, 3)];
		if (monthIndex === undefined) return null;
		const day = parseInt(groups.day, 10);
		if (Number.isNaN(day)) return null;

		// Default to current year in zone. If the resulting instant is
		// already past `nowIso`, claude is showing next year's reset (the
		// /usage panel only ever displays upcoming resets).
		let candidate = wallClockInZoneToUtc(today.year, monthIndex + 1, day, hour24, minute, zone);
		if (!candidate) return null;
		if (candidate.getTime() <= nowDate.getTime()) {
			candidate = wallClockInZoneToUtc(today.year + 1, monthIndex + 1, day, hour24, minute, zone);
			if (!candidate) return null;
		}
		return candidate.toISOString();
	}

	// Time-only: today's clock time in zone, rolled forward 24h if already
	// past nowIso.
	const candidate = wallClockInZoneToUtc(today.year, today.month, today.day, hour24, minute, zone);
	if (!candidate) return null;
	if (candidate.getTime() <= nowDate.getTime()) {
		const next = new Date(candidate.getTime() + 24 * 60 * 60 * 1000);
		return next.toISOString();
	}
	return candidate.toISOString();
}

function to24Hour(hourStr: string, ampm: string): number | null {
	const h = parseInt(hourStr, 10);
	if (Number.isNaN(h) || h < 1 || h > 12) return null;
	const token = ampm.toLowerCase();
	// Lone `m` → PM heuristic, see RESET_SPEC_BODY comment.
	const isPm = token === 'pm' || token === 'm';
	if (isPm) return h === 12 ? 12 : h + 12;
	return h === 12 ? 0 : h;
}

interface ZoneDate {
	year: number;
	month: number;
	day: number;
}

function dateInZone(date: Date, zone: string): ZoneDate {
	const fmt = new Intl.DateTimeFormat('en-US', {
		timeZone: zone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
	});
	const parts = partsRecord(fmt.formatToParts(date));
	return {
		year: parseInt(parts.year, 10),
		month: parseInt(parts.month, 10),
		day: parseInt(parts.day, 10),
	};
}

// Compute the UTC `Date` corresponding to a wall-clock time in a target
// IANA zone. The "guess and correct" trick: assume the wall clock is UTC,
// then check what that instant *looks like* in the zone via Intl, and
// adjust by the difference. Off by 1 hour during the DST "spring forward"
// gap (which doesn't correspond to a real instant in zone), but those are
// not values Claude's `/usage` panel ever emits.
function wallClockInZoneToUtc(
	year: number,
	month: number,
	day: number,
	hour: number,
	minute: number,
	zone: string
): Date | null {
	const guessMs = Date.UTC(year, month - 1, day, hour, minute);
	let parts: Record<string, string>;
	try {
		const fmt = new Intl.DateTimeFormat('en-US', {
			timeZone: zone,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
			hour12: false,
		});
		parts = partsRecord(fmt.formatToParts(new Date(guessMs)));
	} catch {
		return null;
	}
	let h = parseInt(parts.hour, 10);
	// Intl emits '24' for midnight under some locales - normalize so the
	// reconstructed UTC reflects the same wall clock the formatter saw.
	if (h === 24) h = 0;
	const seenMs = Date.UTC(
		parseInt(parts.year, 10),
		parseInt(parts.month, 10) - 1,
		parseInt(parts.day, 10),
		h,
		parseInt(parts.minute, 10),
		parseInt(parts.second, 10)
	);
	return new Date(guessMs + (guessMs - seenMs));
}

function partsRecord(parts: Intl.DateTimeFormatPart[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (const p of parts) {
		if (p.type !== 'literal') out[p.type] = p.value;
	}
	return out;
}

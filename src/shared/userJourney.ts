/**
 * User Journey: a per-agent log of what the USER did inside Maestro (files
 * opened, saved, created, renamed, deleted in File Preview and the Files panel,
 * and pages browsed in browser tabs), so an agent can see the user's recent
 * steps in order.
 *
 * Scope rules the recorders and the store share:
 * - Only user actions inside Maestro. Edits by other editors or by agents are
 *   already covered by filesystem mtimes and agent transcripts.
 * - Metadata only: never file contents or diffs.
 * - Browser URLs pass through `sanitizeJourneyUrl()` before they are stored,
 *   because query strings and fragments often carry tokens.
 *
 * This module holds the types and the pure helpers. The main-process store
 * (one JSONL file per agent) lives in `src/main/user-journey-manager.ts`.
 */

import { formatDurationCompact } from './duration';
import { formatTimestamp } from './formatters';
import { sanitizeSessionId } from './history';
import { stripJsonBom } from './jsonUtils';
import { toLocalYmd } from './localDay';
import { isPathAtOrUnderRoot, normalizeWorktreePath } from './worktreePaths';

/**
 * Most entries kept per agent; the store prunes the oldest past this. Sized so
 * a busy user (about 275 actions a day) still keeps the full retention window.
 * At about 200 bytes an entry, a full file is about 5 MB.
 */
export const JOURNEY_MAX_ENTRIES_PER_AGENT = 25_000;

/** Entries older than this many days are pruned. */
export const JOURNEY_RETENTION_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Folder under Maestro's data directory that holds the journey files. */
export const JOURNEY_DIR_NAME = 'journey';

/** File name of an agent's journey inside `JOURNEY_DIR_NAME`. */
export function journeyFileName(agentId: string): string {
	return `${sanitizeSessionId(agentId)}.jsonl`;
}

export type UserJourneyKind =
	| 'file.open'
	| 'file.close'
	| 'file.save'
	| 'file.create'
	| 'file.rename'
	| 'file.delete'
	| 'browser.open'
	| 'browser.navigate'
	| 'browser.close';

export const USER_JOURNEY_KINDS: readonly UserJourneyKind[] = [
	'file.open',
	'file.close',
	'file.save',
	'file.create',
	'file.rename',
	'file.delete',
	'browser.open',
	'browser.navigate',
	'browser.close',
];

export function isUserJourneyKind(value: unknown): value is UserJourneyKind {
	return typeof value === 'string' && (USER_JOURNEY_KINDS as readonly string[]).includes(value);
}

export interface UserJourneyEntry {
	/** Epoch ms. */
	ts: number;
	agentId: string;
	kind: UserJourneyKind;
	/** Absolute path for `file.*`, sanitized URL for `browser.*`. For `file.rename`, the NEW path. */
	target: string;
	tabId?: string;
	/** Page title (`browser.*`). */
	title?: string;
	/** Previous absolute path (`file.rename`). */
	fromPath?: string;
	/** Time from open to close (`file.close`, `browser.close`). */
	dwellMs?: number;
	/** Line counts of a save (`file.save`). */
	linesAdded?: number;
	linesRemoved?: number;
	/** Set when the agent runs on an SSH remote. */
	sshRemoteId?: string;
}

/**
 * Drop the query string, the fragment, and any embedded credentials from a
 * URL. Returns the input unchanged when it is not a parseable URL.
 */
export function sanitizeJourneyUrl(url: string): string {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return url;
	}
	parsed.search = '';
	parsed.hash = '';
	parsed.username = '';
	parsed.password = '';
	return parsed.href;
}

/**
 * A browser page title fit to store, or undefined. A title with no spaces
 * that reads as a URL (with or without a scheme) is dropped: Chromium reports
 * the raw URL as the title until the page sets one, and that raw URL still
 * carries the query and fragment `sanitizeJourneyUrl()` strips from `target`.
 */
export function sanitizeJourneyTitle(title: string | undefined): string | undefined {
	const trimmed = title?.trim();
	if (!trimmed) return undefined;
	if (/\s/.test(trimmed)) return trimmed;
	const candidate = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
	try {
		const parsed = new URL(candidate);
		return parsed.hostname.includes('.') || parsed.protocol !== 'https:' ? undefined : trimmed;
	} catch {
		return trimmed;
	}
}

/**
 * Rebuild an entry from untrusted input (an IPC payload or a line read back
 * from disk) with only the known fields, each type-checked. Unknown fields are
 * dropped, so nothing but metadata can reach the log. A `browser.*` target is
 * sanitized again here, so a recorder that forgot to strip a query cannot leak
 * a token, and a URL-shaped title is dropped for the same reason
 * (`sanitizeJourneyTitle`). Returns null when a required field is missing or
 * malformed.
 */
export function normalizeJourneyEntry(raw: unknown): UserJourneyEntry | null {
	if (!raw || typeof raw !== 'object') return null;
	const r = raw as Record<string, unknown>;
	if (typeof r.ts !== 'number' || !Number.isFinite(r.ts)) return null;
	if (typeof r.agentId !== 'string' || !r.agentId) return null;
	if (!isUserJourneyKind(r.kind)) return null;
	if (typeof r.target !== 'string' || !r.target) return null;

	const isBrowser = r.kind.startsWith('browser.');
	const entry: UserJourneyEntry = {
		ts: r.ts,
		agentId: r.agentId,
		kind: r.kind,
		target: isBrowser ? sanitizeJourneyUrl(r.target) : r.target,
	};
	for (const key of ['tabId', 'title', 'fromPath', 'sshRemoteId'] as const) {
		const value = r[key];
		if (typeof value === 'string' && value) entry[key] = value;
	}
	// A URL-shaped title would carry the query the target just lost.
	if (entry.title !== undefined) {
		const title = sanitizeJourneyTitle(entry.title);
		if (title) entry.title = title;
		else delete entry.title;
	}
	for (const key of ['dwellMs', 'linesAdded', 'linesRemoved'] as const) {
		const value = r[key];
		if (typeof value === 'number' && Number.isFinite(value) && value >= 0) entry[key] = value;
	}
	return entry;
}

/**
 * True when `next` repeats the browser location `prev` already recorded: a
 * `browser.navigate` on the same tab to the same sanitized URL. SPA routes and
 * `did-navigate-in-page` fire these duplicates (a hash change, for example,
 * sanitizes to the same target).
 */
export function shouldCollapseJourneyEntry(
	prev: UserJourneyEntry | undefined,
	next: UserJourneyEntry
): boolean {
	if (!prev || next.kind !== 'browser.navigate') return false;
	if (prev.kind !== 'browser.open' && prev.kind !== 'browser.navigate') return false;
	return prev.tabId === next.tabId && prev.target === next.target;
}

/**
 * Parse a journey file, skipping torn or foreign lines. File order (oldest
 * first). Shared by the main-process store and the CLI, which reads the file
 * directly.
 */
export function parseJourneyJsonl(raw: string): UserJourneyEntry[] {
	const entries: UserJourneyEntry[] = [];
	for (const line of stripJsonBom(raw).split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const entry = normalizeJourneyEntry(JSON.parse(trimmed));
			if (entry) entries.push(entry);
		} catch {
			// A torn final line from an interrupted append costs that one entry.
		}
	}
	return entries;
}

/**
 * Keep entries inside retention, then the newest `JOURNEY_MAX_ENTRIES_PER_AGENT`.
 * The store prunes with slack, so readers apply this to hide the overshoot.
 */
export function applyJourneyLimits(entries: UserJourneyEntry[], now: number): UserJourneyEntry[] {
	const cutoff = now - JOURNEY_RETENTION_DAYS * DAY_MS;
	const fresh = entries.filter((e) => e.ts >= cutoff);
	return fresh.length > JOURNEY_MAX_ENTRIES_PER_AGENT
		? fresh.slice(fresh.length - JOURNEY_MAX_ENTRIES_PER_AGENT)
		: fresh;
}

export interface ReadJourneyOptions {
	/** Only entries with `ts >= since` (epoch ms). */
	since?: number;
	/** Only the newest N entries (after the other filters). */
	tail?: number;
	/** Only these kinds. */
	kinds?: UserJourneyKind[];
}

/** Apply `ReadJourneyOptions` to entries in file order (oldest first). */
export function filterJourneyEntries(
	entries: UserJourneyEntry[],
	options: ReadJourneyOptions = {}
): UserJourneyEntry[] {
	const { since, tail, kinds } = options;
	let out = entries;
	if (since !== undefined) out = out.filter((e) => e.ts >= since);
	if (kinds && kinds.length > 0) {
		const wanted = new Set(kinds);
		out = out.filter((e) => wanted.has(e.kind));
	}
	if (tail !== undefined) out = tail > 0 ? out.slice(-tail) : [];
	return out;
}

export interface FormatJourneyLineOptions {
	/** The agent's working directory; paths under it render relative to it. */
	cwd?: string;
}

/** A path for display: relative to `cwd` when it sits under it. */
function displayJourneyPath(path: string, cwd: string | undefined): string {
	if (!cwd) return path;
	const candidate = normalizeWorktreePath(path);
	const root = normalizeWorktreePath(cwd);
	if (candidate === root || !isPathAtOrUnderRoot(candidate, root)) return path;
	return candidate.slice(root === '/' ? 1 : root.length + 1);
}

/** A URL for display: no scheme, no trailing slash (`docs.runmaestro.ai/cue`). */
function displayJourneyUrl(url: string): string {
	const bare = url.replace(/^https?:\/\//i, '');
	return bare.length > 1 ? bare.replace(/\/$/, '') : bare;
}

function dwellSuffix(dwellMs: number | undefined): string {
	return dwellMs !== undefined && dwellMs >= 0 ? ` (${formatDurationCompact(dwellMs)})` : '';
}

function titleSuffix(title: string | undefined): string {
	const trimmed = title?.trim();
	return trimmed ? ` "${trimmed}"` : '';
}

/**
 * The clock of a digest line, in the user's locale: the time alone when `ts`
 * falls on the same local day as `now`, else the date and time. Shared by the
 * journey and the timeline digests so the two read alike.
 */
export function formatDigestTime(ts: number, now: number): string {
	return formatTimestamp(ts, toLocalYmd(ts) === toLocalYmd(now) ? 'time' : 'datetime');
}

/**
 * What the user did, without the clock: `opened src/foo.ts`,
 * `saved src/foo.ts (+12/-3)`, `browsed docs.runmaestro.ai/cue`.
 */
export function describeJourneyEntry(
	entry: UserJourneyEntry,
	options: FormatJourneyLineOptions = {}
): string {
	const path = () => displayJourneyPath(entry.target, options.cwd);
	const url = () => displayJourneyUrl(entry.target);

	let action: string;
	switch (entry.kind) {
		case 'file.open':
			action = `opened ${path()}`;
			break;
		case 'file.close':
			action = `closed ${path()}${dwellSuffix(entry.dwellMs)}`;
			break;
		case 'file.save': {
			const counts =
				entry.linesAdded !== undefined || entry.linesRemoved !== undefined
					? ` (+${entry.linesAdded ?? 0}/-${entry.linesRemoved ?? 0})`
					: '';
			action = `saved ${path()}${counts}`;
			break;
		}
		case 'file.create':
			action = `created ${path()}`;
			break;
		case 'file.rename':
			action = entry.fromPath
				? `renamed ${displayJourneyPath(entry.fromPath, options.cwd)} to ${path()}`
				: `renamed to ${path()}`;
			break;
		case 'file.delete':
			action = `deleted ${path()}`;
			break;
		case 'browser.open':
			action = `opened browser ${url()}${titleSuffix(entry.title)}`;
			break;
		case 'browser.navigate':
			action = `browsed ${url()}${titleSuffix(entry.title)}`;
			break;
		case 'browser.close':
			action = `closed browser ${url()}${dwellSuffix(entry.dwellMs)}`;
			break;
		default:
			action = `${(entry as UserJourneyEntry).kind} ${entry.target}`;
	}
	return action;
}

/**
 * One compact line per entry, for an agent-facing digest:
 * `2:02 PM opened src/foo.ts`, `2:05 PM saved src/foo.ts (+12/-3)`,
 * `2:06 PM browsed docs.runmaestro.ai/cue`. The clock is the user's locale; an
 * entry from another day than `now` also carries its date.
 */
export function formatJourneyLine(
	entry: UserJourneyEntry,
	now: number,
	options: FormatJourneyLineOptions = {}
): string {
	return `${formatDigestTime(entry.ts, now)} ${describeJourneyEntry(entry, options)}`;
}

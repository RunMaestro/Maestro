/**
 * Computer History - store layout (pure path math, bundle-safe).
 *
 * The ONE place that knows where things live under `<userData>/computer-history/`.
 * Main (writer), CLI (reader), and the system-prompt builders (which tell
 * agents the directory) all derive paths here, so the documented layout in
 * SCHEMA.md cannot drift from what is on disk.
 *
 * Segments are keyed by the UTC start of their 15-minute window (:00, :15,
 * :30, :45). 6-hour roll-up digests are keyed by the UTC start of their block
 * (00:00, 06:00, 12:00, 18:00). UTC keeps the names unambiguous across DST
 * changes and machines in other time zones.
 *
 * No `path` import: the renderer bundle has no Node `path`, so joins pick the
 * separator the base directory already uses.
 */

export const COMPUTER_HISTORY_DIR_NAME = 'computer-history';
export const SEGMENT_MINUTES = 15;
export const SEGMENT_MS = SEGMENT_MINUTES * 60_000;

/** A roll-up digest covers this many hours of 15-minute windows. */
export const ROLLUP_HOURS = 6;
export const ROLLUP_MS = ROLLUP_HOURS * 3_600_000;
/** Prefix that tells a roll-up digest file from a 15-minute one. */
export const ROLLUP_FILE_PREFIX = `${ROLLUP_HOURS}h-`;

export const SCHEMA_FILE = 'SCHEMA.md';
export const CONFIG_FILE = 'config.json';
export const INDEX_FILE = 'index.jsonl';
export const SEGMENTS_DIR = 'segments';
export const DIGESTS_DIR = 'digests';

/** Join path parts using the separator `base` already uses (Windows or POSIX). */
function joinNative(base: string, ...parts: string[]): string {
	const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/';
	const trimmed = base.replace(/[\\/]+$/, '');
	return [trimmed, ...parts].join(sep);
}

/** `<userData>/computer-history` for a given userData directory. */
export function computerHistoryDir(userDataDir: string): string {
	return joinNative(userDataDir, COMPUTER_HISTORY_DIR_NAME);
}

/** Start of the 15-minute UTC window that contains `ms`. */
export function segmentStartMs(ms: number): number {
	return Math.floor(ms / SEGMENT_MS) * SEGMENT_MS;
}

/** Store-relative segment path, forward slashes: `segments/2026-10-03/1410Z.jsonl`. */
export function segmentRelativePath(startMs: number): string {
	const iso = new Date(startMs).toISOString(); // 2026-10-03T14:10:00.000Z
	const day = iso.slice(0, 10);
	const hhmm = iso.slice(11, 13) + iso.slice(14, 16);
	return `${SEGMENTS_DIR}/${day}/${hhmm}Z.jsonl`;
}

/** Store-relative 15-minute digest path for a segment window: `digests/<day>/<HHMM>Z.md`. */
export function digestRelativePath(startMs: number): string {
	return segmentRelativePath(startMs)
		.replace(`${SEGMENTS_DIR}/`, `${DIGESTS_DIR}/`)
		.replace(/\.jsonl$/, '.md');
}

/** Start of the 6-hour UTC block (00, 06, 12, 18) that contains `ms`. */
export function rollupBlockStartMs(ms: number): number {
	return Math.floor(ms / ROLLUP_MS) * ROLLUP_MS;
}

/** Store-relative roll-up path for a block: `digests/<day>/6h-<HHMM>Z.md`. */
export function rollupDigestRelativePath(blockStartMs: number): string {
	const iso = new Date(blockStartMs).toISOString();
	const day = iso.slice(0, 10);
	const hhmm = iso.slice(11, 13) + iso.slice(14, 16);
	return `${DIGESTS_DIR}/${day}/${ROLLUP_FILE_PREFIX}${hhmm}Z.md`;
}

export type DigestKind = '15m' | '6h';

/**
 * Parse a store-relative digest path: its kind and window start, or null for
 * anything else. Like the segment parser it accepts any HHMM, so a file left
 * by an older window size still reads.
 */
export function parseDigestRelativePath(rel: string): { kind: DigestKind; startMs: number } | null {
	const m = /^digests\/(\d{4}-\d{2}-\d{2})\/(6h-)?(\d{2})(\d{2})Z\.md$/.exec(
		rel.replace(/\\/g, '/')
	);
	if (!m) return null;
	const ms = Date.parse(`${m[1]}T${m[3]}:${m[4]}:00.000Z`);
	if (Number.isNaN(ms)) return null;
	return { kind: m[2] ? '6h' : '15m', startMs: ms };
}

/**
 * Parse a store-relative segment path back to its window start, or null when
 * the name is not a segment (a stray file a user dropped in the folder).
 */
export function parseSegmentRelativePath(rel: string): number | null {
	const m = /^segments\/(\d{4}-\d{2}-\d{2})\/(\d{2})(\d{2})Z\.jsonl$/.exec(rel.replace(/\\/g, '/'));
	if (!m) return null;
	const ms = Date.parse(`${m[1]}T${m[2]}:${m[3]}:00.000Z`);
	return Number.isNaN(ms) ? null : ms;
}

/** Resolve a store-relative path (forward slashes) to an absolute one. */
export function resolveStorePath(storeDir: string, rel: string): string {
	return joinNative(storeDir, ...rel.split('/'));
}

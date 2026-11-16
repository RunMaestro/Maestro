/**
 * The logs the System Log Viewer can show, one pill each.
 *
 * `maestro` is the app's own in-memory log (`logger:getLogs`). Every other
 * source is a log FILE a supervised process writes (the model server's
 * `llama-server` output). The viewer reads those through `logger:readLogSource`
 * by id, never by path: the main process alone maps an id to its file, so the
 * renderer (and the web-desktop bridge behind it) can never read a file it
 * names itself.
 *
 * The same ids are the `--tab` values of `maestro-cli open logs`, so a source
 * added here is deep-linkable from the CLI with no further wiring.
 */

export const LOG_SOURCE_IDS = ['maestro', 'model-server'] as const;

export type LogSourceId = (typeof LOG_SOURCE_IDS)[number];

/** A source backed by a file on disk (every source except `maestro`). */
export type FileLogSourceId = Exclude<LogSourceId, 'maestro'>;

export interface LogSource {
	id: LogSourceId;
	/** Pill label. */
	label: string;
	/** One line for `open --list` and the pill's tooltip. */
	description: string;
}

export const LOG_SOURCES: readonly LogSource[] = [
	{ id: 'maestro', label: 'Maestro', description: "Maestro's own application log." },
	{
		id: 'model-server',
		label: 'Model server',
		description: 'Output of the Maestro model server (llama-server), from its log file.',
	},
];

export function isLogSourceId(value: unknown): value is LogSourceId {
	return typeof value === 'string' && (LOG_SOURCE_IDS as readonly string[]).includes(value);
}

export function isFileLogSource(id: LogSourceId): id is FileLogSourceId {
	return id !== 'maestro';
}

/** How much of a log file one read returns by default: the newest 512 KiB. */
export const LOG_SOURCE_READ_DEFAULT_BYTES = 512 * 1024;
/** The most one read may ask for. */
export const LOG_SOURCE_READ_MAX_BYTES = 4 * 1024 * 1024;

/** What one read of a file log source returns. */
export interface LogSourceRead {
	source: FileLogSourceId;
	/** The file's path, for display. */
	path: string;
	/** False when the process has never written the file. */
	exists: boolean;
	/** The newest part of the log, oldest line first. Empty when `unchanged`. */
	text: string;
	/** True when older text was left out to stay within the byte budget. */
	truncated: boolean;
	/** Size and modification time of the current file, for change detection. */
	size: number;
	mtimeMs: number;
	/** True when the file matches the `known` stamp the caller passed. */
	unchanged?: boolean;
}

export interface LogSourceReadOptions {
	maxBytes?: number;
	/** The stamp of the last read. A file that still matches it is not re-sent. */
	known?: { size: number; mtimeMs: number };
}

/** The levels a file log line can carry, a subset of the Maestro log's levels. */
export type LogLineLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * One line of a file log source, in the shape of a Maestro log entry, so the
 * viewer interleaves both by time and draws them the same way.
 */
export interface LogSourceEntry {
	/** Wall-clock time of the line, in ms since the epoch. */
	timestamp: number;
	level: LogLineLevel;
	message: string;
	/** The source id, drawn as the entry's context pill. */
	context: FileLogSourceId;
	source: FileLogSourceId;
}

/**
 * The prefix a supervised process's log line is written with: its wall-clock
 * time, so the line can be placed among Maestro's own entries.
 * `[2026-11-13T04:24:10.263Z] `
 */
export function logLineStamp(timestamp: number = Date.now()): string {
	return `[${new Date(timestamp).toISOString()}] `;
}

const STAMPED_LINE = /^\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\] ?(.*)$/;

/**
 * llama.cpp's own line prefix: time since the process started, as
 * `minutes.seconds.milliseconds.microseconds`, then a one-letter level.
 * `0.00.041.400 I cmn  common_param: ...`
 */
const LLAMA_LINE = /^(\d+)\.(\d{2})\.(\d{3})\.(\d{3}) ([A-Z]) (.*)$/;

const LLAMA_LEVELS: Record<string, LogLineLevel> = {
	D: 'debug',
	I: 'info',
	W: 'warn',
	E: 'error',
};

/** The line Maestro writes when it starts the process; llama.cpp counts from it. */
const RUN_START = /^Starting\b/;

const ERROR_PATTERN =
	/\b(error|errors|failed|failure|fatal|abort(ed)?|panic|exception|crash(ed)?)\b/i;
const WARN_PATTERN = /\b(warn|warning|deprecated)\b/i;

/**
 * The level a plain log line reads as, when it carries no level of its own.
 * This is a reading of the words, used only to color and filter.
 */
export function inferLogLineLevel(line: string): LogLineLevel {
	if (ERROR_PATTERN.test(line)) return 'error';
	if (WARN_PATTERN.test(line)) return 'warn';
	return 'info';
}

/**
 * Read a log file's text into entries, oldest first, blank lines dropped.
 *
 * A line's time is, in order of preference: its own `[ISO] ` stamp (every line
 * written since the supervisor began stamping); for an older unstamped
 * llama.cpp line, the run's `Starting` stamp plus the line's elapsed time; or
 * the time of the line before it. A line with none of these (the cut-off start
 * of a long log) takes the time of the next line that has one, and
 * `fallbackTimestamp` (the file's modification time) when no line does.
 *
 * The level is llama.cpp's own letter when the line has one, otherwise
 * {@link inferLogLineLevel}.
 */
export function parseLogSourceEntries(
	text: string,
	source: FileLogSourceId,
	fallbackTimestamp: number
): LogSourceEntry[] {
	const entries: (Omit<LogSourceEntry, 'timestamp'> & { timestamp: number | null })[] = [];
	let runStart: number | null = null;
	let previous: number | null = null;

	for (const raw of text.split(/\r?\n/)) {
		if (!raw.trim()) continue;
		let rest = raw;
		let timestamp: number | null = null;

		const stamped = STAMPED_LINE.exec(rest);
		if (stamped) {
			const parsed = Date.parse(stamped[1]);
			if (Number.isFinite(parsed)) timestamp = parsed;
			rest = stamped[2];
			if (timestamp !== null && RUN_START.test(rest)) runStart = timestamp;
		}

		let level: LogLineLevel | undefined;
		const llama = LLAMA_LINE.exec(rest);
		if (llama) {
			if (timestamp === null && runStart !== null) {
				// Whole milliseconds: lines within one keep their file order anyway.
				const [, minutes, seconds, ms, us] = llama;
				timestamp =
					runStart +
					Number(minutes) * 60_000 +
					Number(seconds) * 1000 +
					Number(ms) +
					Math.round(Number(us) / 1000);
			}
			level = LLAMA_LEVELS[llama[5]];
			rest = llama[6];
		}

		const message = rest.trim();
		if (!message) continue;
		if (timestamp === null) timestamp = previous;
		else previous = timestamp;
		entries.push({
			timestamp,
			level: level ?? inferLogLineLevel(message),
			message,
			context: source,
			source,
		});
	}

	// An unplaced line takes the time of the next placed one.
	let next = fallbackTimestamp;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.timestamp === null) entry.timestamp = next;
		else next = entry.timestamp;
	}
	return entries as LogSourceEntry[];
}

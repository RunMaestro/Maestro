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

export const DEFAULT_LOG_SOURCE: LogSourceId = 'maestro';

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

export type LogLineLevel = 'error' | 'warn' | 'info';

export interface LogLine {
	/** 1-based position in the text read, a stable key while the text holds. */
	number: number;
	text: string;
	level: LogLineLevel;
}

const ERROR_PATTERN =
	/\b(error|errors|failed|failure|fatal|abort(ed)?|panic|exception|crash(ed)?)\b/i;
const WARN_PATTERN = /\b(warn|warning|deprecated)\b/i;

/**
 * The level a plain log line reads as. A process log carries no structured
 * level, so this is a reading of the words, used only to color and filter.
 */
export function inferLogLineLevel(line: string): LogLineLevel {
	if (ERROR_PATTERN.test(line)) return 'error';
	if (WARN_PATTERN.test(line)) return 'warn';
	return 'info';
}

/** Split a log file's text into lines, dropping blank ones. */
export function parseLogLines(text: string): LogLine[] {
	const lines: LogLine[] = [];
	const raw = text.split(/\r?\n/);
	for (let i = 0; i < raw.length; i++) {
		const line = raw[i];
		if (!line.trim()) continue;
		lines.push({ number: i + 1, text: line, level: inferLogLineLevel(line) });
	}
	return lines;
}

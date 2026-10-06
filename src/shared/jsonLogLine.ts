/**
 * One log entry as one line of JSON (`--log-format json`).
 *
 * The shape a log shipper (journald, Docker, Loki, CloudWatch) can index
 * without a parser: `timestamp`, `level`, `message`, plus the run identifiers
 * when the line is about a run. Both log paths a headless Cue engine has
 * render through this one function - the engine's `onLog` sink and the
 * main-process `logger` its shared modules use - so they cannot disagree on
 * field names.
 *
 * `data` is NEVER copied wholesale. Payloads carry prompt text, trigger
 * payloads and environment-derived values, and a structured log is precisely
 * what gets shipped off the box, so only the identifier fields below are
 * lifted out of it. A new field reaches the JSON line by being added here on
 * purpose.
 */

/** Identifier fields lifted from a log entry's `data` payload, when present. */
export const JSON_LOG_ID_FIELDS = [
	'runId',
	'subscriptionName',
	'pipelineId',
	'sessionId',
	'status',
] as const;

/** The standard levels a log shipper understands. */
export type JsonLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface JsonLogLineInput {
	timestamp?: number | Date;
	/** Any Maestro level; `cue` / `autorun` / `toast` become `info` with `category` kept. */
	level: string;
	message: string;
	context?: string;
	data?: unknown;
}

export interface JsonLogLine {
	timestamp: string;
	level: JsonLogLevel;
	message: string;
	category?: string;
	context?: string;
	event?: string;
	runId?: string;
	subscriptionName?: string;
	pipelineId?: string;
	sessionId?: string;
	status?: string;
}

function normalizeLevel(level: string): JsonLogLevel {
	if (level === 'error' || level === 'warn' || level === 'debug') return level;
	return 'info';
}

/** Build the object (exported for tests and for callers that add fields). */
export function buildJsonLogLine(input: JsonLogLineInput): JsonLogLine {
	const level = normalizeLevel(input.level);
	const line: JsonLogLine = {
		timestamp: new Date(input.timestamp ?? Date.now()).toISOString(),
		level,
		message: input.message,
	};
	if (input.level !== level) line.category = input.level;
	if (input.context) line.context = input.context;
	if (input.data && typeof input.data === 'object' && !Array.isArray(input.data)) {
		const data = input.data as Record<string, unknown>;
		if (typeof data.type === 'string') line.event = data.type;
		for (const field of JSON_LOG_ID_FIELDS) {
			const value = data[field];
			if (typeof value === 'string' && value !== '') line[field] = value;
		}
	}
	return line;
}

/** Serialize: `JSON.stringify` escapes newlines, so the result is always exactly one line. */
export function formatJsonLogLine(input: JsonLogLineInput): string {
	return JSON.stringify(buildJsonLogLine(input));
}

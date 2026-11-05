import { canonicalJson } from './canonicalJson';
import type { PianolaMessage } from './pianola/types';
import type { LogEntryRecord } from './maestro-lib/store/transcript';

/** Additive v1 desktop observation protocol. A revision is meaningful only in its host generation. */
export interface CurrentTurnCursor {
	generation: string;
	/** Native owner-renderer incarnation; changes when the transcript publisher restarts. */
	sourceGeneration: string;
	agentId: string;
	tabId: string;
	createdAt: number;
	provider: string;
	agentSessionId: string | null;
	runId: string | null;
	turnId: string | null;
	revision: number;
}

/** Native log rows keep tool input/output and card payloads as well as prose. */
export type CurrentTurnMessage = LogEntryRecord;

export interface CurrentTurnRead {
	version: 1;
	cursor: CurrentTurnCursor;
	status: 'empty-enrollment' | 'complete' | 'incomplete' | 'gap' | 'reset' | 'unknown';
	/** Creation-only baseline. Never implies a complete or actionable turn. */
	enrollment?: CurrentTurnCursor;
	reason?: string;
	entryCount?: number;
	lastEntry?: {
		id: string;
		textLength: number;
		contentRevision?: number;
		contentSignature?: string;
		orderMutationRevision?: number;
	};
	mode?: 'full' | 'delta';
	baseCursor?: CurrentTurnCursor;
	orderIds?: string[];
	/** Full current turn, beginning with the native submitted user row. Never a tail. */
	messages: CurrentTurnMessage[];
}

/** Ordered commits from the native owning renderer, separate from disk's 100-row window. */
export interface TranscriptObservation {
	sourceGeneration: string;
	sequence: number;
	createdAt: number;
	provider: string;
	closed?: boolean;
	/** Only the native creator may attest this, on its first empty snapshot. */
	emptyCreation?: boolean;
}

export function isCurrentTurnCursor(value: unknown): value is CurrentTurnCursor {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const row = value as Record<string, unknown>;
	return (
		['generation', 'sourceGeneration', 'agentId', 'tabId', 'provider'].every(
			(key) => typeof row[key] === 'string' && !!row[key]
		) &&
		['createdAt', 'revision'].every(
			(key) => Number.isSafeInteger(row[key]) && (row[key] as number) >= 0
		) &&
		['agentSessionId', 'runId', 'turnId'].every(
			(key) => row[key] === null || typeof row[key] === 'string'
		)
	);
}

/** Compare every native identity field, including generation and revision. */
export function sameCurrentTurnCursor(
	a: CurrentTurnCursor | undefined,
	b: CurrentTurnCursor | undefined
): boolean {
	return a === b || (!!a && !!b && canonicalJson(a) === canonicalJson(b));
}

/** Reconstruct only a host-confirmed complete base. A lost base requires a full refresh. */
export function composeCurrentTurn(read: CurrentTurnRead, base?: CurrentTurnRead): CurrentTurnRead {
	if (read.version !== 1 || !isCurrentTurnCursor(read.cursor))
		throw new Error('Invalid native turn cursor');
	if (read.status !== 'complete') throw new Error('Incomplete current turn: ' + read.status);
	let messages = read.messages;
	if (read.mode === 'delta') {
		if (
			!base ||
			base.status !== 'complete' ||
			!sameCurrentTurnCursor(base.cursor, read.baseCursor) ||
			!sameCurrentTurnCursor({ ...base.cursor, revision: read.cursor.revision }, read.cursor) ||
			!read.orderIds
		)
			throw new Error('Current turn delta base lost');
		const rows = new Map(base.messages.map((row) => [row.id, row]));
		for (const row of read.messages) rows.set(row.id, row);
		messages = read.orderIds.map((id) => {
			const row = rows.get(id);
			if (!row) throw new Error('Current turn delta gap');
			return row;
		});
	}
	if (
		!Array.isArray(messages) ||
		!messages.length ||
		messages.length > 8192 ||
		messages.some(
			(row) =>
				!row ||
				typeof row.id !== 'string' ||
				!row.id ||
				typeof row.text !== 'string' ||
				typeof row.source !== 'string' ||
				!Number.isFinite(row.timestamp)
		) ||
		messages[0].id !== read.cursor.turnId ||
		messages[0].source !== 'user' ||
		new Set(messages.map((row) => row.id)).size !== messages.length ||
		(read.entryCount !== undefined && messages.length !== read.entryCount)
	)
		throw new Error('Current turn boundary or order missing');
	if (new TextEncoder().encode(canonicalJson(messages)).byteLength > 2 * 1024 * 1024)
		throw new Error('Current turn consumer overflow');
	return { ...read, mode: 'full', messages };
}

/** Preserve structured native evidence in the classifier input, including tool payloads. */
export function currentTurnMessages(read: CurrentTurnRead): PianolaMessage[] {
	return read.messages.map((row) => ({
		id: row.id,
		source: row.source,
		role:
			row.source === 'ai' || row.source === 'stdout'
				? 'assistant'
				: row.source === 'stderr'
					? 'error'
					: ['user', 'system', 'tool', 'thinking', 'error'].includes(row.source)
						? (row.source as PianolaMessage['role'])
						: 'unknown',
		content:
			row.text +
			'\n' +
			canonicalJson(
				Object.fromEntries(
					Object.entries(row).filter(
						([key]) => !['id', 'text', 'source', 'timestamp'].includes(key)
					)
				)
			),
		timestamp: new Date(row.timestamp).toISOString(),
	}));
}

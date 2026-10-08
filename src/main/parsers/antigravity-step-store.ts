/**
 * Read-only access to what Antigravity CLI records about each conversation on
 * disk. Two readers use it: the output parser, for the two things agy's
 * `stream-json` output leaves out, and the session storage, for History.
 *
 * agy streams a model step's thinking only as a COUNT (`usage.thinking_tokens`)
 * and settles every tool step as `DONE` with no exit code, so a failed command
 * looked like a successful one and a long think left no trace. Both facts are in
 * the conversation store agy writes as it goes:
 *
 *   ~/.gemini/antigravity-cli/conversations/<conversation_id>.db
 *   table `steps` (idx = the stream's `step_index`), column `step_payload`
 *
 * `step_payload` is a protobuf message with no published schema. The field map
 * below was read off real agy 1.2.16 conversations with `protoc --decode_raw`
 * (the same approach as llm-agent's agy store reader):
 *
 *   user step  (step_type 14):  19 -> 2   the prompt as sent
 *   model step (step_type 15):  20 -> 1   reply text
 *                               20 -> 3   thinking summary
 *                               20 -> 7   tool calls {1 id, 2 name, 3 JSON args} (repeated)
 *                               5 -> 9    usage {2 input, 3 output, 5 cache read, 9 thinking}
 *   tool step (step_type 132):  5 -> 4    the call {1 id, 2 name, 3 JSON args}
 *                               140 -> 2 -> 1  result text fed back to the model,
 *                                              e.g. "The command exited with code 1.\n..."
 *   every step:                 5 -> 1    created {1 seconds, 2 nanos}
 *
 * The row for a step is already written when the stream reports that step (a
 * tool-calling model step at its DONE line, an answer step at its first text
 * delta), so reading it inline keeps the thinking in order. agy writes a
 * thinking summary only when it thinks at length; a short think has none.
 *
 * Everything here is an enrichment. A missing store (an SSH-remote agy keeps it
 * on the remote host), a locked or reshaped one, or an unknown field all read as
 * "nothing extra", never as a failed turn.
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { cleanToolOutputText } from '../../shared/toolOutput';

/** What the parser asks the store for. Injected so tests need no disk. */
export interface AntigravityStepStore {
	/** Thinking summary agy recorded for a model step, or ''. */
	readThinking(conversationId: string, stepIndex: number): string;
	/** Result text agy fed back to the model for a tool step, or ''. */
	readToolResult(conversationId: string, stepIndex: number): string;
}

/** agy conversation ids are UUIDs; anything else must not become a path. */
export const ANTIGRAVITY_CONVERSATION_ID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One protobuf wire field: a varint value or a length-delimited byte range. */
interface WireField {
	field: number;
	value?: number;
	bytes?: Uint8Array;
}

function readVarint(buf: Uint8Array, pos: number): [number, number] {
	let value = 0;
	let shift = 0;
	let p = pos;
	while (p < buf.length) {
		const byte = buf[p++];
		value += (byte & 0x7f) * 2 ** shift; // multiply: a 32-bit shift overflows
		if ((byte & 0x80) === 0) break;
		shift += 7;
		if (shift > 63) break;
	}
	return [value, p];
}

/** Walk one level of protobuf fields. Stops quietly on malformed input. */
function* wireFields(buf: Uint8Array): Generator<WireField> {
	let p = 0;
	while (p < buf.length) {
		const [tag, afterTag] = readVarint(buf, p);
		if (afterTag <= p) return;
		p = afterTag;
		const field = Math.floor(tag / 8);
		const wire = tag & 7;
		if (wire === 0) {
			const [value, afterValue] = readVarint(buf, p);
			p = afterValue;
			yield { field, value };
		} else if (wire === 2) {
			const [length, afterLength] = readVarint(buf, p);
			if (afterLength + length > buf.length) return;
			yield { field, bytes: buf.subarray(afterLength, afterLength + length) };
			p = afterLength + length;
		} else if (wire === 1) {
			p += 8;
		} else if (wire === 5) {
			p += 4;
		} else {
			return; // groups or garbage: bail rather than misread
		}
	}
}

/** Every length-delimited value at a nested field path (the last hop may repeat). */
export function fieldsAt(buf: Uint8Array, fieldPath: number[]): Uint8Array[] {
	if (fieldPath.length === 0) return [buf];
	const [wanted, ...rest] = fieldPath;
	for (const entry of wireFields(buf)) {
		if (entry.field === wanted && entry.bytes) {
			// Only the LAST hop fans out: earlier hops are singular messages.
			if (rest.length > 0) return fieldsAt(entry.bytes, rest);
		}
	}
	if (rest.length > 0) return [];
	const out: Uint8Array[] = [];
	for (const entry of wireFields(buf)) {
		if (entry.field === wanted && entry.bytes) out.push(entry.bytes);
	}
	return out;
}

/** The bytes at a nested field path (`[20, 3]`), or undefined. */
export function fieldAt(buf: Uint8Array, fieldPath: number[]): Uint8Array | undefined {
	return fieldsAt(buf, fieldPath)[0];
}

/** The varint at a nested field path (`[5, 9, 2]`), or undefined. */
export function varintAt(buf: Uint8Array, fieldPath: number[]): number | undefined {
	const parent = fieldAt(buf, fieldPath.slice(0, -1));
	if (!parent) return undefined;
	const wanted = fieldPath[fieldPath.length - 1];
	for (const entry of wireFields(parent)) {
		if (entry.field === wanted && entry.value !== undefined) return entry.value;
	}
	return undefined;
}

export function utf8(bytes: Uint8Array | undefined): string {
	return bytes ? new TextDecoder('utf-8').decode(bytes) : '';
}

/** Thinking summary from a model step's payload (field 20 -> 3), or ''. */
export function thinkingFromStepPayload(payload: Uint8Array): string {
	return utf8(fieldAt(payload, [20, 3])).trim();
}

/** Tool result text from a tool step's payload (field 140 -> 2 -> 1), or ''. */
export function toolResultFromStepPayload(payload: Uint8Array): string {
	return utf8(fieldAt(payload, [140, 2, 1]));
}

/**
 * agy's status line, which opens every run_command result (all 5,203 in one
 * real store set, after a leading newline). Anchored, because a file that
 * merely contains this sentence must not read as a failed command.
 */
const COMMAND_STATUS = /^\s*The command exited with code (-?\d+)\./;

/** Exit code from a run_command result agy fed back to the model; other tools have none. */
export function commandExitCode(toolName: string | undefined, result: string): number | undefined {
	if (toolName !== 'run_command') return undefined;
	const match = COMMAND_STATUS.exec(result);
	return match ? Number(match[1]) : undefined;
}

/**
 * Badge text from a stored tool result: the diff an edit applied, else what a
 * command printed, else the result's first line ("Created file ...", "The
 * command exited with code 1."). The rest of a result is instructions to the
 * model ("Don't ask for permission"), not output.
 */
export function storedResultSummary(result: string): string {
	// CRLF separators would miss the LF-only patterns below and fall through to the status line.
	result = result.replace(/\r\n/g, '\n');
	const diffs = [...result.matchAll(/\[diff_block_start\]\n?([\s\S]*?)\n?\[diff_block_end\]/g)].map(
		(match) => match[1].trimEnd()
	);
	if (diffs.length > 0) return cleanToolOutputText(diffs.join('\n'));
	// run_command: "...exited with code N.\nOutput:\n<out>" or "...\nStdout:\n<out>\nStderr:\n<err>".
	// Anchored to the status line so a file that contains "Output:" is not mistaken for it.
	const printed =
		/^\s*The command exited with code -?\d+\.\n(?:Output|Stdout):\n([\s\S]*?)(?:\nStderr:\n([\s\S]*))?$/.exec(
			result
		);
	const body = printed ? [printed[1], printed[2]].map((part) => part?.trim()).filter(Boolean) : [];
	if (body.length > 0) return cleanToolOutputText(body.join('\n'));
	return cleanToolOutputText(result.split('\n').find((line) => line.trim()) ?? '');
}

/** agy's local data directory. */
export function antigravityHome(): string {
	// ponytail: default agy home only; follow an override env var if agy ever documents one.
	return path.join(os.homedir(), '.gemini', 'antigravity-cli');
}

/** Where agy keeps a conversation's store. */
export function antigravityConversationDbPath(conversationId: string): string {
	return path.join(antigravityHome(), 'conversations', `${conversationId}.db`);
}

/**
 * Open one of agy's SQLite stores for reading, or null if it cannot be read,
 * leaving agy's folder exactly as it was found.
 *
 * agy keeps its stores in WAL mode, and neither plain mode is clean on its own
 * (both observed under Electron's SQLite):
 *  - `readonly` on a finished store (no sidecars) CREATES `-wal`/`-shm` and,
 *    being read-only, cannot remove them: one listing pass left 397 pairs.
 *  - read-write, closing last, CHECKPOINTS any WAL agy left behind (a crash, or
 *    agy still running) into the `.db` and deletes it: no data is lost, but it
 *    rewrites agy's file.
 * So: sidecars present -> `readonly` (they already exist; nothing is created or
 * merged). No sidecars -> read-write with `query_only`: the WAL it creates is
 * empty, so closing deletes the pair without writing the `.db`, and
 * `query_only` refuses every write (a DELETE fails SQLITE_READONLY). URI
 * filenames are compiled out of this SQLite build, so `?immutable=1` is not an
 * option.
 */
export function openAntigravityDb(file: string): Database.Database | null {
	if (!fs.existsSync(file)) return null;
	const hasSidecars = fs.existsSync(`${file}-wal`);
	let db: Database.Database | undefined;
	try {
		// A short busy timeout: this runs on the main process, and a WAL reader is
		// not blocked by agy writing, so a long wait would only mean trouble.
		db = new Database(file, { readonly: hasSidecars, fileMustExist: true, timeout: 50 });
		if (!hasSidecars) db.pragma('query_only = ON');
		return db;
	} catch {
		db?.close();
		return null;
	}
}

function readStepPayload(conversationId: string, stepIndex: number): Uint8Array | null {
	if (!ANTIGRAVITY_CONVERSATION_ID.test(conversationId) || !Number.isInteger(stepIndex)) {
		return null;
	}
	const db = openAntigravityDb(antigravityConversationDbPath(conversationId));
	if (!db) return null;
	try {
		const row = db.prepare('SELECT step_payload FROM steps WHERE idx = ?').get(stepIndex) as
			| { step_payload?: Uint8Array | null }
			| undefined;
		return row?.step_payload ? new Uint8Array(row.step_payload) : null;
	} catch {
		// Expected failures (store reshaped, locked, opened mid-checkpoint) cost
		// the enrichment only. The stream already carries the turn itself.
		return null;
	} finally {
		db.close();
	}
}

/** The store agy writes on this machine. */
export const antigravityStepStore: AntigravityStepStore = {
	readThinking(conversationId, stepIndex) {
		const payload = readStepPayload(conversationId, stepIndex);
		return payload ? thinkingFromStepPayload(payload) : '';
	},
	readToolResult(conversationId, stepIndex) {
		const payload = readStepPayload(conversationId, stepIndex);
		return payload ? toolResultFromStepPayload(payload) : '';
	},
};

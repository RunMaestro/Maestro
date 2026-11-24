/**
 * Antigravity CLI (agy) stores on disk, for tests: the summary index
 * (`conversation_summaries.db`) and one `conversations/<id>.db` per
 * conversation, with step payloads in the protobuf field layout documented in
 * `src/main/parsers/antigravity-step-store.ts`. Written with `node:sqlite`, so
 * guard a suite with `describe.skipIf(!canLoadNodeSqlite())` and read them
 * through `nodeSqliteBetterSqlite3Mock()`.
 */

import * as fs from 'fs';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';

function varint(value: number): number[] {
	const out: number[] = [];
	while (value > 0x7f) {
		out.push((value & 0x7f) | 0x80);
		value = Math.floor(value / 128);
	}
	out.push(value);
	return out;
}
const bytes = (...parts: number[][]) => new Uint8Array(parts.flat());
function field(n: number, body: Uint8Array | string): number[] {
	const b = typeof body === 'string' ? Array.from(new TextEncoder().encode(body)) : [...body];
	return [...varint(n * 8 + 2), ...varint(b.length), ...b];
}
const num = (n: number, value: number) => [...varint(n * 8), ...varint(value)];
/** Step metadata (field 5): created time, plus whatever else the caller adds. */
const meta = (seconds: number, ...extra: number[][]) =>
	field(5, bytes(field(1, bytes(num(1, seconds))), ...extra));

export const AGY_USER_STEP = 14;
export const AGY_MODEL_STEP = 15;

/** A user step (14) carrying the prompt. */
export const agyUserStep = (seconds: number, prompt: string): [number, Uint8Array] => [
	AGY_USER_STEP,
	bytes(num(1, AGY_USER_STEP), meta(seconds), field(19, bytes(field(2, prompt)))),
];

/** A model step (15) carrying reply text and its usage record (5 -> 9). */
export const agyModelStep = (
	seconds: number,
	text: string,
	usage: { input: number; output: number; cacheRead: number; thinking?: number }
): [number, Uint8Array] => [
	AGY_MODEL_STEP,
	bytes(
		num(1, AGY_MODEL_STEP),
		meta(
			seconds,
			field(
				9,
				bytes(
					num(2, usage.input),
					num(3, usage.output),
					num(5, usage.cacheRead),
					num(9, usage.thinking ?? 0)
				)
			)
		),
		field(20, bytes(field(1, text)))
	),
];

/** Write `conversations/<id>.db` under `agyHome` with the given steps, in order. */
export function writeAgyConversation(
	agyHome: string,
	id: string,
	steps: Array<[number, Uint8Array]>
): string {
	const dir = path.join(agyHome, 'conversations');
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `${id}.db`);
	const db = new DatabaseSync(file);
	db.exec(
		'CREATE TABLE IF NOT EXISTS steps (idx integer PRIMARY KEY, step_type integer NOT NULL DEFAULT 0, step_payload blob)'
	);
	db.exec('DELETE FROM steps');
	const insert = db.prepare('INSERT INTO steps (idx, step_type, step_payload) VALUES (?, ?, ?)');
	steps.forEach(([type, payload], idx) => insert.run(idx, type, payload));
	db.close();
	return file;
}

/** Write (replace) `conversation_summaries.db` under `agyHome`. */
export function writeAgyIndex(
	agyHome: string,
	rows: Array<{
		id: string;
		steps: number;
		title?: string;
		lastModified?: string;
		workspaceUris?: string[];
		parent?: string;
	}>
): void {
	fs.mkdirSync(agyHome, { recursive: true });
	const db = new DatabaseSync(path.join(agyHome, 'conversation_summaries.db'));
	db.exec('DROP TABLE IF EXISTS conversation_summaries');
	db.exec(`CREATE TABLE conversation_summaries (conversation_id text PRIMARY KEY, title text NOT NULL DEFAULT "",
		step_count integer NOT NULL DEFAULT 0, last_modified_time datetime NOT NULL, workspace_uris text NOT NULL,
		parent_conversation_id text NOT NULL DEFAULT "")`);
	const insert = db.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?)');
	for (const row of rows) {
		insert.run(
			row.id,
			row.title ?? '',
			row.steps,
			row.lastModified ?? '2026-10-06 14:05:09.248083+00:00',
			JSON.stringify(row.workspaceUris ?? []),
			row.parent ?? ''
		);
	}
	db.close();
}

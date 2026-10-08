/**
 * The Antigravity step store against a real SQLite file laid out like agy
 * 1.2.16's conversation store, with step payloads encoded in the protobuf shape
 * read off real conversations (`protoc --decode_raw`).
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';
import { DatabaseSync } from 'node:sqlite';
import { canLoadNodeSqlite, nodeSqliteBetterSqlite3Mock } from '../../helpers/nodeSqlite';

const home = vi.hoisted(() => ({ dir: '' }));

vi.mock('better-sqlite3', () => nodeSqliteBetterSqlite3Mock());
vi.mock('os', async (importOriginal) => {
	const actual = await importOriginal<typeof import('os')>();
	return {
		...actual,
		default: { ...actual, homedir: () => home.dir },
		homedir: () => home.dir,
	};
});

import {
	antigravityStepStore,
	commandExitCode,
	storedResultSummary,
	thinkingFromStepPayload,
	toolResultFromStepPayload,
} from '../../../main/parsers/antigravity-step-store';

const CONVERSATION = '5fcbc005-e0f9-40b2-8fe6-136a764ea23a';

function varint(value: number): number[] {
	const out: number[] = [];
	while (value > 0x7f) {
		out.push((value & 0x7f) | 0x80);
		value = Math.floor(value / 128);
	}
	out.push(value);
	return out;
}

/** A length-delimited field (string or nested message). */
function field(fieldNumber: number, body: Uint8Array | string): number[] {
	const bytes = typeof body === 'string' ? Array.from(new TextEncoder().encode(body)) : [...body];
	return [...varint(fieldNumber * 8 + 2), ...varint(bytes.length), ...bytes];
}

function varintField(fieldNumber: number, value: number): number[] {
	return [...varint(fieldNumber * 8), ...varint(value)];
}

const bytes = (...parts: number[][]) => new Uint8Array(parts.flat());

/** Model step (type 15): metadata in 5, then 20 { 3: thinking, 7: tool call }. */
const MODEL_STEP = bytes(
	varintField(1, 15),
	varintField(4, 3),
	field(5, bytes(field(12, 'trajectory'), field(20, bytes(field(4, CONVERSATION))))),
	field(
		20,
		bytes(
			field(3, 'The prompt asks for a listing first.\n\nThen read the file.\n\n\n'),
			field(6, 'bot-1'),
			field(
				7,
				bytes(field(1, 'call_1'), field(2, 'view_file'), field(3, '{"AbsolutePath":"/w/a"}'))
			)
		)
	)
);

/** Tool step (type 132): the result text lives at 140 -> 2 -> 1. */
const TOOL_STEP = bytes(
	varintField(1, 132),
	field(5, bytes(field(4, bytes(field(1, 'call_2'), field(2, 'run_command'))))),
	field(
		140,
		bytes(
			field(1, bytes(field(1, 'CommandLine'), field(2, 'false'))),
			field(2, bytes(field(1, '\nThe command exited with code 1.\nStdout:\n\nStderr:\n\n')))
		)
	)
);

describe('thinkingFromStepPayload / toolResultFromStepPayload', () => {
	it('reads the thinking summary of a model step', () => {
		expect(thinkingFromStepPayload(MODEL_STEP)).toBe(
			'The prompt asks for a listing first.\n\nThen read the file.'
		);
		expect(toolResultFromStepPayload(MODEL_STEP)).toBe('');
	});

	it('reads the result text of a tool step', () => {
		expect(toolResultFromStepPayload(TOOL_STEP)).toBe(
			'\nThe command exited with code 1.\nStdout:\n\nStderr:\n\n'
		);
		expect(thinkingFromStepPayload(TOOL_STEP)).toBe('');
	});

	it('returns empty for truncated or garbage payloads instead of throwing', () => {
		expect(thinkingFromStepPayload(MODEL_STEP.subarray(0, 20))).toBe('');
		expect(toolResultFromStepPayload(new Uint8Array([0xff, 0xff, 0xff]))).toBe('');
	});
});

// Result texts verbatim from agy 1.2.16 stores (trimmed after the useful part).
describe('storedResultSummary / commandExitCode', () => {
	it('shows what a command printed, cleaned of CRLF', () => {
		const result = '\nThe command exited with code 0.\nOutput:\ntotal 8\r\nhello.txt\r\n\n';
		expect(commandExitCode(result)).toBe(0);
		expect(storedResultSummary(result)).toBe('total 8\nhello.txt');
	});

	it("falls back to the result's first line when a failed command printed nothing", () => {
		const result = '\nThe command exited with code 1.\nStdout:\n\nStderr:\n\n';
		expect(commandExitCode(result)).toBe(1);
		expect(storedResultSummary(result)).toBe('The command exited with code 1.');
	});

	it('joins stdout and stderr when both have text', () => {
		expect(
			storedResultSummary('\nThe command exited with code 2.\nStdout:\nok\nStderr:\nboom\n')
		).toBe('ok\nboom');
	});

	it('shows the diff an edit applied, not the instructions around it', () => {
		const result =
			"The following changes were made by the replace_file_content tool to: /w/hello.txt. Don't ask for permission.\n[diff_block_start]\n@@ -1,2 +1,2 @@\n alpha\n-bravo\n+BRAVO\n[diff_block_end]\n\nPlease note that the above snippet only shows the MODIFIED lines.";
		expect(commandExitCode(result)).toBeUndefined();
		expect(storedResultSummary(result)).toBe('@@ -1,2 +1,2 @@\n alpha\n-bravo\n+BRAVO');
	});
});

describe.skipIf(!canLoadNodeSqlite())('antigravityStepStore', () => {
	beforeAll(() => {
		home.dir = fs.mkdtempSync(path.join(tmpdir(), 'agy-store-'));
		const dir = path.join(home.dir, '.gemini', 'antigravity-cli', 'conversations');
		fs.mkdirSync(dir, { recursive: true });
		const db = new DatabaseSync(path.join(dir, `${CONVERSATION}.db`));
		db.exec(
			'CREATE TABLE steps (idx integer PRIMARY KEY, step_type integer NOT NULL DEFAULT 0, step_payload blob)'
		);
		const insert = db.prepare('INSERT INTO steps (idx, step_type, step_payload) VALUES (?, ?, ?)');
		insert.run(1, 15, MODEL_STEP);
		insert.run(2, 132, TOOL_STEP);
		db.close();
	});

	afterAll(() => {
		fs.rmSync(home.dir, { recursive: true, force: true });
	});

	it('reads a step by its stream step_index', () => {
		expect(antigravityStepStore.readThinking(CONVERSATION, 1)).toContain('listing first');
		expect(antigravityStepStore.readToolResult(CONVERSATION, 2)).toContain('exited with code 1');
	});

	it('reads nothing for a missing step, conversation, or unsafe id', () => {
		expect(antigravityStepStore.readThinking(CONVERSATION, 9)).toBe('');
		expect(antigravityStepStore.readThinking('0f0f0f0f-0000-0000-0000-000000000000', 1)).toBe('');
		expect(antigravityStepStore.readThinking('../../etc/passwd', 1)).toBe('');
	});
});

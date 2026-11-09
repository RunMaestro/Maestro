/**
 * The parse tasks stream every transcript one line at a time. Reading one
 * whole inside the worker aborted the entire app when a large transcript did
 * not fit the worker heap (MAESTRO-183, MAESTRO-184, MAESTRO-186).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'os';
import path from 'path';

// A task must never read a transcript as one string. `fs/promises.readFile` is
// what the tasks used to call; fail loudly if anything reachable calls it.
vi.mock('fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof import('fs/promises')>();
	const readFile = vi.fn(() => {
		throw new Error('a transcript was read whole');
	});
	return { ...actual, readFile, default: { ...actual, readFile } };
});

import { promises as fs } from 'fs';
import {
	parseClaudeSessionInfo,
	runTranscriptParseTask,
} from '../../../main/transcript-parse/transcript-parse-tasks';
import { claudeSubagentDir } from '../../../shared/claudeSessionUsage';

const BASE = Date.UTC(2026, 10, 1, 10, 0, 0);
const at = (seconds: number) => new Date(BASE + seconds * 1000).toISOString();

const userLine = (seconds: number, content: string) =>
	JSON.stringify({ type: 'user', timestamp: at(seconds), message: { role: 'user', content } });

const assistantLine = (seconds: number, id: string, inputTokens: number, text = 'Done.') =>
	JSON.stringify({
		type: 'assistant',
		timestamp: at(seconds),
		requestId: `req_${id}`,
		message: {
			id,
			model: 'claude-opus-4-8',
			content: [{ type: 'text', text }],
			usage: { input_tokens: inputTokens, output_tokens: 500 },
		},
	});

describe('transcript parse tasks', () => {
	let dir: string;
	let sessionFile: string;
	let parent: string;
	let subagents: string[];

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maestro-parse-tasks-'));
		sessionFile = path.join(dir, 'abc.jsonl');
		parent = [
			JSON.stringify({ type: 'summary', summary: 'no timestamp here' }),
			userLine(0, 'Fix the bug'),
			assistantLine(5, 'msg_1', 1000, 'Looking into it.'),
			assistantLine(6, 'msg_1', 1000, 'Looking into it.'),
			'',
			'not json',
			userLine(60, 'Thanks'),
			assistantLine(90, 'msg_2', 2000),
		].join('\n');
		subagents = [
			[userLine(10, 'sub task'), assistantLine(15, 'msg_sub_a', 4000)].join('\n'),
			[userLine(20, 'other task'), assistantLine(24, 'msg_sub_b', 8000)].join('\n'),
		];
		await fs.writeFile(sessionFile, parent);
		const subDir = claudeSubagentDir(sessionFile);
		await fs.mkdir(subDir, { recursive: true });
		await fs.writeFile(path.join(subDir, 'agent-a.jsonl'), subagents[0]);
		await fs.writeFile(path.join(subDir, 'agent-b.jsonl'), subagents[1]);
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	it('streams session info that matches the same transcripts parsed in hand', async () => {
		const stats = { size: 1234, mtimeMs: BASE + 3_600_000 };
		const streamed = await runTranscriptParseTask({
			kind: 'claude-session-info',
			filePath: sessionFile,
			sessionId: 'abc',
			projectPath: '/project',
			sizeBytes: stats.size,
			mtimeMs: stats.mtimeMs,
		});

		expect(streamed).toEqual(parseClaudeSessionInfo(parent, 'abc', '/project', stats, subagents));
		expect(streamed.firstMessage).toBe('Looking into it.');
		expect(streamed.timestamp).toBe(at(0));
		expect(streamed.durationSeconds).toBe(90);
		expect(streamed.messageCount).toBe(4);
		// Parent plus both subagents, the repeated content block counted once.
		expect(streamed.inputTokens).toBe(1000 + 2000 + 4000 + 8000);
		expect((streamed.speed ?? []).reduce((sum, b) => sum + b.calls, 0)).toBe(4);
	});

	it('streams usage stats with subagent usage but only the session own messages', async () => {
		const result = await runTranscriptParseTask({
			kind: 'claude-usage-stats',
			filePath: sessionFile,
			sizeBytes: 42,
		});
		expect(result.messages).toBe(4);
		expect(result.inputTokens).toBe(15_000);
		expect(result.outputTokens).toBe(2000);
		expect(result.sizeBytes).toBe(42);
		expect(result.costUsd).toBeGreaterThan(0);
	});

	it('streams project stats and finds the oldest timestamp near the top', async () => {
		const result = await runTranscriptParseTask({
			kind: 'claude-project-stats',
			filePath: sessionFile,
			sizeBytes: 42,
		});
		expect(result.messages).toBe(4);
		expect(result.tokenSplit.inputTokens).toBe(15_000);
		expect(result.tokens).toBe(15_000 + 2000);
		expect(result.oldestTimestamp).toBe(at(0));
	});

	it('handles a session with no subagents and CRLF line endings', async () => {
		await fs.rm(path.dirname(claudeSubagentDir(sessionFile)), { recursive: true });
		await fs.writeFile(sessionFile, parent.split('\n').join('\r\n'));
		const result = await runTranscriptParseTask({
			kind: 'claude-usage-stats',
			filePath: sessionFile,
			sizeBytes: 42,
		});
		expect(result.messages).toBe(4);
		expect(result.inputTokens).toBe(3000);
	});

	it('streams Codex usage, skipping malformed and non-object lines', async () => {
		const rollout = path.join(dir, 'rollout.jsonl');
		await fs.writeFile(
			rollout,
			[
				JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user' } }),
				'null',
				'not json',
				JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant' } }),
				JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'system' } }),
			].join('\n')
		);
		const result = await runTranscriptParseTask({
			kind: 'codex-usage-stats',
			filePath: rollout,
			sizeBytes: 7,
		});
		expect(result.messages).toBe(2);
		expect(result.sizeBytes).toBe(7);
	});

	it('rejects for a missing transcript, as the whole-file read did', async () => {
		await expect(
			runTranscriptParseTask({
				kind: 'claude-usage-stats',
				filePath: path.join(dir, 'missing.jsonl'),
				sizeBytes: 0,
			})
		).rejects.toMatchObject({ code: 'ENOENT' });
	});
});

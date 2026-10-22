/**
 * Subagent transcripts live beside their session at
 * `<sessionId>/subagents/agent-*.jsonl` and must be priced into it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import {
	claudeSubagentDir,
	computeClaudeSessionUsage,
	computeClaudeUsageWithSubagents,
	readClaudeSubagentTranscripts,
	readClaudeSubagentTranscriptsSync,
} from '../../shared/claudeSessionUsage';

const usageLine = (id: string, inputTokens: number) =>
	JSON.stringify({
		type: 'assistant',
		requestId: `req_${id}`,
		message: { id, model: 'claude-opus-4-8', usage: { input_tokens: inputTokens } },
	});

describe('claudeSessionUsage', () => {
	let dir: string;
	let sessionFile: string;

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maestro-subagents-'));
		sessionFile = path.join(dir, 'abc.jsonl');
		await fs.writeFile(sessionFile, usageLine('msg_parent', 1_000_000));
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	it('locates subagents in a folder named after the session', () => {
		expect(claudeSubagentDir(sessionFile)).toBe(path.join(dir, 'abc', 'subagents'));
	});

	it('reads nothing when the session spawned no subagents', async () => {
		expect(await readClaudeSubagentTranscripts(sessionFile)).toEqual([]);
		expect(readClaudeSubagentTranscriptsSync(sessionFile)).toEqual([]);
	});

	it('adds every subagent transcript to the session total, ignoring non-transcripts', async () => {
		const subagents = claudeSubagentDir(sessionFile);
		await fs.mkdir(subagents, { recursive: true });
		await fs.writeFile(path.join(subagents, 'agent-a.jsonl'), usageLine('msg_a', 2_000_000));
		await fs.writeFile(path.join(subagents, 'agent-b.jsonl'), usageLine('msg_b', 3_000_000));
		await fs.writeFile(path.join(subagents, 'notes.txt'), usageLine('msg_c', 9_000_000));

		expect(readClaudeSubagentTranscriptsSync(sessionFile)).toHaveLength(2);

		const parent = await fs.readFile(sessionFile, 'utf-8');
		const usage = await computeClaudeSessionUsage(sessionFile, parent);
		expect(usage.inputTokens).toBe(6_000_000);
		// 6M Opus input at $5 per million.
		expect(usage.costUsd).toBeCloseTo(30, 10);
	});

	it('counts a response once even if it appears in both the parent and a subagent', () => {
		const shared = usageLine('msg_same', 1_000_000);
		expect(computeClaudeUsageWithSubagents(shared, [shared]).inputTokens).toBe(1_000_000);
	});
});

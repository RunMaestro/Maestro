/**
 * @file subagent-watcher.test.ts
 * @description Tests for src/maestro-p/subagent-watcher.ts - following a
 * session's subagent transcripts and linking each to its Task call.
 *
 * Drives real temp files with fast polling, the same strategy as the
 * JsonlTailer tests.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
	SubagentStream,
	SubagentWatcher,
	readSubagentToolUseId,
	subagentsDir,
} from '../../maestro-p/subagent-watcher';

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`waitUntil: condition not met within ${timeoutMs}ms`);
}

describe('subagentsDir', () => {
	it('is the session transcript path without .jsonl, plus subagents', () => {
		expect(subagentsDir('/p/proj/abc.jsonl')).toBe(path.join('/p/proj/abc', 'subagents'));
	});
});

describe('SubagentWatcher', () => {
	let root: string;
	let transcript: string;
	let dir: string;
	let watcher: SubagentWatcher | null;

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-p-subagents-'));
		transcript = path.join(root, 'session.jsonl');
		dir = subagentsDir(transcript);
		watcher = null;
	});

	afterEach(() => {
		watcher?.stop();
		fs.rmSync(root, { recursive: true, force: true });
	});

	// Shape captured from a real TUI session (claude 2.1.296).
	const writeSubagent = (agentId: string, toolUseId: string, rows: unknown[]) => {
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, `agent-${agentId}.meta.json`),
			JSON.stringify({ agentType: 'Explore', description: 'Map it', toolUseId, spawnDepth: 1 })
		);
		fs.writeFileSync(
			path.join(dir, `agent-${agentId}.jsonl`),
			rows.map((row) => JSON.stringify(row)).join('\n') + '\n'
		);
	};

	const startWatcher = () => {
		const seen: Array<{ entry: unknown; toolUseId: string }> = [];
		watcher = new SubagentWatcher({ sessionTranscriptPath: transcript, pollIntervalMs: 10 });
		watcher.on('entry', (entry: unknown, toolUseId: string) => seen.push({ entry, toolUseId }));
		watcher.start();
		return seen;
	};

	it('forwards a subagent started after it began, tagged with its Task call', async () => {
		const seen = startWatcher();
		const row = { type: 'assistant', isSidechain: true, message: { content: [] } };
		writeSubagent('a1', 'toolu_task_1', [row]);

		await waitUntil(() => seen.length === 1);
		expect(seen[0]).toEqual({ entry: row, toolUseId: 'toolu_task_1' });
	});

	it('keeps following a subagent transcript as it grows', async () => {
		const seen = startWatcher();
		writeSubagent('a1', 'toolu_task_1', [{ type: 'user', n: 1 }]);
		await waitUntil(() => seen.length === 1);

		fs.appendFileSync(
			path.join(dir, 'agent-a1.jsonl'),
			JSON.stringify({ type: 'user', n: 2 }) + '\n'
		);

		await waitUntil(() => seen.length === 2);
		expect(watcher?.getLastByteAt()).toBeGreaterThan(0);
	});

	// A resumed session's earlier subagents were an earlier turn's output.
	it('skips subagents that existed before it started', async () => {
		writeSubagent('old', 'toolu_old', [{ type: 'assistant', old: true }]);
		const seen = startWatcher();
		writeSubagent('new', 'toolu_new', [{ type: 'assistant', old: false }]);

		await waitUntil(() => seen.length === 1);
		await new Promise<void>((resolve) => setTimeout(resolve, 50));
		expect(seen.map((s) => s.toolUseId)).toEqual(['toolu_new']);
	});

	it('waits for a meta file that is not readable yet', async () => {
		const seen = startWatcher();
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, 'agent-a1.meta.json'), '{"toolUse');
		fs.writeFileSync(path.join(dir, 'agent-a1.jsonl'), JSON.stringify({ type: 'user' }) + '\n');
		await new Promise<void>((resolve) => setTimeout(resolve, 50));
		expect(seen).toEqual([]);

		fs.writeFileSync(path.join(dir, 'agent-a1.meta.json'), JSON.stringify({ toolUseId: 't1' }));

		await waitUntil(() => seen.length === 1);
		expect(seen[0].toolUseId).toBe('t1');
	});

	it('reports no activity before any subagent has written', () => {
		startWatcher();
		expect(watcher?.getLastByteAt()).toBe(0);
	});
});

describe('readSubagentToolUseId', () => {
	it('returns null for a meta file without a toolUseId, or none at all', () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-p-meta-'));
		try {
			const meta = path.join(root, 'agent.meta.json');
			fs.writeFileSync(meta, JSON.stringify({ agentType: 'Explore' }));
			expect(readSubagentToolUseId(meta)).toBe(null);
			expect(readSubagentToolUseId(path.join(root, 'missing.meta.json'))).toBe(null);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

// What `claude -p` streams for a subagent, measured against claude 2.1.296.
describe('SubagentStream', () => {
	const prompt = { type: 'user', message: { role: 'user', content: 'Run echo sub-ok.' } };
	const narration = {
		type: 'assistant',
		message: { role: 'assistant', content: [{ type: 'text', text: 'starting now.' }] },
	};
	const toolCall = {
		type: 'assistant',
		message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_bash', name: 'Bash' }] },
	};
	const toolResult = {
		type: 'user',
		message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_bash' }] },
	};

	it('forwards the prompt as a text block, once per Task call', () => {
		const stream = new SubagentStream();

		expect(stream.forward(prompt, 'toolu_task')).toEqual({
			type: 'user',
			message: { role: 'user', content: [{ type: 'text', text: 'Run echo sub-ok.' }] },
		});
		expect(stream.forward(prompt, 'toolu_task')).toBeNull();
		expect(stream.forward(prompt, 'toolu_other')).not.toBeNull();
	});

	it('forwards tool calls and their results', () => {
		const stream = new SubagentStream();

		expect(stream.forward(toolCall, 't')).toEqual({ type: 'assistant', message: toolCall.message });
		expect(stream.forward(toolResult, 't')).toEqual({ type: 'user', message: toolResult.message });
	});

	// The final answer reaches the main thread as the Task result; forwarding it
	// would put the subagent's words in the caller's reply.
	it('drops the subagent text, synthetic rows, and meta rows', () => {
		const stream = new SubagentStream();

		expect(stream.forward(narration, 't')).toBeNull();
		expect(
			stream.forward({ type: 'assistant', message: { model: '<synthetic>', content: [] } }, 't')
		).toBeNull();
		expect(stream.forward({ ...prompt, isMeta: true }, 't')).toBeNull();
		expect(stream.forward({ type: 'attachment' }, 't')).toBeNull();
	});
});

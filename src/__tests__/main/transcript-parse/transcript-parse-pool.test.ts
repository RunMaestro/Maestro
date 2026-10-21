import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

vi.mock('../../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
	resetTranscriptParsePoolForTest,
	runTranscriptParse,
	transcriptParsePoolMode,
} from '../../../main/transcript-parse/transcript-parse-pool';
import {
	rehydrateParseError,
	serializeParseError,
} from '../../../main/transcript-parse/transcript-parse-protocol';

// A stand-in worker that speaks the pool's protocol. The real worker runs the
// `.ts` task bodies, which only exist compiled; the tasks are covered on their
// own and through the handler tests, which take the inline path.
const FIXTURE_WORKER = `
const { parentPort, threadId } = require('worker_threads');
parentPort.on('message', ({ id, task }) => {
	if (task.filePath === 'crash') process.exit(3);
	if (task.filePath === 'too-large') {
		parentPort.postMessage({ id, ok: false, error: { name: 'RangeError', message: 'Invalid string length' } });
		return;
	}
	if (task.filePath === 'vanished') {
		parentPort.postMessage({ id, ok: false, error: { name: 'Error', message: 'gone', code: 'ENOENT' } });
		return;
	}
	parentPort.postMessage({ id, ok: true, result: { echoed: task.filePath, threadId } });
});
`;

let dir: string;
let workerScript: string;

beforeAll(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maestro-parse-pool-'));
	workerScript = path.join(dir, 'fixture-worker.js');
	await fs.writeFile(workerScript, FIXTURE_WORKER);
});

afterEach(async () => {
	await resetTranscriptParsePoolForTest();
});

afterAll(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

const task = (filePath: string) => ({ kind: 'codex-usage-stats', filePath, sizeBytes: 1 }) as const;

describe('transcript parse pool: worker threads', () => {
	it('runs tasks off the calling thread', async () => {
		await resetTranscriptParsePoolForTest(workerScript);
		expect(transcriptParsePoolMode()).toBe('worker');

		const results = (await Promise.all(
			['a', 'b', 'c', 'd', 'e', 'f'].map((name) => runTranscriptParse(task(name)))
		)) as unknown as Array<{ echoed: string; threadId: number }>;

		expect(results.map((r) => r.echoed)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
		// threadId 0 is the main thread.
		expect(results.every((r) => r.threadId > 0)).toBe(true);
	});

	it('rebuilds the error class and code a caller branches on', async () => {
		await resetTranscriptParsePoolForTest(workerScript);

		await expect(runTranscriptParse(task('too-large'))).rejects.toBeInstanceOf(RangeError);
		await expect(runTranscriptParse(task('vanished'))).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('fails only the task whose worker died, and keeps serving the rest', async () => {
		await resetTranscriptParsePoolForTest(workerScript);

		await expect(runTranscriptParse(task('crash'))).rejects.toThrow(/exited with code 3/);
		await expect(runTranscriptParse(task('after'))).resolves.toMatchObject({ echoed: 'after' });
	});
});

describe('transcript parse pool: inline fallback', () => {
	it('parses on the calling thread when no compiled worker exists', async () => {
		await resetTranscriptParsePoolForTest(path.join(dir, 'missing-worker.js'));
		const transcript = path.join(dir, 'rollout.jsonl');
		await fs.writeFile(
			transcript,
			'{"type":"response_item","payload":{"type":"message","role":"user"}}\n'
		);

		const stats = await runTranscriptParse({
			kind: 'codex-usage-stats',
			filePath: transcript,
			sizeBytes: 64,
		});

		expect(transcriptParsePoolMode()).toBe('inline');
		expect(stats).toMatchObject({ messages: 1, sizeBytes: 64 });
	});
});

describe('transcript parse protocol', () => {
	it('round-trips class, message and code', () => {
		const original = Object.assign(new Error('EACCES: denied'), { code: 'EACCES' });
		const rebuilt = rehydrateParseError(serializeParseError(original));
		expect(rebuilt).toBeInstanceOf(Error);
		expect(rebuilt.message).toBe('EACCES: denied');
		expect((rebuilt as NodeJS.ErrnoException).code).toBe('EACCES');

		expect(rehydrateParseError(serializeParseError(new RangeError('big')))).toBeInstanceOf(
			RangeError
		);
	});

	it('keeps a custom error name', () => {
		const error = new Error('custom');
		error.name = 'AbortError';
		expect(rehydrateParseError(serializeParseError(error)).name).toBe('AbortError');
	});

	it('serializes a thrown non-error', () => {
		expect(serializeParseError('plain')).toEqual({ name: 'Error', message: 'plain' });
	});
});

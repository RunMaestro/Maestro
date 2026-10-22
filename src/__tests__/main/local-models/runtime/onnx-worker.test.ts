/** Exercises the real worker entry and transport with a blocking runtime fixture. */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { once } from 'events';
import { Worker } from 'worker_threads';
import { buildSync } from 'esbuild';

vi.mock('electron', () => ({ app: { getPath: () => process.cwd() } }));

import { OnnxWorkerSession } from '../../../../main/local-models/runtime/onnx-worker-session';

let root: string;
let entry: string;
let runtime: string;
const sessions: OnnxWorkerSession[] = [];

beforeAll(() => {
	root = mkdtempSync(path.join(tmpdir(), 'maestro-onnx-worker-'));
	entry = path.join(root, 'onnx-worker.cjs');
	runtime = path.join(root, 'runtime.cjs');
	buildSync({
		entryPoints: [path.resolve(__dirname, '../../../../main/local-models/runtime/onnx-worker.ts')],
		outfile: entry,
		bundle: true,
		platform: 'node',
		format: 'cjs',
		external: ['electron'],
	});
	writeFileSync(
		runtime,
		`
const { parentPort, threadId } = require('worker_threads');
class Tensor {
  constructor(type, data, dims) { this.type = type; this.values = data; this.shape = dims; }
  get data() { return this.values; }
  get dims() { return this.shape; }
}
exports.Tensor = Tensor;
exports.InferenceSession = {
  async create(_model, options) {
    return {
      inputNames: ['input_ids', 'flags', 'gate'], outputNames: ['embeddings'],
      async run(feeds) {
        if (feeds.fail) throw new Error('fixture inference failure');
        if (feeds.gate) {
          parentPort.postMessage({ id: -1, type: 'running', threadId });
          if (Atomics.wait(feeds.gate.data, 0, 0, 5000) === 'timed-out') {
            throw new Error('main event loop did not release the worker');
          }
        }
        return { embeddings: new Tensor('float32', Float32Array.from([
          threadId, Number(feeds.input_ids.data[0]), feeds.flags?.data[0] ?? 0,
          feeds.gate?.type === 'int32' ? 1 : 0, options.intraOpNumThreads
        ]), [1, 5]) };
      }
    };
  }
};
`
	);
});

afterEach(async () => {
	await Promise.all(sessions.splice(0).map((session) => session.release()));
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

async function openWorker(): Promise<{ worker: Worker; session: OnnxWorkerSession }> {
	const worker = new Worker(entry, { workerData: { runtimeEntry: runtime } });
	const session = new OnnxWorkerSession(worker);
	sessions.push(session);
	const ready = once(worker, 'message');
	worker.postMessage({
		id: -1,
		type: 'open',
		modelPath: 'fixture.onnx',
		options: { intraOpNumThreads: 2, interOpNumThreads: 1, executionMode: 'sequential' },
	});
	const [response] = await ready;
	expect(response).toMatchObject({ type: 'opened', inputNames: ['input_ids', 'flags', 'gate'] });
	return { worker, session };
}

describe('ONNX worker entry', () => {
	it('keeps main responsive during blocking inference and preserves tensor types across threads', async () => {
		const { worker, session } = await openWorker();
		const gate = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
		const running = once(worker, 'message');
		const inference = session.run({
			input_ids: { data: BigInt64Array.from([7n]), dims: [1, 1] },
			flags: { data: Uint8Array.from([1]), dims: [1, 1] },
			gate: { data: gate, dims: [1] },
		});
		const [message] = await running;
		expect(message.type).toBe('running');
		expect(message.threadId).toBeGreaterThan(0);
		await new Promise<void>((resolve) =>
			setImmediate(() => {
				Atomics.store(gate, 0, 1);
				Atomics.notify(gate, 0);
				resolve();
			})
		);
		const result = await inference;
		expect(result.embeddings.dims).toEqual([1, 5]);
		expect(Array.from(result.embeddings.data)).toEqual([message.threadId, 7, 1, 1, 2]);
	});

	it('reports an inference error without losing the worker session', async () => {
		const { session } = await openWorker();
		await expect(session.run({ fail: { data: Uint8Array.from([1]), dims: [1] } })).rejects.toThrow(
			'fixture inference failure'
		);
		const result = await session.run({
			input_ids: { data: BigInt64Array.from([9n]), dims: [1, 1] },
		});
		expect(result.embeddings.data[1]).toBe(9);
	});
});

import { EventEmitter } from 'events';
import { Worker } from 'worker_threads';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('worker_threads', () => ({ Worker: vi.fn() }));
vi.mock('../../../../main/local-models/runtime/load-runtime', () => ({
	loadLocalRuntime: vi.fn(),
}));
vi.mock('../../../../main/local-models/runtime/runtime-store', () => ({
	installedRuntimeEntry: vi.fn(async () => '/runtimes/onnx/dist/index.js'),
}));

import { loadLocalRuntime } from '../../../../main/local-models/runtime/load-runtime';
import {
	loadOnnxWorkerRuntime,
	OnnxWorkerSession,
	type OnnxWorkerRequest,
} from '../../../../main/local-models/runtime/onnx-worker-session';
import type { OnnxModule } from '../../../../main/local-models/runtime/onnx-types';

class FakeWorker extends EventEmitter {
	postMessage = vi.fn((request: OnnxWorkerRequest) => {
		if (request.type === 'open') {
			queueMicrotask(() =>
				this.emit('message', {
					id: request.id,
					type: 'opened',
					inputNames: ['input_ids'],
					outputNames: ['embeddings'],
				})
			);
		}
	});
	unref = vi.fn();
	terminate = vi.fn(async () => 0);
}

let worker: FakeWorker;

beforeEach(() => {
	worker = new FakeWorker();
	vi.mocked(Worker).mockImplementation(function () {
		return worker as unknown as Worker;
	});
});

afterEach(() => vi.clearAllMocks());

describe('ONNX worker session', () => {
	it('validates the runtime through the core loader and creates the graph in a worker', async () => {
		const Tensor = class {};
		vi.mocked(loadLocalRuntime).mockResolvedValue({ Tensor } as unknown as OnnxModule);
		const ort = await loadOnnxWorkerRuntime('semantic-search');
		const options = {
			intraOpNumThreads: 2,
			interOpNumThreads: 1,
			executionMode: 'sequential' as const,
		};
		const session = await ort.InferenceSession.create('/models/gemma.onnx', options);

		expect(loadLocalRuntime).toHaveBeenCalledWith('onnx', 'semantic-search');
		expect(ort.Tensor).toBe(Tensor);
		expect(Worker).toHaveBeenCalledWith(expect.stringMatching(/onnx-worker\.js$/), {
			workerData: { runtimeEntry: '/runtimes/onnx/dist/index.js' },
		});
		expect(worker.postMessage).toHaveBeenCalledWith({
			id: 0,
			type: 'open',
			modelPath: '/models/gemma.onnx',
			options,
		});
		expect(session.inputNames).toEqual(['input_ids']);
		expect(session.outputNames).toEqual(['embeddings']);
		expect(worker.unref).toHaveBeenCalledOnce();
		await session.release?.();
	});

	it('copies native tensor accessors to plain messages and returns output vectors', async () => {
		const session = await OnnxWorkerSession.open('/runtime.js', '/model.onnx');
		const ids = BigInt64Array.from([1n, 2n]);
		const native = Object.create(null, {
			dims: { get: () => [1, 2] },
			data: { get: () => ids },
		});
		const run = session.run({ input_ids: native });
		expect(worker.postMessage).toHaveBeenLastCalledWith({
			id: 1,
			type: 'run',
			feeds: { input_ids: { dims: [1, 2], data: ids } },
		});
		const outputs = { embeddings: { dims: [1, 2], data: new Float32Array([0.2, 0.8]) } };
		worker.emit('message', { id: 1, type: 'result', outputs });
		await expect(run).resolves.toEqual(outputs);
		await session.release();
	});

	it('rejects an inference failure without confusing it with another request', async () => {
		const session = await OnnxWorkerSession.open('/runtime.js', '/model.onnx');
		const run = session.run({});
		worker.emit('message', { id: 1, type: 'error', message: 'invalid shape' });
		await expect(run).rejects.toThrow('invalid shape');
		await session.release();
	});

	it('terminates a worker whose model fails to open', async () => {
		worker.postMessage.mockImplementation((request) => {
			queueMicrotask(() =>
				worker.emit('message', {
					id: request.id,
					type: 'error',
					message: 'model is corrupt',
				})
			);
		});
		await expect(OnnxWorkerSession.open('/runtime.js', '/model.onnx')).rejects.toThrow(
			'model is corrupt'
		);
		expect(worker.terminate).toHaveBeenCalledOnce();
	});

	it('rejects pending and future work after an unexpected worker exit', async () => {
		const session = await OnnxWorkerSession.open('/runtime.js', '/model.onnx');
		const run = session.run({});
		worker.emit('exit', 1);
		await expect(run).rejects.toThrow('ONNX worker exited (code 1)');
		await expect(session.run({})).rejects.toThrow('ONNX worker exited (code 1)');
		await session.release();
	});

	it('releases model resources and rejects pending work on unload', async () => {
		const session = await OnnxWorkerSession.open('/runtime.js', '/model.onnx');
		const run = session.run({});
		const rejected = expect(run).rejects.toThrow('ONNX worker session was released');
		await session.release();
		await rejected;
		expect(worker.terminate).toHaveBeenCalledOnce();
	});
});

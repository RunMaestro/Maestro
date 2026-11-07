/**
 * Encoder sessions run in a Node worker: onnxruntime-node's Promise API calls
 * synchronous native inference, so awaiting it in main still freezes Electron.
 * The encoder pool owns serialization and idle unload; releasing a session
 * terminates its worker and returns its model memory and CPU threads.
 */
import * as path from 'path';
import { Worker } from 'worker_threads';
import { getNativeRuntime } from '../../../shared/local-models/native-runtimes';
import { loadLocalRuntime } from './load-runtime';
import { installedRuntimeEntry } from './runtime-store';
import type { OnnxModule, OnnxSession, OnnxSessionOptions, OnnxTensor } from './onnx-types';

export type OnnxWorkerRequest =
	| { id: number; type: 'open'; modelPath: string; options?: OnnxSessionOptions }
	| { id: number; type: 'run'; feeds: Record<string, OnnxTensor> };

export type OnnxWorkerResponse =
	| { id: number; type: 'opened'; inputNames: string[]; outputNames: string[] }
	| { id: number; type: 'result'; outputs: Record<string, OnnxTensor> }
	| { id: number; type: 'error'; message: string };

/** Preserve runtime validation and diagnostics in the core loader on main. */
export async function loadOnnxWorkerRuntime(consumerId: string): Promise<OnnxModule> {
	const ort = await loadLocalRuntime<OnnxModule>('onnx', consumerId);
	const runtimeEntry =
		(await installedRuntimeEntry('onnx')) ?? require.resolve(getNativeRuntime('onnx')!.moduleId);
	return {
		Tensor: ort.Tensor,
		InferenceSession: {
			create: (modelPath, options) => OnnxWorkerSession.open(runtimeEntry, modelPath, options),
		},
	};
}

export class OnnxWorkerSession implements OnnxSession {
	readonly inputNames: string[] = [];
	readonly outputNames: string[] = [];
	private nextId = 0;
	private failure: Error | null = null;
	private readonly pending = new Map<
		number,
		{ resolve: (response: OnnxWorkerResponse) => void; reject: (error: Error) => void }
	>();

	constructor(private readonly worker: Worker) {
		worker.on('message', (response: OnnxWorkerResponse) => {
			const request = this.pending.get(response.id);
			if (!request) return;
			this.pending.delete(response.id);
			if (response.type === 'error') request.reject(new Error(response.message));
			else request.resolve(response);
		});
		worker.on('error', (error) => this.fail(error));
		worker.on('exit', (code) => this.fail(new Error(`ONNX worker exited (code ${code}).`)));
		// A resident but idle encoder must not keep the app alive.
		worker.unref();
	}

	static async open(
		runtimeEntry: string,
		modelPath: string,
		options?: OnnxSessionOptions
	): Promise<OnnxWorkerSession> {
		const session = new OnnxWorkerSession(
			new Worker(path.join(__dirname, 'onnx-worker.js'), { workerData: { runtimeEntry } })
		);
		try {
			const response = await session.request({ type: 'open', modelPath, options });
			if (response.type !== 'opened') throw new Error('ONNX worker did not open the model.');
			session.inputNames.push(...response.inputNames);
			session.outputNames.push(...response.outputNames);
			return session;
		} catch (error) {
			await session.release();
			throw error;
		}
	}

	async run(feeds: Record<string, OnnxTensor>): Promise<Record<string, OnnxTensor>> {
		// Native Tensor instances have accessors and cannot be structured-cloned.
		const plain = Object.fromEntries(
			Object.entries(feeds).map(([name, tensor]) => [
				name,
				{ dims: [...tensor.dims], data: tensor.data },
			])
		);
		const response = await this.request({ type: 'run', feeds: plain });
		if (response.type !== 'result') throw new Error('ONNX worker returned no inference output.');
		return response.outputs;
	}

	async release(): Promise<void> {
		this.fail(new Error('ONNX worker session was released.'));
		await this.worker.terminate();
	}

	private request(
		request:
			| Omit<Extract<OnnxWorkerRequest, { type: 'open' }>, 'id'>
			| Omit<Extract<OnnxWorkerRequest, { type: 'run' }>, 'id'>
	): Promise<OnnxWorkerResponse> {
		if (this.failure) return Promise.reject(this.failure);
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			try {
				this.worker.postMessage({ ...request, id });
			} catch (error) {
				this.pending.delete(id);
				reject(error);
			}
		});
	}

	private fail(error: Error): void {
		this.failure ??= error;
		for (const request of this.pending.values()) request.reject(this.failure);
		this.pending.clear();
	}
}

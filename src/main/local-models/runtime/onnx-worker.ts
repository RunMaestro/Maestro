/** Worker entry point. No Electron imports or stores are reachable from here. */
import { parentPort, workerData } from 'worker_threads';
import { importNativeRuntimeEntry } from './native-loader';
import type { OnnxModule, OnnxSession, OnnxTensor } from './onnx-types';
import type { OnnxWorkerRequest, OnnxWorkerResponse } from './onnx-worker-session';

const port = parentPort!;
let ort: OnnxModule;
let session: OnnxSession;

async function handle(request: OnnxWorkerRequest): Promise<OnnxWorkerResponse> {
	if (request.type === 'open') {
		ort = (await importNativeRuntimeEntry(workerData.runtimeEntry)) as OnnxModule;
		session = await ort.InferenceSession.create(request.modelPath, request.options);
		return {
			id: request.id,
			type: 'opened',
			inputNames: [...session.inputNames],
			outputNames: [...session.outputNames],
		};
	}
	const feeds: Record<string, OnnxTensor> = {};
	for (const [name, tensor] of Object.entries(request.feeds)) {
		const type =
			tensor.data instanceof BigInt64Array
				? 'int64'
				: tensor.data instanceof Int32Array
					? 'int32'
					: tensor.data instanceof Uint8Array
						? 'bool'
						: 'float32';
		feeds[name] = new ort.Tensor(type, tensor.data, tensor.dims);
	}
	const result = await session.run(feeds);
	const outputs = Object.fromEntries(
		Object.entries(result).map(([name, tensor]) => [
			name,
			{ dims: [...tensor.dims], data: tensor.data },
		])
	);
	return { id: request.id, type: 'result', outputs };
}

port.on('message', (request: OnnxWorkerRequest) => {
	void handle(request).then(
		(response) => port.postMessage(response),
		(error: unknown) =>
			port.postMessage({
				id: request.id,
				type: 'error',
				message: error instanceof Error ? error.message : String(error),
			} satisfies OnnxWorkerResponse)
	);
});

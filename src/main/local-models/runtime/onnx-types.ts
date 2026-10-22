/**
 * The ONNX Runtime surface the local speech-to-text engines use, structurally.
 *
 * Declared rather than imported: `onnxruntime-node` is a downloaded runtime, so
 * a static import would make it a build dependency and defeat the whole reason
 * it is fetched on demand. Whisper and Parakeet both ride this one declaration,
 * so a dtype one engine needs (Parakeet's int32 `targets`) is added once rather
 * than to a private copy that the other engine then drifts from.
 */

export type OnnxTensorData = Float32Array | BigInt64Array | Int32Array | Uint8Array;

export interface OnnxTensor {
	readonly dims: readonly number[];
	readonly data: OnnxTensorData;
}

export interface OnnxSession {
	readonly inputNames: readonly string[];
	readonly outputNames: readonly string[];
	run(feeds: Record<string, OnnxTensor>): Promise<Record<string, OnnxTensor>>;
	release?(): Promise<void>;
}

export interface OnnxModule {
	InferenceSession: { create(path: string, options?: OnnxSessionOptions): Promise<OnnxSession> };
	Tensor: new (
		type: 'float32' | 'int64' | 'int32' | 'bool',
		data: OnnxTensorData,
		dims: readonly number[]
	) => OnnxTensor;
}

/** CPU allocation supported by the downloaded Node.js binding. */
export interface OnnxSessionOptions {
	intraOpNumThreads: number;
	interOpNumThreads: number;
	executionMode: 'sequential';
}

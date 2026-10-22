/**
 * The ONNX encoder pool: one loaded session per encoder model (embeddings,
 * classifiers), opened lazily and freed when idle.
 *
 * An encoder is a tokenizer in front of an ONNX graph. Every encoder consumer
 * (the embedding service, the classifier service) needs the same four things
 * before it can run a batch: the model checked as installed, the runtime
 * loaded through the core loader, the graph opened, and the model's own
 * tokenizer. Doing that once here keeps two properties true for all of them:
 *
 *   - **A missing piece fails as itself.** A model that is not downloaded, a
 *     runtime that will not load, or a graph that will not open throws a
 *     classified {@link LocalModelError} naming it. Nothing here reaches for a
 *     different model.
 *   - **Memory is returned.** Encoders are small next to a GGUF (34 MB to a
 *     few hundred), so several may be resident at once, but each is freed after
 *     {@link DEFAULT_ENCODER_IDLE_UNLOAD_MS} without a call. Semantic search is
 *     bursty: an index pass, then nothing for an hour.
 *
 * Work on one model is serialized through a keyed queue (a load, the runs that
 * follow it, and an idle unload can never interleave); different models run
 * concurrently.
 */

import { availableParallelism } from 'os';
import { getLocalModel } from '../../shared/local-models/model-catalog';
import { modelsSettingsLocation } from '../../shared/local-models/settings-location';
import type { LocalEncoderGraph, LocalModelEntry } from '../../shared/local-models/types';
import { createKeyedWriteQueue } from '../../shared/keyedWriteQueue';
import { LocalModelError } from './errors';
import { isInstalled, modelFilePath } from './model-store';
import { loadOnnxWorkerRuntime } from './runtime/onnx-worker-session';
import type { OnnxModule, OnnxSession, OnnxTensor } from './runtime/onnx-types';
import { runtimeSetupLocation } from './runtime/runtime-consumers';
import { loadTokenizer, type LocalTokenizer, type TokenizedBatch } from './tokenizer';

/** The encoder kinds: the catalog kinds that carry a {@link LocalEncoderGraph}. */
export type EncoderKind = 'embedding' | 'classifier';

/** How long an encoder stays resident after its last call. */
export const DEFAULT_ENCODER_IDLE_UNLOAD_MS = 5 * 60_000;

/** An installed encoder model, located on disk. */
export interface InstalledEncoder {
	entry: LocalModelEntry;
	spec: LocalEncoderGraph;
	/** Absolute path of the ONNX graph. */
	modelPath: string;
	/** Absolute directory holding `tokenizer.json`. */
	tokenizerDir: string;
}

/** Everything a consumer needs to run one batch. */
export interface LoadedEncoder extends InstalledEncoder {
	session: OnnxSession;
	/** The runtime module, for building input tensors. */
	ort: OnnxModule;
	tokenizer: LocalTokenizer;
}

export interface OnnxEncoderPoolOptions {
	/** Idle time before a session is freed. 0 keeps sessions loaded forever. */
	idleUnloadMs?: number;
	/** Injected in tests; production goes through `native-loader.ts`. */
	loadRuntime?: (runtimeId: 'onnx', consumerId: string) => Promise<OnnxModule>;
	/** Injected in tests; production resolves an installed catalog model. */
	resolveModel?: (
		modelId: string,
		kind: EncoderKind,
		consumerId: string
	) => Promise<InstalledEncoder>;
	/** Injected in tests; production reads the model's `tokenizer.json`. */
	loadTokenizer?: (dir: string) => Promise<LocalTokenizer>;
}

const KIND_LABEL: Record<EncoderKind, string> = {
	embedding: 'embedding',
	classifier: 'text-classifier',
};

function encoderSpec(entry: LocalModelEntry, kind: EncoderKind): LocalEncoderGraph | undefined {
	if (entry.kind !== kind || entry.runtime !== 'onnx') return undefined;
	return kind === 'embedding' ? entry.embedding : entry.classifier;
}

/**
 * The installed files of a catalog encoder model, or a classified refusal.
 *
 * Checked on every load (not every call), with the store's cheap check
 * (manifest plus byte lengths), so a model deleted since the last run is named
 * as such instead of surfacing as an opaque ONNX Runtime open failure.
 */
export async function resolveInstalledEncoder(
	modelId: string,
	kind: EncoderKind,
	consumerId: string
): Promise<InstalledEncoder> {
	const entry = getLocalModel(modelId);
	const spec = entry ? encoderSpec(entry, kind) : undefined;
	if (!entry || !spec) {
		throw new LocalModelError(`"${modelId}" is not a local ${KIND_LABEL[kind]} model.`, {
			code: 'model-unsupported',
			recovery: `Choose ${kind === 'embedding' ? 'an' : 'a'} ${KIND_LABEL[kind]} model from the Local Models catalog.`,
			consumerId,
		});
	}
	if (!(await isInstalled(modelId))) {
		throw new LocalModelError(`${entry.displayName} is not downloaded.`, {
			code: 'model-not-installed',
			recovery: `Download it in ${runtimeSetupLocation('onnx')}.`,
			consumerId,
		});
	}
	return {
		entry,
		spec,
		modelPath: modelFilePath(modelId, spec.modelFile),
		tokenizerDir: modelFilePath(modelId, spec.tokenizerDir === '' ? '.' : spec.tokenizerDir),
	};
}

interface ResidentEncoder {
	encoder: LoadedEncoder;
	idleTimer: ReturnType<typeof setTimeout> | null;
	/** Bumped per call; an idle unload scheduled before the latest call does nothing. */
	useToken: number;
}

/**
 * Holds loaded encoder sessions, one per model, and runs work against them.
 *
 * Exported for tests; production code shares {@link getOnnxEncoderPool}.
 */
export class OnnxEncoderPool {
	private readonly idleUnloadMs: number;
	private readonly loadRuntime: NonNullable<OnnxEncoderPoolOptions['loadRuntime']>;
	private readonly resolveModel: NonNullable<OnnxEncoderPoolOptions['resolveModel']>;
	private readonly loadTokenizer: (dir: string) => Promise<LocalTokenizer>;
	private readonly queue = createKeyedWriteQueue();
	private readonly resident = new Map<string, ResidentEncoder>();

	constructor(options: OnnxEncoderPoolOptions = {}) {
		this.idleUnloadMs = options.idleUnloadMs ?? DEFAULT_ENCODER_IDLE_UNLOAD_MS;
		this.loadRuntime =
			options.loadRuntime ?? ((_id, consumerId) => loadOnnxWorkerRuntime(consumerId));
		this.resolveModel = options.resolveModel ?? resolveInstalledEncoder;
		this.loadTokenizer = options.loadTokenizer ?? loadTokenizer;
	}

	/** Ids of the models currently loaded. */
	get loadedModelIds(): string[] {
		return [...this.resident.keys()];
	}

	/**
	 * Run `work` against `modelId`'s session, loading it first if needed.
	 *
	 * `consumerId` names the caller in any refusal. Errors thrown by `work`
	 * pass through untouched: classifying a failed run is the consumer's job,
	 * since only it knows what it was asking the graph for.
	 */
	run<T>(
		modelId: string,
		kind: EncoderKind,
		consumerId: string,
		work: (encoder: LoadedEncoder) => Promise<T>
	): Promise<T> {
		return this.queue.enqueue(modelId, async () => {
			const resident = await this.ensureLoaded(modelId, kind, consumerId);
			resident.useToken++;
			this.clearIdleTimer(resident);
			try {
				return await work(resident.encoder);
			} finally {
				// From the end of the call, not its start: a long index pass must not
				// be unloaded the moment it finishes.
				this.scheduleIdleUnload(modelId, resident);
			}
		});
	}

	/** Free one model's session (or every session). Waits for in-flight work. */
	async unload(modelId?: string): Promise<void> {
		const ids = modelId === undefined ? [...this.resident.keys()] : [modelId];
		await Promise.all(
			ids.map((id) =>
				this.queue.enqueue(id, async () => {
					const resident = this.resident.get(id);
					if (!resident) return;
					this.clearIdleTimer(resident);
					await this.dispose(id);
				})
			)
		);
	}

	// -- Internals -----------------------------------------------------------

	private async ensureLoaded(
		modelId: string,
		kind: EncoderKind,
		consumerId: string
	): Promise<ResidentEncoder> {
		const existing = this.resident.get(modelId);
		if (existing) return existing;

		// Both throw classified errors of their own (model-unsupported,
		// model-not-installed, runtime-unavailable); they pass through untouched.
		const installed = await this.resolveModel(modelId, kind, consumerId);
		const ort = await this.loadRuntime('onnx', consumerId);

		let session: OnnxSession;
		let tokenizer: LocalTokenizer;
		try {
			// An external-weights graph (`.onnx_data`) is opened by a path relative
			// to the graph, so the graph is always opened from its install location.
			// Keep encoder pools from consuming every physical core. The worker
			// isolates native inference from main; this cap also leaves CPU for UI.
			session = await ort.InferenceSession.create(installed.modelPath, {
				intraOpNumThreads: Math.max(1, Math.min(2, Math.floor(availableParallelism() / 4))),
				interOpNumThreads: 1,
				executionMode: 'sequential',
			});
		} catch (error) {
			throw openFailure(installed.entry, consumerId, error);
		}
		try {
			tokenizer = await this.loadTokenizer(installed.tokenizerDir);
		} catch (error) {
			await safeRelease(session);
			throw openFailure(installed.entry, consumerId, error);
		}

		const resident: ResidentEncoder = {
			encoder: { ...installed, session, ort, tokenizer },
			idleTimer: null,
			useToken: 0,
		};
		this.resident.set(modelId, resident);
		return resident;
	}

	private scheduleIdleUnload(modelId: string, resident: ResidentEncoder): void {
		this.clearIdleTimer(resident);
		if (this.idleUnloadMs <= 0) return;
		const token = resident.useToken;
		resident.idleTimer = setTimeout(() => {
			resident.idleTimer = null;
			void this.queue.enqueue(modelId, async () => {
				if (this.resident.get(modelId) !== resident || resident.useToken !== token) return;
				await this.dispose(modelId);
			});
		}, this.idleUnloadMs);
		// The timer must never be the reason the app stays alive.
		resident.idleTimer.unref?.();
	}

	private clearIdleTimer(resident: ResidentEncoder): void {
		if (!resident.idleTimer) return;
		clearTimeout(resident.idleTimer);
		resident.idleTimer = null;
	}

	private async dispose(modelId: string): Promise<void> {
		const resident = this.resident.get(modelId);
		this.resident.delete(modelId);
		if (resident) await safeRelease(resident.encoder.session);
	}
}

/**
 * The input tensors a graph declares, built from a tokenized batch.
 *
 * Fed by NAME from `session.inputNames` rather than assumed: BERT exports take
 * `token_type_ids` and Gemma's does not, and ONNX Runtime rejects a feed the
 * graph does not declare. A graph asking for an input no encoder consumer can
 * build is refused by name rather than run with a guess.
 */
export function encoderFeeds(
	encoder: Pick<LoadedEncoder, 'session' | 'ort' | 'entry'>,
	tokens: TokenizedBatch,
	consumerId: string
): Record<string, OnnxTensor> {
	const dims = [tokens.batchSize, tokens.sequenceLength];
	const feeds: Record<string, OnnxTensor> = {};
	for (const name of encoder.session.inputNames) {
		const data = encoderInput(name, tokens);
		if (!data) {
			throw new LocalModelError(
				`${encoder.entry.displayName} expects an input "${name}" Maestro cannot provide.`,
				{
					code: 'model-unsupported',
					recovery: 'Choose a different model from the Local Models catalog.',
					consumerId,
				}
			);
		}
		feeds[name] = new encoder.ort.Tensor('int64', data, dims);
	}
	return feeds;
}

function encoderInput(name: string, tokens: TokenizedBatch): BigInt64Array | null {
	switch (name) {
		case 'input_ids':
			return tokens.inputIds;
		case 'attention_mask':
			return tokens.attentionMask;
		case 'token_type_ids':
			// A tokenizer without segment ids is single-segment: every position is 0.
			return tokens.tokenTypeIds ?? new BigInt64Array(tokens.inputIds.length);
		default:
			return null;
	}
}

/**
 * A loaded encoder failed on one request, or returned something its run spec
 * does not describe. Shared by every encoder consumer so the failure reads the
 * same whichever service ran the graph: the model's name, then what went wrong.
 */
export function encoderRunFailure(
	entry: Pick<LocalModelEntry, 'displayName'>,
	consumerId: string,
	detail: string,
	cause?: unknown
): LocalModelError {
	return new LocalModelError(`${entry.displayName} ${detail}`, {
		code: 'generation-failed',
		recovery: `Try again. If it keeps failing, verify the model in ${modelsSettingsLocation('library')}.`,
		consumerId,
		...(cause !== undefined ? { cause } : {}),
	});
}

function openFailure(entry: LocalModelEntry, consumerId: string, cause: unknown): LocalModelError {
	return new LocalModelError(`${entry.displayName} could not be opened.`, {
		code: 'generation-failed',
		recovery: `Verify or re-download it in ${runtimeSetupLocation('onnx')}.`,
		consumerId,
		cause,
	});
}

/** Teardown must not throw: it runs from idle timers and failure paths. */
async function safeRelease(session: OnnxSession): Promise<void> {
	try {
		await session.release?.();
	} catch {
		/* best-effort */
	}
}

let sharedPool: OnnxEncoderPool | null = null;

/** The app-wide pool every encoder consumer shares. */
export function getOnnxEncoderPool(): OnnxEncoderPool {
	sharedPool ??= new OnnxEncoderPool();
	return sharedPool;
}

/** Tests only: replace (or with null, forget) the shared pool. */
export function __setOnnxEncoderPool(pool: OnnxEncoderPool | null): void {
	sharedPool = pool;
}

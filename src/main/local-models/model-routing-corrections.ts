/**
 * The user's model routing corrections: the store.
 *
 *   userData/model-routing-corrections.json     { version, corrections: [...] }
 *
 * A correction is the user saying a prompt needed a different tier than the
 * router picked. The embedding router (`model-router.ts`) reads the list beside
 * its shipped examples, so a correction votes on the next prompt like it. The
 * file is machine-local, like every other Local Models store.
 *
 * What a correction may hold, how the list is capped, and how a correction for
 * a known text replaces the earlier one are pure rules in
 * `src/shared/local-models/model-routing.ts`. This module only reads and writes.
 */

import * as fs from 'fs/promises';
import * as path from 'path';

import { parseJsonWithBom } from '../../shared/jsonUtils';
import {
	MODEL_ROUTING_CORRECTIONS_FILE,
	normalizeModelRoutingText,
	parseModelRoutingCorrections,
	serializeModelRoutingCorrections,
	withModelRoutingCorrection,
	type ModelRoutingCorrection,
} from '../../shared/local-models/model-routing';
import {
	TIER_LEVELS,
	asTierLevel,
	type EffortLevel,
	type ModelTier,
} from '../../shared/tierLevels';
import { corruptStorePath } from '../stores/corrupt-store-recovery';
import { atomicWriteJson, createKeyedWriteQueue } from '../utils/atomic-json-store';
import { logger } from '../utils/logger';
import { localModelsDataDir } from './paths';

const LOG_CONTEXT = 'LocalModels';

/** What the user corrects: the prompt that was routed, and what it needed. */
export interface ModelRoutingCorrectionInput {
	text: string;
	tier: ModelTier;
	/** Leave out to correct the tier only. */
	effort?: EffortLevel;
}

/**
 * What recording a correction did, or why it was refused. A refusal is
 * something the user can act on, so it is a result, not a throw.
 */
export type ModelRoutingCorrectionResult =
	| {
			ok: true;
			correction: ModelRoutingCorrection;
			/** True when an earlier correction for the same text was replaced. */
			replaced: boolean;
			/** How many corrections are kept now. */
			total: number;
	  }
	| { ok: false; message: string };

export class ModelRoutingCorrectionStore {
	private corrections: ModelRoutingCorrection[] = [];
	private hydration: Promise<void> | null = null;
	private readonly writes = createKeyedWriteQueue();

	constructor(private readonly filePath: string) {}

	/** Every correction, oldest first. A memory read after the first call. */
	async list(): Promise<readonly ModelRoutingCorrection[]> {
		await this.hydrate();
		return this.corrections;
	}

	/**
	 * Keep one correction. The text is stored as the router embeds it (secrets
	 * replaced, trimmed, cut), so the next time that prompt is routed the
	 * correction is its exact match.
	 */
	async record(
		input: ModelRoutingCorrectionInput,
		now: number = Date.now()
	): Promise<ModelRoutingCorrectionResult> {
		const text = normalizeModelRoutingText(input.text);
		if (!text) return { ok: false, message: 'There is no prompt to record a correction for.' };
		const correction: ModelRoutingCorrection = {
			text,
			tier: input.tier,
			...(input.effort ? { effort: input.effort } : {}),
			recordedAt: now,
		};
		await this.hydrate();
		// Read, change and write under the queue, so two corrections recorded at
		// once cannot both start from the same list and lose one.
		return this.writes.enqueue(this.filePath, async () => {
			const next = withModelRoutingCorrection(this.corrections, correction);
			await this.write(next.corrections);
			return {
				ok: true as const,
				correction,
				replaced: next.replaced,
				total: next.corrections.length,
			};
		});
	}

	/** Forget every correction. Returns how many there were. */
	async clear(): Promise<number> {
		await this.hydrate();
		return this.writes.enqueue(this.filePath, async () => {
			const cleared = this.corrections.length;
			if (cleared > 0) await this.write([]);
			return cleared;
		});
	}

	private async write(next: ModelRoutingCorrection[]): Promise<void> {
		await fs.mkdir(path.dirname(this.filePath), { recursive: true });
		await atomicWriteJson(this.filePath, serializeModelRoutingCorrections(next));
		this.corrections = next;
	}

	private hydrate(): Promise<void> {
		if (!this.hydration) {
			// A failed read is not remembered: the next call reads again.
			this.hydration = this.read().catch((error) => {
				this.hydration = null;
				throw error;
			});
		}
		return this.hydration;
	}

	/**
	 * Read the file once. A file that is not JSON is moved aside, never
	 * overwritten, so what it held can still be recovered. A record that fails
	 * its checks is dropped and counted.
	 */
	private async read(): Promise<void> {
		let text: string;
		try {
			text = await fs.readFile(this.filePath, 'utf-8');
		} catch (error) {
			// No file is the state of a machine where nothing was ever corrected.
			if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return;
			throw error;
		}
		let raw: unknown;
		try {
			raw = parseJsonWithBom(text);
		} catch {
			const sidecar = corruptStorePath(this.filePath);
			await fs.rename(this.filePath, sidecar);
			logger.warn(
				`${MODEL_ROUTING_CORRECTIONS_FILE} was not JSON. It was moved to ${path.basename(sidecar)}, and model routing starts with no corrections.`,
				LOG_CONTEXT
			);
			return;
		}
		const parsed = parseModelRoutingCorrections(raw);
		if (parsed.dropped > 0) {
			logger.warn(
				`Ignored ${parsed.dropped} unusable record(s) in ${MODEL_ROUTING_CORRECTIONS_FILE}`,
				LOG_CONTEXT
			);
		}
		this.corrections = parsed.corrections;
	}
}

let instance: ModelRoutingCorrectionStore | null = null;

/** The app's one corrections store, over `userData/model-routing-corrections.json`. */
export function getModelRoutingCorrectionStore(): ModelRoutingCorrectionStore {
	if (!instance) {
		instance = new ModelRoutingCorrectionStore(
			path.join(localModelsDataDir(), MODEL_ROUTING_CORRECTIONS_FILE)
		);
	}
	return instance;
}

/**
 * Record a correction that crossed a process boundary (`maestro-cli s1 route
 * --correct <tier>`, the WS message `model_route_correct`). A request that
 * cannot be read is the caller's bug and rejects with what is wrong with it; a
 * correction the store refuses (a blank prompt) comes back as its result.
 */
export async function recordModelRoutingCorrectionRequest(
	request: unknown
): Promise<ModelRoutingCorrectionResult> {
	if (typeof request !== 'object' || request === null || Array.isArray(request)) {
		throw new Error('A routing correction is an object with a prompt and a tier.');
	}
	const raw = request as Record<string, unknown>;
	if (typeof raw.prompt !== 'string') throw new Error("A routing correction's prompt is text.");
	const tier = asTierLevel(raw.tier);
	if (!tier) {
		throw new Error(`A routing correction's tier is one of ${TIER_LEVELS.join(', ')}.`);
	}
	const effort = raw.effort === undefined ? undefined : asTierLevel(raw.effort);
	if (raw.effort !== undefined && !effort) {
		throw new Error(`A routing correction's effort is one of ${TIER_LEVELS.join(', ')}.`);
	}
	return getModelRoutingCorrectionStore().record({
		text: raw.prompt,
		tier,
		...(effort ? { effort } : {}),
	});
}

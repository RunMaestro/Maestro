/**
 * Local Conductor Brain on Qwen3 1.7B, through node-llama-cpp.
 *
 * **The context stays loaded between turns.** Loading a 1.1 GB GGUF and building
 * a context takes seconds; a routing decision takes a few hundred milliseconds.
 * If the model were loaded per turn, every utterance would pay the load, and the
 * feature would be unusable. So the model, the context, and the grammar are built
 * once and held.
 *
 * **And it unloads when nobody is talking.** A gigabyte of resident RAM for a
 * feature the user finished using twenty minutes ago is not acceptable either, so
 * an idle timer frees everything after {@link DEFAULT_IDLE_UNLOAD_MS}. The next
 * utterance pays the load again, once. Both halves of that trade are deliberate:
 * warm within a conversation, cold between them.
 *
 * **Routing is grammar-constrained.** llama.cpp can be handed a GBNF grammar
 * built from the shared `RouteDecision` JSON Schema, which makes the model
 * structurally incapable of emitting a malformed decision. It is still run
 * through `parseRouteDecision`, because a grammar guarantees a well-formed
 * `sessionId` and not a real one, and the roster is the only thing that knows the
 * difference.
 */

import { QWEN3_1_7B_ID } from '../../../../shared/acappella/model-catalog';
import { LOCAL_BRAIN_PROVIDER_ID } from '../../../../shared/acappella/provider-catalog';
import { VoiceProviderError } from '../../../../shared/acappella/provider-errors';
import type {
	BrainProvider,
	VoiceConverseContext,
	VoiceRouteContext,
} from '../../../../shared/acappella/providers';
import type { RouteDecision } from '../../../../shared/acappella/route-decision';
import { ROUTE_DECISION_JSON_SCHEMA } from '../../../../shared/acappella/route-decision';
import { modelFilePath } from '../../models/model-store';
import {
	buildConverseUserPrompt,
	buildRouteUserPrompt,
	CONVERSE_SYSTEM_PROMPT,
	limitSpokenReply,
	parseRouteDecision,
	routeSystemPrompt,
} from '../brain-prompt';
import { loadLocalRuntime } from './runtime';

/** The catalog file this provider loads. */
const MODEL_FILE = 'Qwen3-1.7B-Q4_K_M.gguf';

/**
 * How long the model stays resident after the last turn.
 *
 * Five minutes is longer than a pause in a conversation and shorter than a
 * coffee break, which is the line this timer is trying to draw.
 */
export const DEFAULT_IDLE_UNLOAD_MS = 5 * 60_000;

/** Small context: a roster and one utterance, never a codebase. */
const CONTEXT_SIZE = 4096;

const ROUTE_MAX_TOKENS = 400;
const CONVERSE_MAX_TOKENS = 300;

/** The node-llama-cpp surface this provider uses, structurally. */
interface LlamaGrammar {
	readonly _grammar?: unknown;
}

interface LlamaChatSessionInstance {
	prompt(text: string, options?: Record<string, unknown>): Promise<string>;
	dispose?(): Promise<void> | void;
}

interface LlamaContextInstance {
	getSequence(): unknown;
	dispose?(): Promise<void> | void;
}

interface LlamaModelInstance {
	createContext(options?: Record<string, unknown>): Promise<LlamaContextInstance>;
	dispose?(): Promise<void> | void;
}

interface LlamaInstance {
	loadModel(options: { modelPath: string }): Promise<LlamaModelInstance>;
	createGrammarForJsonSchema(schema: unknown): Promise<LlamaGrammar>;
}

interface LlamaModule {
	getLlama(options?: Record<string, unknown>): Promise<LlamaInstance>;
	LlamaChatSession: new (options: Record<string, unknown>) => LlamaChatSessionInstance;
}

/** Everything the loaded model holds, so unloading is one object to drop. */
interface LoadedBrain {
	llama: LlamaInstance;
	model: LlamaModelInstance;
	context: LlamaContextInstance;
	ChatSession: LlamaModule['LlamaChatSession'];
	routeGrammar: LlamaGrammar | null;
}

export interface LlamaBrainOptions {
	modelPath?: string;
	/** Idle time before the model is freed. 0 keeps it loaded forever. */
	idleUnloadMs?: number;
	/** Injected in tests; production goes through `native-loader.ts`. */
	loadRuntime?: typeof loadLocalRuntime;
}

export class LlamaBrainProvider implements BrainProvider {
	readonly id = LOCAL_BRAIN_PROVIDER_ID;
	readonly label = 'Qwen3 1.7B (local)';
	readonly tier = 'local' as const;

	private readonly modelPathOverride?: string;
	private readonly idleUnloadMs: number;
	private readonly loadRuntime: typeof loadLocalRuntime;

	private loaded: LoadedBrain | null = null;
	/** In-flight load, so two turns racing do not each open the model. */
	private loading: Promise<LoadedBrain> | null = null;
	private idleTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(options: LlamaBrainOptions = {}) {
		this.modelPathOverride = options.modelPath;
		this.idleUnloadMs = options.idleUnloadMs ?? DEFAULT_IDLE_UNLOAD_MS;
		this.loadRuntime = options.loadRuntime ?? loadLocalRuntime;
	}

	async route(input: string, context: VoiceRouteContext): Promise<RouteDecision> {
		const brain = await this.ensureLoaded();
		const raw = await this.prompt(
			brain,
			routeSystemPrompt(),
			buildRouteUserPrompt(input, context),
			ROUTE_MAX_TOKENS,
			brain.routeGrammar
		);
		return parseRouteDecision(raw, context, input);
	}

	async converse(agentText: string, context: VoiceConverseContext): Promise<string> {
		const brain = await this.ensureLoaded();
		const raw = await this.prompt(
			brain,
			CONVERSE_SYSTEM_PROMPT,
			buildConverseUserPrompt(agentText, context),
			CONVERSE_MAX_TOKENS,
			null
		);
		return limitSpokenReply(raw, context.maxSentences);
	}

	/** Free the model now. Called on pipeline teardown and by the idle timer. */
	async unload(): Promise<void> {
		this.clearIdleTimer();
		const brain = this.loaded;
		this.loaded = null;
		if (!brain) return;

		// Innermost first: disposing a model out from under a live context is how
		// llama.cpp gets a use-after-free instead of a clean shutdown.
		await safeDispose(() => brain.context.dispose?.());
		await safeDispose(() => brain.model.dispose?.());
	}

	/** True while the model is resident. Read by the metrics panel and by tests. */
	get isLoaded(): boolean {
		return this.loaded !== null;
	}

	// -- Internals -----------------------------------------------------------

	private async ensureLoaded(): Promise<LoadedBrain> {
		this.clearIdleTimer();
		if (this.loaded) return this.loaded;

		this.loading ??= this.load();
		try {
			this.loaded = await this.loading;
			return this.loaded;
		} finally {
			this.loading = null;
		}
	}

	private async load(): Promise<LoadedBrain> {
		const module = await this.loadRuntime<LlamaModule>('llama', this.id);
		const modelPath = this.modelPathOverride ?? modelFilePath(QWEN3_1_7B_ID, MODEL_FILE);

		try {
			const llama = await module.getLlama();
			const model = await llama.loadModel({ modelPath });
			const context = await model.createContext({ contextSize: CONTEXT_SIZE });
			// Built once, reused per turn: compiling a grammar is not free and the
			// schema never changes.
			const routeGrammar = await llama
				.createGrammarForJsonSchema(ROUTE_DECISION_JSON_SCHEMA)
				// A build of llama.cpp without JSON-schema grammars still routes; it
				// just relies on the prompt and the parser instead of being unable to
				// emit bad JSON. Losing the guarantee is worth more than losing the slot.
				.catch(() => null);

			return { llama, model, context, ChatSession: module.LlamaChatSession, routeGrammar };
		} catch (error) {
			throw new VoiceProviderError(
				'The local Conductor Brain model could not be opened. Re-verify it in Settings > Plugins > A Cappella > Models.',
				{ kind: 'unavailable', providerId: this.id, cause: error }
			);
		}
	}

	/**
	 * One turn against the loaded context.
	 *
	 * A fresh chat session per call, on the same context: routing has no memory
	 * between utterances (the roster and the recent utterances are in the prompt),
	 * and a session that accumulated history would grow until it evicted the
	 * system prompt.
	 */
	private async prompt(
		brain: LoadedBrain,
		systemPrompt: string,
		userPrompt: string,
		maxTokens: number,
		grammar: LlamaGrammar | null
	): Promise<string> {
		const session = new brain.ChatSession({
			contextSequence: brain.context.getSequence(),
			systemPrompt,
		});

		try {
			return await session.prompt(userPrompt, {
				// Deterministic, for the same reason the hosted Brains are: a misroute
				// that cannot be reproduced cannot be fixed.
				temperature: 0,
				maxTokens,
				...(grammar ? { grammar } : {}),
			});
		} catch (error) {
			throw new VoiceProviderError(
				`The local Conductor Brain failed on this turn: ${(error as Error).message}`,
				{ kind: 'unavailable', providerId: this.id, cause: error }
			);
		} finally {
			await safeDispose(() => session.dispose?.());
			// Restarted after every turn, not before: the clock should run from the
			// last thing the user said, not from the start of a slow inference.
			this.scheduleIdleUnload();
		}
	}

	private scheduleIdleUnload(): void {
		this.clearIdleTimer();
		if (this.idleUnloadMs <= 0) return;
		this.idleTimer = setTimeout(() => {
			this.idleTimer = null;
			void this.unload();
		}, this.idleUnloadMs);
		// The timer must never be the reason the app stays alive.
		this.idleTimer.unref?.();
	}

	private clearIdleTimer(): void {
		if (!this.idleTimer) return;
		clearTimeout(this.idleTimer);
		this.idleTimer = null;
	}
}

/** Sugar matching the rest of A Cappella's factories. */
export function createLlamaBrainProvider(options: LlamaBrainOptions = {}): LlamaBrainProvider {
	return new LlamaBrainProvider(options);
}

/** Teardown must not throw: it runs from `finally` blocks and from disposal. */
async function safeDispose(dispose: () => Promise<void> | void | undefined): Promise<void> {
	try {
		await dispose();
	} catch {
		/* best-effort */
	}
}

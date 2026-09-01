/**
 * Per-model token pricing for AI cost estimation.
 *
 * Single source of truth for token pricing across providers, shared by the
 * Electron main process and the standalone CLI (no Electron imports here, so the
 * CLI can bundle it directly instead of duplicating a hardcoded table).
 *
 * Pricing is keyed by canonical model ID. Cache prices follow Anthropic's standard
 * multipliers relative to the base input price (read = 0.1x, write/creation = 1.25x),
 * so a tier only needs its input/output rates. Unknown models fall back to a family
 * match (gpt/fable/opus/sonnet/haiku) and finally to the default Sonnet-tier rates,
 * so cost never silently breaks when a new model ID ships.
 *
 * The two providers also disagree about what `input_tokens` means: Anthropic
 * reports cache reads BESIDE it, OpenAI reports them INSIDE it. That is a pricing
 * input, not a display detail, so it rides on the tier as
 * `CACHE_READ_SUBSET_OF_INPUT`.
 */

export const TOKENS_PER_MILLION = 1_000_000;

/** Per-million-token prices for a single model tier. */
export interface PricingConfig {
	INPUT_PER_MILLION: number;
	OUTPUT_PER_MILLION: number;
	CACHE_READ_PER_MILLION: number;
	CACHE_CREATION_PER_MILLION: number;
	/**
	 * True when the provider reports cached input tokens as a SUBSET of
	 * `input_tokens` rather than alongside it. OpenAI does; Anthropic does not.
	 * Without this the cached half of a Codex turn is billed at the full input
	 * rate AND again as a cache read, which is backwards - a cache hit is the
	 * cheap case. See `calculateWithPricing`.
	 */
	CACHE_READ_SUBSET_OF_INPUT?: boolean;
}

/** Token counts for a cost calculation. */
export interface TokenCounts {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens?: number;
	cacheCreationTokens?: number;
}

// Anthropic cache pricing relative to base input price.
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_CREATION_MULTIPLIER = 1.25;

/** Round to 6 decimals to avoid floating-point noise (e.g. 3 * 0.1 = 0.30000000000000004). */
function round6(n: number): number {
	return Math.round(n * 1e6) / 1e6;
}

/** Build a full PricingConfig from base input/output rates, deriving cache prices. */
function tier(inputPerMillion: number, outputPerMillion: number): PricingConfig {
	return {
		INPUT_PER_MILLION: inputPerMillion,
		OUTPUT_PER_MILLION: outputPerMillion,
		CACHE_READ_PER_MILLION: round6(inputPerMillion * CACHE_READ_MULTIPLIER),
		CACHE_CREATION_PER_MILLION: round6(inputPerMillion * CACHE_CREATION_MULTIPLIER),
	};
}

// Family-tier prices, reused for exact entries and the substring fallback.
const FABLE_PRICING = tier(10, 50);
const OPUS_PRICING = tier(5, 25);
const OPUS_LEGACY_PRICING = tier(15, 75); // Opus 4.1 / 4.0 / 3
const SONNET_PRICING = tier(3, 15);
const HAIKU_PRICING = tier(1, 5);
const HAIKU_35_PRICING = tier(0.8, 4);
const HAIKU_3_PRICING = tier(0.25, 1.25);

/**
 * Build an OpenAI-shaped PricingConfig. Cached input is billed at 0.1x the input
 * rate (matching OpenAI's published discount), there is no separate cache-write
 * charge, and cached tokens are a subset of the reported input tokens.
 */
function openAiTier(inputPerMillion: number, outputPerMillion: number): PricingConfig {
	return {
		INPUT_PER_MILLION: inputPerMillion,
		OUTPUT_PER_MILLION: outputPerMillion,
		CACHE_READ_PER_MILLION: round6(inputPerMillion * CACHE_READ_MULTIPLIER),
		CACHE_CREATION_PER_MILLION: 0,
		CACHE_READ_SUBSET_OF_INPUT: true,
	};
}

// GPT-5 family. Codex model slugs are discovered at runtime and version faster
// than any table can track (`gpt-5.4`, `gpt-5.6-sol`, ...), so the exact entries
// below are anchors and everything else in the family resolves by size class
// (mini / nano / frontier) rather than by exact slug. Better a same-family rate
// than the Anthropic Sonnet default these used to silently fall through to.
const GPT5_PRICING = openAiTier(1.25, 10);
const GPT5_MINI_PRICING = openAiTier(0.25, 2);
const GPT5_NANO_PRICING = openAiTier(0.05, 0.4);

/**
 * Default pricing for unknown models. Matches the historical flat Sonnet-tier
 * constant, so behavior is unchanged when a model can't be resolved.
 */
export const DEFAULT_MODEL_PRICING: PricingConfig = SONNET_PRICING;

/** Exact per-model pricing, keyed by normalized (lowercase, suffix-stripped) model ID. */
export const MODEL_PRICING: Record<string, PricingConfig> = {
	// Fable / Mythos family
	'claude-fable-5': FABLE_PRICING,
	'claude-mythos-5': FABLE_PRICING,
	'claude-mythos-preview': FABLE_PRICING,
	// Opus current tier ($5 / $25)
	'claude-opus-4-8': OPUS_PRICING,
	'claude-opus-4-7': OPUS_PRICING,
	'claude-opus-4-6': OPUS_PRICING,
	'claude-opus-4-5': OPUS_PRICING,
	// Opus legacy tier ($15 / $75)
	'claude-opus-4-1': OPUS_LEGACY_PRICING,
	'claude-opus-4-0': OPUS_LEGACY_PRICING,
	'claude-3-opus': OPUS_LEGACY_PRICING,
	// Sonnet family
	'claude-sonnet-4-6': SONNET_PRICING,
	'claude-sonnet-4-5': SONNET_PRICING,
	'claude-sonnet-4-0': SONNET_PRICING,
	// Haiku family
	'claude-haiku-4-5': HAIKU_PRICING,
	'claude-3-5-haiku': HAIKU_35_PRICING,
	'claude-3-haiku': HAIKU_3_PRICING,
	// OpenAI (Codex CLI) anchors; the family fallback in `resolveModelPricing`
	// covers the point releases.
	'gpt-5': GPT5_PRICING,
	'gpt-5-codex': GPT5_PRICING,
	'gpt-5-mini': GPT5_MINI_PRICING,
	'gpt-5-nano': GPT5_NANO_PRICING,
};

/**
 * Normalize a raw model string to a canonical lookup key.
 * Strips the `[1m]` extended-context marker and a trailing date snapshot
 * (e.g. `-20251001`), and lowercases.
 */
export function normalizeModelId(modelId: string): string {
	return modelId
		.toLowerCase()
		.replace(/\[1m\]/g, '')
		.replace(/-\d{8}$/, '')
		.trim();
}

/**
 * Resolve a model string to its pricing. Tries an exact match, then a family
 * substring match, then the default tier.
 */
export function resolveModelPricing(modelId?: string | null): PricingConfig {
	if (!modelId) return DEFAULT_MODEL_PRICING;
	const normalized = normalizeModelId(modelId);
	const exact = MODEL_PRICING[normalized];
	if (exact) return exact;
	// OpenAI first: a Codex slug never contains an Anthropic family word, and
	// leaving it to fall through priced GPT tokens at Anthropic Sonnet rates.
	// Deliberately scoped to the GPT-5 family and codex slugs - the models Codex
	// actually ships. Older OpenAI lines still fall through to the default rather
	// than being priced off a family they don't belong to.
	if (normalized.startsWith('gpt-5') || normalized.includes('codex')) {
		if (normalized.includes('nano')) return GPT5_NANO_PRICING;
		if (normalized.includes('mini')) return GPT5_MINI_PRICING;
		return GPT5_PRICING;
	}
	if (normalized.includes('fable') || normalized.includes('mythos')) return FABLE_PRICING;
	if (normalized.includes('haiku')) return HAIKU_PRICING;
	if (normalized.includes('opus')) return OPUS_PRICING;
	if (normalized.includes('sonnet')) return SONNET_PRICING;
	return DEFAULT_MODEL_PRICING;
}

/** Calculate cost (USD) for token counts against an explicit pricing config. */
export function calculateWithPricing(
	tokens: TokenCounts,
	pricing: PricingConfig = DEFAULT_MODEL_PRICING
): number {
	const { inputTokens, outputTokens, cacheReadTokens = 0, cacheCreationTokens = 0 } = tokens;
	// When the provider counts cached tokens inside `input_tokens`, only the
	// uncached remainder is billed at the input rate.
	const billableInput = pricing.CACHE_READ_SUBSET_OF_INPUT
		? Math.max(0, inputTokens - cacheReadTokens)
		: inputTokens;
	return (
		(billableInput / TOKENS_PER_MILLION) * pricing.INPUT_PER_MILLION +
		(outputTokens / TOKENS_PER_MILLION) * pricing.OUTPUT_PER_MILLION +
		(cacheReadTokens / TOKENS_PER_MILLION) * pricing.CACHE_READ_PER_MILLION +
		(cacheCreationTokens / TOKENS_PER_MILLION) * pricing.CACHE_CREATION_PER_MILLION
	);
}

/** Calculate cost (USD) for token counts using the pricing for a given model. */
export function calculateModelCost(tokens: TokenCounts, modelId?: string | null): number {
	return calculateWithPricing(tokens, resolveModelPricing(modelId));
}

/** Grand-total token counts plus a per-model-accurate cost for a Claude session. */
export interface ClaudeUsageBreakdown {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
	costUsd: number;
}

interface TokenBucket {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
}

function emptyBucket(): TokenBucket {
	return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
}

function toInt(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Parse a Claude Code session JSONL string into grand-total token counts and a
 * cost that prices each model's tokens separately (sessions can mix models, e.g.
 * a cheap model for a sub-task alongside the main one).
 *
 * Only lines containing a `"usage"` object are JSON-parsed, keeping this close to
 * the cost of the previous whole-file regex scan while recovering the model ID
 * that lives on the same assistant message line.
 */
export function computeClaudeUsageCost(content: string): ClaudeUsageBreakdown {
	const totals = emptyBucket();
	const byModel = new Map<string, TokenBucket>();

	for (const line of content.split('\n')) {
		if (line.indexOf('"usage"') === -1) continue;
		let entry: {
			model?: unknown;
			usage?: Record<string, unknown>;
			message?: { model?: unknown; usage?: Record<string, unknown> };
		};
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		// Real Claude Code files nest usage/model under `message`; tolerate a
		// top-level `usage`/`model` too so any variant is counted.
		const usage = entry?.message?.usage ?? entry?.usage;
		if (!usage || typeof usage !== 'object') continue;

		const input = toInt(usage.input_tokens);
		const output = toInt(usage.output_tokens);
		const cacheRead = toInt(usage.cache_read_input_tokens);
		const cacheCreation = toInt(usage.cache_creation_input_tokens);
		if (input === 0 && output === 0 && cacheRead === 0 && cacheCreation === 0) continue;

		totals.inputTokens += input;
		totals.outputTokens += output;
		totals.cacheReadTokens += cacheRead;
		totals.cacheCreationTokens += cacheCreation;

		const rawModel = entry.message?.model ?? entry.model;
		const model = typeof rawModel === 'string' ? rawModel : '';
		let bucket = byModel.get(model);
		if (!bucket) {
			bucket = emptyBucket();
			byModel.set(model, bucket);
		}
		bucket.inputTokens += input;
		bucket.outputTokens += output;
		bucket.cacheReadTokens += cacheRead;
		bucket.cacheCreationTokens += cacheCreation;
	}

	let costUsd = 0;
	for (const [model, bucket] of byModel) {
		costUsd += calculateModelCost(bucket, model || undefined);
	}

	return {
		inputTokens: totals.inputTokens,
		outputTokens: totals.outputTokens,
		cacheReadTokens: totals.cacheReadTokens,
		cacheCreationTokens: totals.cacheCreationTokens,
		costUsd,
	};
}

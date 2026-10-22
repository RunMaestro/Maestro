// Token spend of one turn's main thread.
//
// claude writes one transcript row per content block, and every row of a
// message repeats that message's usage (measured: 75 of 105 messages in one
// session had several rows). Summing rows counted a message once per block, so
// a reply with thinking, text, and a tool call reported three times its real
// spend. Usage is kept per message id instead, last row wins, which is also
// what `claude -p` sums: one entry per API call.

import { calculateModelCost } from '../shared/modelPricing';
import { withContextWindow, type ClaudeModelCost } from '../shared/claudeCostTracker';

export interface AggregateUsage {
	input_tokens: number;
	output_tokens: number;
	cache_creation_input_tokens: number;
	cache_read_input_tokens: number;
}

interface MessageUsage {
	model: string;
	usage: AggregateUsage;
}

function count(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function emptyUsage(): AggregateUsage {
	return {
		input_tokens: 0,
		output_tokens: 0,
		cache_creation_input_tokens: 0,
		cache_read_input_tokens: 0,
	};
}

export class TurnUsage {
	private readonly messages = new Map<string, MessageUsage>();
	private anonymous = 0;

	/** Record an assistant message's usage. Rows of the same message replace each other. */
	note(message: unknown): void {
		if (!message || typeof message !== 'object') return;
		const m = message as Record<string, unknown>;
		const raw = m.usage;
		if (!raw || typeof raw !== 'object') return;
		const u = raw as Record<string, unknown>;
		const id = typeof m.id === 'string' && m.id ? m.id : `anonymous-${this.anonymous++}`;
		this.messages.set(id, {
			model: typeof m.model === 'string' ? m.model : '',
			usage: {
				input_tokens: count(u.input_tokens),
				output_tokens: count(u.output_tokens),
				cache_creation_input_tokens: count(u.cache_creation_input_tokens),
				cache_read_input_tokens: count(u.cache_read_input_tokens),
			},
		});
	}

	/** The turn's summed usage, the result envelope's `usage`. */
	totals(): AggregateUsage {
		const total = emptyUsage();
		for (const { usage } of this.messages.values()) {
			total.input_tokens += usage.input_tokens;
			total.output_tokens += usage.output_tokens;
			total.cache_creation_input_tokens += usage.cache_creation_input_tokens;
			total.cache_read_input_tokens += usage.cache_read_input_tokens;
		}
		return total;
	}

	/**
	 * `modelUsage` priced from Maestro's rate table. A fallback for when claude
	 * wrote no cost-state row (it was killed rather than quit): it covers this
	 * turn's main thread only, where claude's own tracker covers the session.
	 */
	estimatedModelUsage(): Record<string, ClaudeModelCost> {
		const byModel: Record<string, ClaudeModelCost> = {};
		for (const { model, usage } of this.messages.values()) {
			if (!model) continue;
			const entry = (byModel[model] ??= {
				inputTokens: 0,
				outputTokens: 0,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 0,
				webSearchRequests: 0,
				costUSD: 0,
			});
			entry.inputTokens += usage.input_tokens;
			entry.outputTokens += usage.output_tokens;
			entry.cacheReadInputTokens += usage.cache_read_input_tokens;
			entry.cacheCreationInputTokens += usage.cache_creation_input_tokens;
		}
		for (const [model, entry] of Object.entries(byModel)) {
			entry.costUSD = calculateModelCost(
				{
					inputTokens: entry.inputTokens,
					outputTokens: entry.outputTokens,
					cacheReadTokens: entry.cacheReadInputTokens,
					cacheCreationTokens: entry.cacheCreationInputTokens,
				},
				model
			);
			byModel[model] = withContextWindow(model, entry);
		}
		return byModel;
	}
}

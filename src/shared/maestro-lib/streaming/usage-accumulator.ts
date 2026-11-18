/**
 * Usage delta accumulation - maestro-lib Part Two.
 *
 * Ports `normalizeUsageToDelta` (`StdoutHandler.ts:39-132`) into a
 * standalone, instance-scoped primitive so every call site (not just
 * desktop) can delta-normalize cumulative usage reporting the same way.
 * Behavior is a faithful port, not a redesign: same monotonic-delta
 * detection, same cumulative-flag latching once a stream is found to be
 * non-cumulative, same conditional `absoluteUsage` re-attachment.
 *
 * Claude Code and Codex both report CUMULATIVE session totals rather than
 * per-turn values. Used directly, context occupancy would exceed 100% after
 * a few turns. This class detects cumulative reporting (values only ever
 * increase) and converts it to per-turn deltas; a provider whose values
 * don't increase monotonically is assumed to already report per-turn and is
 * passed through unmodified from then on.
 *
 * Legacy normalize() scoping is deliberately left to the caller: one
 * instance per PROCESS reproduces today's desktop behavior
 * exactly (`managedProcess.lastUsageTotals`'s lifetime is the process's).
 * Re-scoping an instance to span a resume boundary (one process per turn,
 * one accumulator per session) is Open Question 5 in
 * `Plans/maestro-lib-turn-contract.md` and needs checking against every
 * provider's first-usage-event shape before it's safe - this class does not
 * make that decision. The opt-in accumulate() path instead owns ONE turn
 * capture, with explicit process baselines and scoped accounting metadata.
 */

import { canonicalJson } from '../../canonicalJson';
import {
	addUsageStats,
	mergeUsageCost,
	replaceUsageStats,
	subtractUsageStats,
	usageCostUsd,
} from './usage-totals';
import type { UsageAccounting, UsageStats } from '../../types';

interface UsageTotals {
	inputTokens: number;
	outputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	reasoningTokens: number;
}

export interface UsageAccumulatorOptions {
	/**
	 * Whether this provider's delta-normalized totals should also be
	 * re-attached as `absoluteUsage` (real context-window occupancy) -
	 * true for combined-context providers (today: Codex only).
	 *
	 * Per the turn contract §3: the canonical source for this is the
	 * `usesCombinedContextWindow` capability flag in
	 * `src/shared/maestro-lib/providers/capabilities.ts`, not the separate
	 * `COMBINED_CONTEXT_AGENTS` static set in `src/shared/agentConstants.ts`
	 * - that module's own comment already says the flag is canonical and
	 * the set exists only "for cross-process use." Pass the resolved
	 * capability value here; this class does not read either source itself.
	 */
	attachesAbsoluteUsage: boolean;
	/** Scoped accumulation owns ONE capture/turn; missing IDs never identify another turn. */
	identity?: Pick<
		UsageAccounting,
		'route' | 'scopeId' | 'providerSessionId' | 'processGeneration' | 'turnId' | 'requestId'
	>;
	/**
	 * Explicit normalized snapshot taken before dispatch, under exclusive turn ownership.
	 * Requires route, opaque account/host scopeId, native session and process generation.
	 * Supply a proven zero for a new process, never synthesize it from the first report.
	 */
	processSessionBaseline?: UsageStats;
}

export class UsageAccumulator {
	private _lastTotals: UsageTotals | undefined;
	private _isCumulative: boolean | undefined;
	private readonly attachesAbsoluteUsage: boolean;
	private readonly scoped = new Map<string, UsageStats>();
	private readonly snapshots = new Map<string, string>();
	private readonly coveredResponses = new Map<string, UsageStats>();
	private readonly contributions = new Map<string, UsageStats>();
	private readonly identity: NonNullable<UsageAccumulatorOptions['identity']>;
	private readonly processBaseline: UsageStats | undefined;
	private processSnapshot: UsageStats | undefined;
	private snapshot: UsageStats | undefined;
	private total: UsageStats | undefined;
	private finalTurn = false;

	/** Scope snapshots for reconciliation, including non-additive session/child detail. */
	get scopedReports(): readonly UsageStats[] {
		return structuredClone([...this.scoped.values()]);
	}

	/**
	 * Explicit accounting path. Returns the captured turn spend, not a delta.
	 * A capture owns one turn when IDs are absent. Equal delta payloads are valid
	 * separate observations; the producer must suppress replay before this port.
	 */
	accumulate(usage: UsageStats): UsageStats | undefined {
		const fact = usage.accounting;
		if (!fact) throw new Error('Scoped usage requires accounting metadata');
		const additive = fact.scope === 'turn' || fact.scope === 'response';
		const key = canonicalJson([
			fact.scope,
			additive
				? null
				: [
						fact.route ?? null,
						fact.scopeId ?? null,
						fact.providerSessionId ?? null,
						fact.processGeneration ?? null,
					],
			fact.scope === 'response' || fact.scope === 'child'
				? (fact.responseId ?? fact.requestId ?? null)
				: null,
		]);
		const previous = this.scoped.get(key);
		if (additive && (this.finalTurn || !this.bindIdentity(fact)))
			return structuredClone(this.total);
		// Finished responses remain in the map as tombstones even after coverage.
		const snapshot = fact.reporting === 'snapshot' ? canonicalJson(usage) : undefined;
		if (
			previous?.accounting?.final ||
			(snapshot !== undefined && this.snapshots.get(key) === snapshot)
		)
			return structuredClone(this.total);
		if (snapshot !== undefined) this.snapshots.set(key, snapshot);
		else this.snapshots.delete(key);
		const next =
			fact.reporting === 'snapshot'
				? replaceUsageStats(previous, usage, fact.scope === 'response')
				: addUsageStats(previous, usage);
		next.accounting = { ...next.accounting!, reporting: fact.reporting, final: fact.final };
		if (
			fact.scope === 'response' &&
			fact.reporting === 'snapshot' &&
			previous &&
			this.coveredResponses.has(key) &&
			!subtractUsageStats(next, previous)
		)
			return structuredClone(this.total);
		this.scoped.set(key, next);
		if (fact.scope === 'process-session') {
			const baseline = this.processBaseline;
			// Missing scope is fine for capture-bound turn events, never for a process baseline.
			if (
				this.finalTurn ||
				!baseline ||
				fact.reporting !== 'snapshot' ||
				!(['route', 'scopeId', 'providerSessionId', 'processGeneration'] as const).every(
					(field) => fact[field] === baseline.accounting![field]
				) ||
				!this.bindIdentity(fact)
			)
				return structuredClone(this.total);
			const attributed = subtractUsageStats(usage, baseline);
			if (!attributed || (this.processSnapshot && !subtractUsageStats(usage, this.processSnapshot)))
				return structuredClone(this.total);
			this.processSnapshot = structuredClone(usage);
			attributed.accounting = {
				...attributed.accounting!,
				...this.identity,
				scope: 'turn',
				reporting: 'snapshot',
				final: false,
			};
			this.coverWithSnapshot(attributed);
		} else if (fact.scope === 'turn') {
			if (fact.reporting === 'snapshot') this.coverWithSnapshot(usage);
			else this.snapshot = addUsageStats(this.snapshot, usage);
			this.finalTurn = fact.final === true;
		} else if (fact.scope === 'response') {
			const covered = this.coveredResponses.get(key);
			const contribution =
				fact.reporting === 'delta'
					? addUsageStats(this.contributions.get(key), usage)
					: covered
						? subtractUsageStats(next, covered)
						: next;
			if (contribution)
				this.contributions.set(
					key,
					replaceUsageStats(this.contributions.get(key), contribution, true)
				);
		} else {
			// Native lifetime and standalone child observations never prove turn ownership.
			return structuredClone(this.total);
		}
		let total = structuredClone(this.snapshot);
		for (const report of this.contributions.values()) {
			total = addUsageStats(total, report);
		}
		if (total?.accounting) {
			Object.assign(total.accounting, this.identity);
			total.accounting.scope = 'turn';
			total.accounting.reporting = 'snapshot';
			total.accounting.final = this.finalTurn;
			delete total.accounting.responseId;
			if (this.identity.requestId === undefined) delete total.accounting.requestId;
			if (!this.finalTurn) {
				total.accounting.completeness = 'partial';
				if (total.accounting.cost.status === 'estimated') {
					total.accounting.estimatedCost = { ...total.accounting.cost, completeness: 'partial' };
				}
				total.accounting.cost = mergeUsageCost(total.accounting.cost, { status: 'unknown' });
				total.totalCostUsd = usageCostUsd(total.accounting.cost) ?? 0;
			}
		}
		this.total = total;
		return structuredClone(total);
	}

	private coverWithSnapshot(usage: UsageStats): void {
		// The producer must deliver causally ordered aggregates covering prior responses.
		this.snapshot = replaceUsageStats(this.total, usage, !usage.accounting?.final);
		for (const [key, response] of this.scoped) {
			if (response.accounting?.scope === 'response') this.coveredResponses.set(key, response);
		}
		this.contributions.clear();
	}

	private bindIdentity(fact: UsageAccounting): boolean {
		const fields = [
			'route',
			'scopeId',
			'providerSessionId',
			'processGeneration',
			'turnId',
		] as const;
		if (
			fields.some(
				(key) =>
					fact[key] !== undefined &&
					this.identity[key] !== undefined &&
					fact[key] !== this.identity[key]
			)
		)
			return false;
		// Response request IDs may identify an internal call, not the prompt request.
		if (
			fact.scope === 'turn' &&
			fact.requestId !== undefined &&
			this.identity.requestId !== undefined &&
			fact.requestId !== this.identity.requestId
		)
			return false;
		for (const key of fields) if (fact[key] !== undefined) this.identity[key] = fact[key];
		if (fact.scope === 'turn' && fact.requestId !== undefined)
			this.identity.requestId = fact.requestId;
		return true;
	}

	constructor(options: UsageAccumulatorOptions) {
		this.attachesAbsoluteUsage = options.attachesAbsoluteUsage;
		this.identity = { ...options.identity };
		this.processBaseline = structuredClone(options.processSessionBaseline);
		if (this.processBaseline) {
			const fact = this.processBaseline.accounting;
			if (
				!fact ||
				fact.scope !== 'process-session' ||
				fact.reporting !== 'snapshot' ||
				fact.completeness !== 'complete' ||
				!(['route', 'scopeId', 'providerSessionId', 'processGeneration'] as const).every(
					(key) => typeof fact[key] === 'string' && fact[key]!.length > 0
				) ||
				!this.bindIdentity({ ...fact, turnId: undefined, requestId: undefined })
			)
				throw new Error('Process usage baseline requires complete, matching scoped identity');
		}
	}

	/**
	 * The most recent raw totals seen, before delta normalization. Exposed
	 * (as a defensive copy) so a caller that needs to mirror this instance's
	 * state onto its own external record - e.g. `ManagedProcess.
	 * lastUsageTotals`, read directly by `plugin-event-listener.ts` - can do
	 * so without this class knowing anything about that consumer.
	 */
	get lastTotals(): UsageTotals | undefined {
		return this._lastTotals ? { ...this._lastTotals } : undefined;
	}

	/** Whether this stream has been determined to report cumulative totals. `undefined` until the second event arrives. */
	get isCumulative(): boolean | undefined {
		return this._isCumulative;
	}

	/**
	 * Normalize one usage event against everything seen so far on this
	 * instance. The first call always returns its input verbatim (there is
	 * nothing to delta against yet, and it is already an absolute snapshot).
	 */
	normalize(usageStats: UsageStats): UsageStats {
		const totals: UsageTotals = {
			inputTokens: usageStats.inputTokens,
			outputTokens: usageStats.outputTokens,
			cacheReadInputTokens: usageStats.cacheReadInputTokens,
			cacheCreationInputTokens: usageStats.cacheCreationInputTokens,
			reasoningTokens: usageStats.reasoningTokens || 0,
		};

		// Once a stream has been found non-cumulative, stop trying to
		// delta-normalize it - a provider does not switch reporting styles
		// mid-stream, and re-attempting would misclassify a legitimate
		// decrease (e.g. a cache eviction) as the reporting style changing.
		if (this._isCumulative === false) {
			this._lastTotals = totals;
			return usageStats;
		}

		const last = this._lastTotals;
		if (!last) {
			this._lastTotals = totals;
			return usageStats;
		}

		const delta: UsageTotals = {
			inputTokens: totals.inputTokens - last.inputTokens,
			outputTokens: totals.outputTokens - last.outputTokens,
			cacheReadInputTokens: totals.cacheReadInputTokens - last.cacheReadInputTokens,
			cacheCreationInputTokens: totals.cacheCreationInputTokens - last.cacheCreationInputTokens,
			reasoningTokens: totals.reasoningTokens - last.reasoningTokens,
		};

		const isMonotonic =
			delta.inputTokens >= 0 &&
			delta.outputTokens >= 0 &&
			delta.cacheReadInputTokens >= 0 &&
			delta.cacheCreationInputTokens >= 0 &&
			delta.reasoningTokens >= 0;

		if (!isMonotonic) {
			this._isCumulative = false;
			this._lastTotals = totals;
			return usageStats;
		}

		this._isCumulative = true;
		this._lastTotals = totals;

		// `...usageStats` first, so an incoming `absoluteUsage` (e.g.
		// Claude Code's parser-attached last-internal-call snapshot, which is
		// NOT this class's business to compute) survives untouched when this
		// provider doesn't attach one of its own below.
		return {
			...usageStats,
			inputTokens: delta.inputTokens,
			outputTokens: delta.outputTokens,
			cacheReadInputTokens: delta.cacheReadInputTokens,
			cacheCreationInputTokens: delta.cacheCreationInputTokens,
			reasoningTokens: delta.reasoningTokens,
			...(this.attachesAbsoluteUsage
				? {
						absoluteUsage: {
							inputTokens: totals.inputTokens,
							outputTokens: totals.outputTokens,
							cacheReadInputTokens: totals.cacheReadInputTokens,
							cacheCreationInputTokens: totals.cacheCreationInputTokens,
							reasoningTokens: totals.reasoningTokens,
						},
					}
				: {}),
		};
	}
}

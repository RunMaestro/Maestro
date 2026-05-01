/**
 * sla-tracker.ts
 *
 * SlaTracker — in-memory tracking of per-stage time-in-stage durations.
 *
 * Usage:
 *   const tracker = new SlaTracker();
 *   tracker.recordEntry('item-001', 'runner-active', Date.now());
 *   // ... time passes ...
 *   const breaches = tracker.findBreaches(Date.now(), config);
 *   tracker.recordExit('item-001', Date.now());
 *
 * Design decisions:
 *   - All state is in-memory.  A consumer that wants durability should persist
 *     duration records to the CCPM mirror and call `hydrate()` on startup.
 *   - An item can accumulate multiple `StageDuration` records if it re-enters a
 *     stage (e.g. via the failure loop).  `recordEntry` always appends.
 *   - `recordExit` closes the MOST RECENT open duration for the item regardless
 *     of stage.  This matches the pipeline engine's single-active-stage model.
 *   - `findBreaches` returns only OPEN durations that exceed the threshold — it
 *     never reports closed durations as breaches.
 *
 * @see sla-types.ts  — StageDuration, SlaConfig, SlaBreach
 */

import type { AnyPipelineStage } from '../../../shared/planning-pipeline-types';
import type { SlaConfig, SlaBreach, StageDuration } from './sla-types';

export class SlaTracker {
	/**
	 * Keyed by workItemId → ordered list of duration records.
	 * The list is append-only; exit timestamps are patched in-place.
	 */
	private readonly records = new Map<string, StageDuration[]>();

	// ---------------------------------------------------------------------------
	// Mutation
	// ---------------------------------------------------------------------------

	/**
	 * Records the moment a work item entered a stage.
	 *
	 * Appends a new open `StageDuration` to the item's history.
	 * If the item has no prior history, a new list is created.
	 */
	recordEntry(workItemId: string, stage: AnyPipelineStage, atMs: number): void {
		const durations = this.getOrCreate(workItemId);
		durations.push({ stage, enteredAt: atMs });
	}

	/**
	 * Closes the most recent open duration for the given work item.
	 *
	 * "Open" means `exitedAt` is undefined.  Scans the list in reverse order
	 * so the most recently appended entry is found first.
	 *
	 * If no open duration exists the call is a no-op (idempotent).
	 */
	recordExit(workItemId: string, atMs: number): void {
		const durations = this.records.get(workItemId);
		if (!durations) {
			return;
		}

		// Walk backwards to find the most recent open entry.
		for (let i = durations.length - 1; i >= 0; i--) {
			const entry = durations[i];
			if (entry.exitedAt === undefined) {
				entry.exitedAt = atMs;
				entry.durationMs = atMs - entry.enteredAt;
				return;
			}
		}
		// No open entry found — no-op.
	}

	// ---------------------------------------------------------------------------
	// Query
	// ---------------------------------------------------------------------------

	/**
	 * Returns all duration records (open and closed) for a work item.
	 *
	 * Returns an empty array for unknown item IDs.
	 */
	getDurations(workItemId: string): StageDuration[] {
		return this.records.get(workItemId) ?? [];
	}

	/**
	 * Finds all open (in-progress) durations that exceed their configured SLA
	 * threshold as of `now`.
	 *
	 * Algorithm:
	 *   For each item in the tracker:
	 *     For each OPEN duration (no exitedAt):
	 *       Compute elapsed = now - enteredAt
	 *       Resolve threshold = thresholdsMs[stage] ?? defaultThresholdMs
	 *       If threshold is defined AND elapsed > threshold → emit SlaBreach
	 *
	 * @param now     Current time in Unix epoch ms (injectable for testing).
	 * @param config  SLA configuration with per-stage and optional default thresholds.
	 * @returns       Array of SlaBreach objects — empty if none exceeded.
	 */
	findBreaches(now: number, config: SlaConfig): SlaBreach[] {
		const breaches: SlaBreach[] = [];

		for (const [workItemId, durations] of this.records) {
			for (const entry of durations) {
				if (entry.exitedAt !== undefined) {
					// Already closed — never a breach.
					continue;
				}

				const threshold = config.thresholdsMs[entry.stage] ?? config.defaultThresholdMs;

				if (threshold === undefined) {
					// No threshold configured for this stage — skip.
					continue;
				}

				const elapsed = now - entry.enteredAt;
				if (elapsed > threshold) {
					breaches.push({
						workItemId,
						stage: entry.stage,
						durationMs: elapsed,
						thresholdMs: threshold,
						enteredAt: entry.enteredAt,
					});
				}
			}
		}

		return breaches;
	}

	/**
	 * Returns the number of work items being tracked.
	 * Useful for testing and diagnostics.
	 */
	get trackedItemCount(): number {
		return this.records.size;
	}

	/**
	 * Removes all records for a work item.
	 *
	 * Call this when an item reaches a terminal stage (e.g. `fork-merged`) to
	 * avoid unbounded memory growth.
	 */
	clear(workItemId: string): void {
		this.records.delete(workItemId);
	}

	// ---------------------------------------------------------------------------
	// Private
	// ---------------------------------------------------------------------------

	private getOrCreate(workItemId: string): StageDuration[] {
		let list = this.records.get(workItemId);
		if (!list) {
			list = [];
			this.records.set(workItemId, list);
		}
		return list;
	}
}

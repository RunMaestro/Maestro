/**
 * Pianola scheduled re-learn job (PURE composition).
 *
 * Runs the learn -> synthesize -> stage pipeline behind injected deps so it is
 * unit-testable with fakes - there is no fs/electron/child_process here. Two
 * invariants this file guarantees:
 *
 *   1. Encore-gated: it re-reads `isEnabled()` and self-disables when off.
 *   2. Proposal-only: it writes ONLY to the suggestions staging file. It never
 *      overwrites the user's live decision profile or rules. The user approves
 *      individual staged items elsewhere.
 *
 * It also asks the supervisor to relaunch any stale supervised target, so a
 * background watcher that died is brought back on the same cadence.
 */

import { synthesizeSuggestions } from '../../shared/pianola/pianola-synthesis';
import type { DecisionPair } from '../../shared/pianola/transcript-mining';
import type { PianolaRule } from '../../shared/pianola/types';
import type { PianolaSuggestionsFile } from '../../shared/pianola/storage';

export interface RelearnDeps {
	/** Whether the `pianola` Encore flag is on. Re-read on every run. */
	isEnabled: () => boolean;
	/** Mine the installed CLIs' transcripts into a labeled decision corpus. */
	mine: () => Promise<DecisionPair[]>;
	/** Read the user's current rules + global decision-profile markdown (live state). */
	readExisting: () => { rules: PianolaRule[]; profile: string };
	/** Persist the staged suggestions. Proposal-only; never the live profile/rules. */
	writeSuggestions: (file: PianolaSuggestionsFile) => void;
	/** Relaunch any enabled supervised target whose child is not alive. Returns count. */
	relaunchStale: () => number;
	/** Epoch ms; injected for deterministic tests. */
	now: () => number;
	/** Structured log sink. */
	log: (line: string) => void;
}

export interface RelearnResult {
	/** Set with a reason when the job did not stage suggestions (feature off, or error). */
	skipped?: string;
	/** True when fresh suggestions were staged this run. */
	wrote: boolean;
	/** How many rule proposals were staged. */
	proposalCount: number;
	/** How many decision pairs were mined. */
	pairCount: number;
	/** How many stale supervised targets were relaunched. */
	relaunched: number;
}

/**
 * One re-learn pass. Encore-gated and proposal-only. Mining, synthesis, staging,
 * and the relaunch are wrapped so any failure logs and returns `wrote: false`
 * rather than throwing out of the job - a failed run must never crash the
 * scheduler loop, and a failed mine leaves the previously staged suggestions
 * untouched instead of clobbering them with an empty set.
 */
export async function runRelearnJob(deps: RelearnDeps): Promise<RelearnResult> {
	if (!deps.isEnabled()) {
		return {
			skipped: 'pianola disabled',
			wrote: false,
			proposalCount: 0,
			pairCount: 0,
			relaunched: 0,
		};
	}

	try {
		const pairs = await deps.mine();
		const { rules, profile } = deps.readExisting();
		const { proposals, profileDiff } = synthesizeSuggestions({
			pairs,
			existingRules: rules,
			existingProfile: profile,
			now: deps.now(),
		});
		deps.writeSuggestions({
			generatedAt: deps.now(),
			pairCount: pairs.length,
			proposals,
			proposedProfile: profileDiff.after,
			previousProfile: profileDiff.before,
		});
		const relaunched = deps.relaunchStale();
		deps.log(
			`staged ${proposals.length} proposal(s) from ${pairs.length} pair(s); relaunched ${relaunched} stale target(s)`
		);
		return {
			wrote: true,
			proposalCount: proposals.length,
			pairCount: pairs.length,
			relaunched,
		};
	} catch (err) {
		deps.log(`re-learn job failed: ${err instanceof Error ? err.message : String(err)}`);
		return { skipped: 'error', wrote: false, proposalCount: 0, pairCount: 0, relaunched: 0 };
	}
}

import { canonicalJson } from '../canonicalJson';
/**
 * Stable identity key for "subscriptions that represent one visual trigger."
 *
 * The pipeline-editor serializer emits fan-out to mixed or command targets as
 * multiple parallel subscriptions that each re-carry the full trigger event
 * config. Three places need the same notion of "same trigger" and must agree:
 *
 *  - `yamlToPipeline.ts` collapses matching subs onto one trigger node on load.
 *  - `cue-engine.ts` fires every sibling sub when the user clicks Play, so a
 *    manual run matches what a scheduled tick would do.
 *  - `SessionsTable.tsx` picks one representative per group for Run Now.
 *
 * They previously carried three hand-mirrored copies of this function, and the
 * two runtime copies had already drifted from the editor's (missing the
 * re-trigger fields), which let a manual Play fire subs a real tick would not
 * have grouped. One implementation, imported everywhere, removes that class of
 * bug: any divergence in event-specific config still yields a distinct key, so
 * genuinely independent triggers stay independent.
 */

import type { CueSubscription } from './contracts';

export function triggerGroupKey(sub: CueSubscription): string {
	// Sort filter keys so two subs whose filter objects differ only in key
	// insertion order (hand-written YAML or library-reordered round-trips)
	// still collapse to the same visual trigger.
	const filter = sub.filter
		? Object.keys(sub.filter)
				.sort()
				.reduce<Record<string, unknown>>((acc, k) => {
					acc[k] = (sub.filter as Record<string, unknown>)[k];
					return acc;
				}, {})
		: null;
	return canonicalJson({
		event: sub.event,
		plugin: sub.plugin ?? null,
		schedule_times: sub.schedule_times ?? null,
		schedule_days: sub.schedule_days ?? null,
		interval_minutes: sub.interval_minutes ?? null,
		// `time.once` timing. Two one-shots with the same label but different
		// instants are independent triggers and must not collapse onto one
		// node; the matched `-prompt` / `-notify` pair a scheduled task emits
		// shares one instant and correctly stays a single visual trigger.
		fire_at: sub.fire_at ?? null,
		watch: sub.watch ?? null,
		repo: sub.repo ?? null,
		poll_minutes: sub.poll_minutes ?? null,
		gh_state: sub.gh_state ?? null,
		gh_label_target: sub.gh_label_target ?? null,
		gh_labels: sub.gh_labels ?? null,
		retrigger_on_comments: sub.retrigger_on_comments ?? null,
		max_notifications: sub.max_notifications ?? null,
		// Without the webhook block, two `webhook.received` subs on different
		// paths (or different secrets) collapse into one visual trigger, and the
		// next save rewrites both to whichever config won - silently breaking a
		// working endpoint.
		webhook_path: sub.webhook?.path ?? null,
		webhook_secret: sub.webhook?.secret ?? null,
		webhook_secret_env: sub.webhook?.secret_env ?? null,
		webhook_signature_header: sub.webhook?.signature_header ?? null,
		label: sub.label ?? null,
		filter,
		// Two subs that differ only in their gate are different triggers: one
		// fires on every event and the other on the events its condition
		// admits. Collapsing them would let the next save rewrite both to
		// whichever gate won, and would make Play fire a sub a real event
		// would have gated.
		gate: sub.gate ?? null,
		gate_on_unavailable: sub.gate_on_unavailable ?? null,
		// The same reasoning as the gate: two subs that differ in whether
		// their untrusted text is screened, or at what score, are not one
		// trigger. Collapsing them would let the next save turn a screen off
		// on the branch that asked for it.
		screen_injection: sub.screen_injection ?? null,
		injection_threshold: sub.injection_threshold ?? null,
	});
}

/**
 * Whether `candidate` is the same visual trigger as `anchor`: the anchor
 * itself, or a sibling subscription of the same pipeline that carries the same
 * trigger config.
 *
 * Two anchors have no siblings and match only themselves. A chain step
 * (`agent.completed`) is fed by an upstream agent, not by a trigger node, and
 * a subscription without a `pipeline_name` predates grouping, so widening
 * either would act on subscriptions the caller never named.
 *
 * Anything that acts on "the trigger the user named" rides this: Play fires
 * every member so a manual run matches a real tick, and a gate set from the
 * CLI lands on every member, as it does when it is set on the trigger node in
 * the editor.
 */
export function isSameTriggerGroup(anchor: CueSubscription, candidate: CueSubscription): boolean {
	if (candidate === anchor) return true;
	if (anchor.event === 'agent.completed' || !anchor.pipeline_name) return false;
	return (
		candidate.pipeline_name === anchor.pipeline_name &&
		candidate.event !== 'agent.completed' &&
		triggerGroupKey(candidate) === triggerGroupKey(anchor)
	);
}

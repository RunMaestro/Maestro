/**
 * A Cappella readiness - the shapes the capability gate produces.
 *
 * These live in `shared/` because readiness travels: the HUD reads it to decide
 * whether the microphone button is even pressable, the hotkey handler reads it
 * before opening a session, and Voice Setup reads it to say WHY a slot is not
 * ready. One structure, one source of truth, no surface re-deriving "is voice
 * usable" from a different set of facts.
 *
 * The resolver itself is main-process only (`src/main/acappella/models/
 * capability-gate.ts`) because deciding readiness means touching disk.
 */

import type { VoiceProviderRole } from './providers';

/** The four slots that have to be satisfied. The wake word is not a provider role. */
export type VoiceSlot = VoiceProviderRole | 'wake-word';

/**
 * Why a slot is not satisfied. Closed on purpose: a reason with no matching
 * suggested action is a dead end in front of the user, so adding one here means
 * adding its recovery too.
 */
export type VoiceSlotUnsatisfiedReason =
	| 'model-not-installed'
	| 'model-corrupt'
	| 'api-key-missing'
	| 'provider-unreachable';

export interface VoiceSlotReadiness {
	slot: VoiceSlot;
	/** The provider id this slot is configured to use. */
	providerId: string;
	satisfied: boolean;
	/** Absent when `satisfied`. */
	reason?: VoiceSlotUnsatisfiedReason;
	/** One sentence naming the missing piece. Absent when `satisfied`. */
	detail?: string;
	/** What the user can do about it. Absent when `satisfied`. */
	suggestedAction?: string;
	/** The catalog model this slot needs, when it needs one. */
	requiredModelId?: string;
}

export interface VoiceReadiness {
	/**
	 * Whether a voice session may start at all. False when speech in, speech out,
	 * or routing cannot run. The wake word deliberately does NOT gate this: a
	 * click-to-talk session is perfectly usable without one.
	 */
	canStartSession: boolean;
	/** Whether the always-on wake word can run, which is what hands-free means. */
	canRunHandsFree: boolean;
	slots: VoiceSlotReadiness[];
	/**
	 * The slots blocking a session, in slot order. Empty when
	 * `canStartSession` is true.
	 */
	blocking: VoiceSlotReadiness[];
}

/**
 * The `session-error` message for a failed readiness check.
 *
 * Every blocking slot is named with its recovery, because the user's next action
 * is the only thing this message is for. Lives here rather than beside the
 * resolver so the session service can format a refusal without importing the
 * disk-touching half of the gate.
 */
export function readinessErrorMessage(readiness: VoiceReadiness): string {
	if (readiness.canStartSession) return '';
	return readiness.blocking
		.map((slot) => [slot.detail ?? slot.slot, slot.suggestedAction].filter(Boolean).join(' '))
		.join(' ');
}

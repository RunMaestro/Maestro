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

import type { MicPermission } from './protocol';
import type { VoiceProviderRole } from './providers';

/**
 * Every slot that has to be satisfied.
 *
 * The wake word is not a provider role, and the microphone is not a provider at
 * all: it is the OS permission, which is independent of every model on disk. It
 * is a slot here so that "microphone access denied" travels through the same
 * structure as everything else and reaches the user as its own sentence, rather
 * than being folded into a generic "voice unavailable".
 */
export type VoiceSlot = VoiceProviderRole | 'wake-word' | 'microphone';

/**
 * Why a slot is not satisfied. Closed on purpose: a reason with no matching
 * suggested action is a dead end in front of the user, so adding one here means
 * adding its recovery too.
 *
 * An array rather than a bare union so the gate's test can assert it produces
 * every one of them. "Adding a reason means adding its recovery" is only a rule
 * if something checks; a union alone is invisible at runtime, so a new reason
 * shipped without a `suggestedAction` would reach a user as a disabled button
 * with nothing beside it and no test would have noticed.
 */
export const VOICE_SLOT_UNSATISFIED_REASONS = [
	'model-not-installed',
	'model-corrupt',
	'api-key-missing',
	'provider-unreachable',
	'runtime-unavailable',
	'mic-permission-denied',
	'mic-permission-restricted',
] as const;

export type VoiceSlotUnsatisfiedReason = (typeof VOICE_SLOT_UNSATISFIED_REASONS)[number];

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
	/**
	 * The microphone permission as the OS reports it. Present only on the
	 * microphone slot, and present even when satisfied: "granted" is worth
	 * rendering, and `not-determined` is the state Voice Setup should describe as
	 * "you will be asked when you start" rather than as a problem.
	 */
	micPermission?: MicPermission;
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

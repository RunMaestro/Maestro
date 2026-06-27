/**
 * Plugin cue-trigger dispatch gate (pure, bundle-safe).
 *
 * A plugin can declare a `cueTrigger` with `action: 'dispatch'` - it wants to
 * send a prompt to an agent on a schedule. Letting a plugin auto-fire prompts is
 * `agents:dispatch`-grade authority, so it runs through the same risk engine
 * Pianola uses: a HIGH-risk prompt is NEVER eligible for auto-dispatch (it is
 * surfaced to the user instead). Low/medium prompts are eligible, but actually
 * sending them still requires an explicit, separately-wired dispatch path
 * (auto-execution to an agent stays gated behind the Phase-3 sandbox decision,
 * exactly like the inert `agents:dispatch` host method). The scheduler uses this
 * verdict to decide between auto-dispatching (only when a real dispatch sink is
 * wired AND the prompt is eligible) and surfacing the intent to the user.
 *
 * Kept pure (no Electron, no fs) so the gate is unit-testable in isolation.
 */
import { rateRisk } from '../pianola/pianola-risk';
import type { PianolaRisk } from '../pianola/types';

export interface PluginDispatchVerdict {
	/** True when the prompt is risk-eligible for auto-dispatch (not high-risk). */
	eligible: boolean;
	/** The rated risk of the prompt text. */
	risk: PianolaRisk;
	/** Human-readable reason, for the audit log and the user-facing surface. */
	reason: string;
}

/**
 * Rate a plugin dispatch payload and decide whether it is eligible for
 * auto-dispatch. HIGH-risk is never eligible; the caller surfaces it to the user.
 */
export function evaluatePluginDispatch(payload: string): PluginDispatchVerdict {
	const text = typeof payload === 'string' ? payload : '';
	const risk = rateRisk(text);
	if (risk === 'high') {
		return {
			eligible: false,
			risk,
			reason: 'high-risk prompt: auto-dispatch blocked, surfaced for review',
		};
	}
	return { eligible: true, risk, reason: `risk ${risk}: eligible for dispatch` };
}

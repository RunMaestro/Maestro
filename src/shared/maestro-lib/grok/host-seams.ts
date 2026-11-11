/**
 * The small host seams the Grok ACP route needs.
 *
 * The Grok work was first built against a host line that carried its own
 * effect-authority, hashing and route-support modules. Upstream has none of
 * them, so the two things the Grok code actually reads live here instead:
 *
 *   - `sha256Hex`, the digest a native command catalog entry is bound by, and
 *     `grokInstallationId`, the host identity a native session is bound to;
 *   - the effect-decision port the ACP request adapter asks before it selects
 *     a permission option. It fails closed: nothing but `allow` grants, and a
 *     missing authority, a missing binding, a thrown or late answer each refuse.
 *
 * Keep this file small. It is a port definition, not a policy engine: the
 * only authority composed today is the desktop person's consent through the
 * permission relay (`grokConsentAuthority` in `GrokAcpSpawner`).
 */

import { createHash } from 'crypto';

/** SHA-256 of `data` (a string is hashed as UTF-8), as 64 lowercase hex characters. */
export function sha256Hex(data: string | Uint8Array): string {
	return createHash('sha256').update(data).digest('hex');
}

/**
 * The installation a Grok native session is bound to: a label for this machine and its production
 * data directory, never a process epoch or a config alias. The desktop and the headless runtime
 * compute it the same way, so a session one of them started is resumable from the other.
 */
export function grokInstallationId(input: { hostname: string; productionDataDir: string }): string {
	return sha256Hex(`${input.hostname}\n${input.productionDataDir}`).slice(0, 32);
}

/** One effect a Grok process asks the host to approve. ACP produces permission requests only. */
export type GrokEffect = { kind: 'permissions'; permissions: Readonly<Record<string, unknown>> };

/** Who the host acts for when it answers an effect. */
export interface GrokEffectActor {
	kind: 'human' | 'service' | 'agent';
	id: string;
}

/** What one effect is joined to: the host's grant for the turn and the provider's own IDs. */
export interface GrokEffectBinding {
	/** The host's grant for this turn (the consent session it was opened under). */
	leaseId: string;
	actor: GrokEffectActor;
	provider: string;
	/** The provider's own conversation and turn identifiers, when it has them. */
	threadId: string | null;
	turnId: string | null;
	/** The provider's id for this one request, so the answer joins to it. */
	requestId: string;
}

/** The host's answer. Only `allow` grants; `deny` and `unavailable` both refuse. */
export type GrokEffectDecision =
	| { decision: 'allow' }
	| { decision: 'deny'; reason: string }
	| { decision: 'unavailable'; reason: string };

/** The answer an adapter records: a decision, or `unknown` when the authority failed to give one. */
export type GrokEffectVerdict = GrokEffectDecision['decision'] | 'unknown';

/** The host port the ACP request adapter asks once per permission request. */
export interface GrokEffectAuthority {
	readonly authorityId: string;
	decide(
		effect: GrokEffect,
		binding: GrokEffectBinding,
		signal: AbortSignal
	): GrokEffectDecision | Promise<GrokEffectDecision>;
}

/** Whether a decision grants the effect. Nothing but `allow` does, including a missing one. */
export function grokEffectGranted(decision: GrokEffectDecision | null | undefined): boolean {
	return decision?.decision === 'allow';
}
